import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { crossCheckSites, loadStudyPack, siteVerdict } from '@/lib/network/aggregator'
import { buildMarkdownReport, buildRegulatoryExport, listResultTables } from './regulatory'
import type { StudyConfig } from '@/types/studypack'

const samples = path.resolve(__dirname, '../../../samples')

describe('network demo end-to-end', () => {
  it('adopts the clean sites and exports a verifiable submission package', async () => {
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const paths = [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)]
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, paths)
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
    })
    expect(rows.filter((r) => r.adopted).map((r) => r.site.siteId).sort()).toEqual(['Site_A', 'Site_B'])

    const report = buildMarkdownReport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, generatedAt: 'now' })
    expect(report).toContain('| Site_C |')
    expect(report).toContain('(protected section)')

    const tables = listResultTables(rows.filter((r) => r.adopted).map((r) => r.site))
    expect(tables.map((t) => t.key)).toContain('CohortMethodModule/cm_result')
    expect(tables.find((t) => t.key === 'CohortMethodModule/cm_result')).toMatchObject({ sites: 2, rows: 4 })

    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows })
    expect(XMLValidator.validate(out.defineXml)).toBe(true)
    expect(Object.keys(out.datasets).sort()).toEqual([
      'datasets/cd_cohort_count.json',
      'datasets/cg_cohort_count.json',
      'datasets/cm_diagnostics_summary.json',
      'datasets/cm_result.json',
      'datasets/database_meta_data.json',
      'datasets/sccs_result.json',
    ])
    const cm = JSON.parse(out.datasets['datasets/cm_result.json'])
    expect(new Set(cm.rows.map((r: unknown[]) => r[0]))).toEqual(new Set(['Site_A', 'Site_B']))
    // HADES-censored counts stay numeric (-5), so the column stays an integer.
    expect(cm.columns.find((c: { name: string }) => c.name === 'TARGET_OUTCOMES').dataType).toBe('integer')
    expect(out.markdown).toContain('Define-XML v2.1 / Dataset-JSON v1.1')

    const zip = await JSZip.loadAsync(await out.zipBlob.arrayBuffer())
    expect(Object.keys(zip.files)).toContain('ACEI_ANGIO_2026-submission/define.xml')
    expect((await loadStudyPack(out.zipName, await out.zipBlob.arrayBuffer())).integrity.status).toBe('verified')

    const subset = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, tables: ['CohortMethodModule/cm_result'], defineXmlVersion: '2.0', datasetJsonVersion: '1.0' })
    expect(Object.keys(subset.datasets)).toEqual(['datasets/cm_result.json'])
    expect(subset.defineXml).toContain('ns/def/v2.0')
    expect(JSON.parse(subset.datasets['datasets/cm_result.json']).datasetJSONVersion).toBe('1.0.0')
  })
})

describe('disposition audit trail in the submission', () => {
  it('records decisions with reasons and ships the chained log with the package', async () => {
    const { DispositionLog } = await import('@/lib/network/dispositionLog')
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const log = new DispositionLog()
    const actor = { name: 'Coordinator', role: 'coordinator', organization: 'Net' }
    const rows = []
    for (const s of sites) {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      await log.append({ actor, action: 'received', siteId: s.siteId, packSha256: s.zipSha256 })
      await log.append({ actor, action: verdict.recommended, siteId: s.siteId, packSha256: s.zipSha256, from: 'undecided', to: verdict.recommended, recommended: verdict.recommended, reasonCode: verdict.recommended === 'exclude' ? verdict.codes[0] : undefined })
      rows.push({ site: s, verdict, decision: verdict.recommended, adopted: verdict.recommended === 'adopt' })
    }
    await log.append({ actor, action: 'lock', reasonText: 'attested' })
    const excludedC = log.entries.find((e) => e.siteId === 'Site_C' && e.action === 'exclude')!
    expect(excludedC.reasonCode).toBe('INTEGRITY')
    expect(log.entries.find((e) => e.siteId === 'Site_D' && e.action === 'exclude')!.reasonCode).toBe('PROTOCOL_DEVIATION')

    const head = log.headBytes(config.studyId)
    const out = await buildRegulatoryExport({
      studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows,
      disposition: { entries: log.entries, jsonl: log.toJsonl(), headHash: log.headHash, head },
    })
    expect(out.markdown).toContain('## 4. Site disposition')
    expect(out.markdown).toMatch(/Dispositions locked:\*\* yes — by Coordinator/)
    expect(out.markdown).toContain('| Site_C |')
    expect(out.markdown).toContain('## Limitations')
    const zip = await JSZip.loadAsync(await out.zipBlob.arrayBuffer())
    const names = Object.keys(zip.files)
    const jsonl = await zip.file(names.find((n) => n.endsWith('disposition/disposition_log.jsonl'))!)!.async('string')
    const restored = await DispositionLog.fromJsonl(jsonl, JSON.parse(await zip.file(names.find((n) => n.endsWith('disposition_head.json'))!)!.async('string')))
    expect(restored.headHash).toBe(log.headHash)
    expect(names.some((n) => n.endsWith('sites/Site_A/audit_report.json'))).toBe(true)
  })
})
