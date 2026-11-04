import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { buildStudyPack, type PackInputFile } from '@/lib/studypack/builder'
import { auditResultFiles } from '@/lib/strategus/results'
import type { StudyConfig } from '@/types/studypack'
import { crossCheckSites, loadStudyPack, siteVerdict, validateManifest, type LoadedSitePack } from './aggregator'

const samples = path.resolve(__dirname, '../../../samples')
const enc = new TextEncoder()
const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
const network = async () => {
  const dir = path.join(samples, 'network')
  const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
  return Object.fromEntries(sites.map((s) => [s.siteId, s])) as Record<string, LoadedSitePack>
}

async function pack(siteId: string, spec = '{"attr_class":"AnalysisSpecifications"}', script = 'x <- 1\n# DO NOT MODIFY BELOW THIS POINT\nStrategus::execute()\n') {
  const cg = 'database_id,cohort_id,cohort_subjects\nX,1,120\n'
  const results = [{ path: 'CohortGeneratorModule/cg_cohort_count.csv', bytes: enc.encode(cg) }]
  const audits = auditResultFiles(results, { minCellCount: 5 })
  const files: PackInputFile[] = [
    { path: 'definitions/analysisSpecifications.json', role: 'definition', originalName: 's', bytes: enc.encode(spec) },
    { path: 'code/ExecuteAnalyses.R', role: 'code', originalName: 'e', bytes: enc.encode(script) },
    { path: 'code/renv.lock', role: 'code', originalName: 'r', bytes: enc.encode('{}') },
    { path: 'evidence/dqd_results.json', role: 'evidence', originalName: 'd', bytes: enc.encode('{"Overview":{"countTotal":10,"countPassed":9,"percentPassed":90}}') },
    ...results.map((r) => ({ path: `results/${r.path}`, role: 'result' as const, originalName: r.path, bytes: r.bytes, audit: audits.get(r.path) })),
  ]
  const p = await buildStudyPack({ studyId: 'S1', siteId, cdmVersion: '5.4', minCellCount: 5, files })
  return { p, bytes: new Uint8Array(await p.zipBlob.arrayBuffer()) }
}

describe('StudyPack build + verification', () => {
  it('produces a schema-valid manifest that verifies, and re-audits results', async () => {
    const { p, bytes } = await pack('Site_A')
    expect(p.zipName).toBe('Site_A_S1.studypack.zip')
    expect(validateManifest(p.manifest)).toEqual([])
    expect(p.manifest.files.map((f) => f.path)).toEqual(expect.arrayContaining(['ro-crate-metadata.json', 'audit_report.json', 'results/CohortGeneratorModule/cg_cohort_count.csv']))
    const site = await loadStudyPack(p.zipName, bytes)
    expect(site.rootDir).toBe('S1-pack/')
    expect(site.integrity.status).toBe('verified')
    expect(site.dqd?.percentPassed).toBe(90)
    expect(site.reAudit).toMatchObject({ passed: true, files: 1 })
  })

  it('detects tampering, unlisted and missing files', async () => {
    const { bytes } = await pack('Site_B')
    const zip = await JSZip.loadAsync(bytes)
    zip.file('S1-pack/results/CohortGeneratorModule/cg_cohort_count.csv', 'database_id,cohort_id,cohort_subjects\nX,1,3\n')
    zip.file('S1-pack/extra.txt', 'x')
    zip.remove('S1-pack/code/renv.lock')
    const site = await loadStudyPack('b.zip', await zip.generateAsync({ type: 'uint8array' }))
    expect(site.integrity.status).toBe('tampered')
    expect(site.integrity.mismatched.map((m) => m.path)).toEqual(['results/CohortGeneratorModule/cg_cohort_count.csv'])
    expect(site.integrity.unlisted).toEqual(['extra.txt'])
    expect(site.integrity.missing).toEqual(['code/renv.lock'])
    expect(site.reAudit?.passed).toBe(false)
  })

  it('rejects non-zip input', async () => {
    expect((await loadStudyPack('x.zip', enc.encode('not a zip'))).integrity.status).toBe('invalid')
  })
})

describe('cross-site verification (demo network)', () => {
  it('matches sites with different INPUTS blocks and flags tampering and protected-section edits', async () => {
    const s = await network()
    const all = Object.values(s)
    const cross = crossCheckSites(all, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    expect(cross.references['code/ExecuteAnalyses.R']).toMatchObject({ source: 'protocol', kind: 'section' })
    // Site_A and Site_B typed different schemas / database names but share the protected section.
    expect(s.Site_A.fileHashes['code/ExecuteAnalyses.R']).not.toBe(s.Site_B.fileHashes['code/ExecuteAnalyses.R'])
    expect(siteVerdict(s.Site_A, cross, config.studyId, all).recommended).toBe('adopt')
    expect(siteVerdict(s.Site_B, cross, config.studyId, all).recommended).toBe('adopt')
    expect(siteVerdict(s.Site_C, cross, config.studyId, all).reasons.join()).toContain('Tampering')
    expect(siteVerdict(s.Site_D, cross, config.studyId, all).reasons.join()).toContain('ExecuteAnalyses.R protected section mismatch')
  })

  it('without a protocol, uses majority hashes (section-based for the execution script)', async () => {
    const s = await network()
    const all = Object.values(s)
    const cross = crossCheckSites(all)
    expect(cross.references['code/ExecuteAnalyses.R']).toMatchObject({ source: 'majority', kind: 'section' })
    expect(cross.perSite[s.Site_D.key]['code/ExecuteAnalyses.R'].status).toBe('mismatch')
    expect(cross.perSite[s.Site_B.key]['code/ExecuteAnalyses.R'].status).toBe('match')
  })

  it('compares whole files when the protocol pins the script without a marker', async () => {
    const a = await loadStudyPack('a', (await pack('A', undefined, 'Strategus::execute()\n')).bytes)
    const b = await loadStudyPack('b', (await pack('B', undefined, 'Strategus::execute() # edited\n')).bytes)
    const cross = crossCheckSites([a, b], { 'code/ExecuteAnalyses.R': a.fileHashes['code/ExecuteAnalyses.R'] }, {})
    expect(cross.references['code/ExecuteAnalyses.R'].kind).toBe('file')
    expect(cross.perSite[a.key]['code/ExecuteAnalyses.R'].status).toBe('match')
    expect(cross.perSite[b.key]['code/ExecuteAnalyses.R'].status).toBe('mismatch')
  })

  it('flags duplicate site ids and has no reference on a tie', async () => {
    const a1 = await loadStudyPack('a1', (await pack('A')).bytes)
    const a2 = await loadStudyPack('a2', (await pack('A', '{"attr_class":"AnalysisSpecifications","x":1}')).bytes)
    const cross = crossCheckSites([a1, a2])
    expect(cross.references['definitions/analysisSpecifications.json'].source).toBe('none')
    expect(siteVerdict(a1, cross, undefined, [a1, a2]).reasons.join()).toContain('Duplicate Site ID')
  })
})
