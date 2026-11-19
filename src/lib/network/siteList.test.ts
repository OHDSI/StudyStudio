import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossCheckSites, loadStudyPack, siteVerdict, siteListMismatches } from '@/lib/network/aggregator'
import { DispositionError, DispositionLog, unaccountedSites } from '@/lib/network/dispositionLog'
import { buildRegulatoryExport } from '@/lib/export/regulatory'
import { issueProtocol, issueRefusals, locateStudyRepo, parseSiteList, unzipRepo } from '@/lib/strategus/protocol'
import type { StudyConfig } from '@/types/studypack'

const samples = path.resolve(__dirname, '../../../samples')
const actor = { name: 'Coordinator', role: 'coordinator', organization: 'Net' }

async function standardNetwork(extra: Partial<StudyConfig> = {}) {
  const config = { ...(JSON.parse(readFileSync(path.join(samples, 'standard/protocol/study_config.json'), 'utf8')) as StudyConfig), ...extra }
  const dir = path.join(samples, 'standard/packs')
  const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
  const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
  return { config, sites, cross }
}

describe('C2: the protocol lists the participating sites', () => {
  const repo = async () => locateStudyRepo(await unzipRepo(readFileSync(path.join(samples, 'study-repo.zip'))))
  const meta = { studyId: 'S', studyTitle: 'T', cdmVersion: '5.4', minCellCount: 5 }

  it('is required at issue for a regulatory protocol, and optional (absent from the config) for a standard one', async () => {
    expect(issueRefusals({ assurance: 'regulatory' })).toEqual([expect.stringMatching(/Regulatory protocols must list the participating sites/)])
    await expect(issueProtocol(await repo(), { ...meta, assurance: 'regulatory' })).rejects.toThrow(/must list the participating sites/)
    const std = await issueProtocol(await repo(), meta)
    expect(std.config).not.toHaveProperty('sites')
    expect(new TextDecoder().decode(std.configBytes)).not.toContain('"sites"')
    const reg = await issueProtocol(await repo(), { ...meta, assurance: 'regulatory', sites: parseSiteList('Site_A, treated, Site A EHR, 2026-09-30\nSite_B , external-comparator\n\n') })
    expect(reg.config.sites).toEqual([
      { siteId: 'Site_A', role: 'treated', cdmSourceName: 'Site A EHR', sourceReleaseDate: '2026-09-30' },
      { siteId: 'Site_B', role: 'external-comparator' },
    ])
  })

  it('refuses duplicate site IDs and malformed release dates at issue', () => {
    expect(issueRefusals({ sites: [{ siteId: 'A' }, { siteId: 'A' }] })).toEqual(['Site ID listed more than once: A'])
    expect(issueRefusals({ sites: [{ siteId: 'A', sourceReleaseDate: '30/09/2026' }] })).toEqual(['A: source release date must be YYYY-MM-DD'])
  })

  it('compares each pack with its entry: an exclusion in a regulatory study, a warning otherwise', async () => {
    const { config, sites, cross } = await standardNetwork()
    const a = sites.find((s) => s.siteId === 'Site_A')!
    expect(siteListMismatches(a, config)).toEqual([])
    const listed = { ...config, sites: [{ siteId: 'Site_A', cdmSourceName: 'Some other source', sourceReleaseDate: '1999-01-01' }] }
    const m = siteListMismatches(a, listed)
    expect(m).toHaveLength(2)
    expect(m[0]).toMatch(/the protocol's site list expects "Some other source"/)
    expect(siteListMismatches(sites.find((s) => s.siteId === 'Site_B')!, listed)).toEqual(["Site Site_B is not in the protocol's site list"])

    const std = siteVerdict(a, cross, config.studyId, sites, { config: listed })
    expect(std.recommended).toBe('adopt')
    expect(std.warnings).toHaveLength(2)
    const reg = siteVerdict(a, cross, config.studyId, sites, { config: { ...listed, assurance: 'regulatory' } })
    expect(reg.codes).toContain('CDM_REQUIREMENT')
    // No list: nothing changes.
    expect(siteVerdict(a, cross, config.studyId, sites, { config })).not.toHaveProperty('warnings')
  })
})

describe('A1: sites in the list that sent no pack', () => {
  it('records not-received with a reason and text, and no pack', async () => {
    const log = new DispositionLog()
    await expect(log.append({ actor, action: 'not-received', siteId: 'Site_E', reasonCode: 'NOT_RECEIVED' })).rejects.toThrow(DispositionError)
    await expect(log.append({ actor, action: 'not-received', siteId: 'Site_E', reasonCode: 'NOT_RECEIVED', reasonText: 'x', packSha256: 'a'.repeat(64) })).rejects.toThrow(/refers to no pack/)
    await expect(log.append({ actor, action: 'not-received', siteId: 'Site_E', reasonCode: 'NOPE', reasonText: 'x' })).rejects.toThrow(/not pre-specified/)
    await log.append({ actor, action: 'not-received', siteId: 'Site_E', reasonCode: 'NOT_RECEIVED', reasonText: 'Site closed its research office' })
    expect(log.notReceived().get('Site_E')?.reasonText).toBe('Site closed its research office')
    const restored = await DispositionLog.fromJsonl(log.toJsonl())
    expect(restored.notReceived().has('Site_E')).toBe(true)
  })

  it('makes a regulatory export account for every listed site; reports list the not-received sites', async () => {
    const extra = { sites: ['Site_A', 'Site_B', 'Site_C', 'Site_D', 'Site_E'].map((siteId, i) => ({ siteId, ...(i === 4 ? { role: 'external-comparator' } : {}) })) }
    const { config, sites, cross } = await standardNetwork(extra)
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites, { config })
      return { site: s, verdict, decision: verdict.recommended, adopted: verdict.recommended === 'adopt' }
    })
    const decided = async (notReceived?: string) => {
      const log = new DispositionLog()
      for (const r of rows)
        await log.append({ actor, action: r.verdict.recommended, siteId: r.site.siteId, packSha256: r.site.zipSha256, from: 'undecided', to: r.verdict.recommended, recommended: r.verdict.recommended, reasonCode: r.verdict.recommended === 'exclude' ? r.verdict.codes[0] : undefined })
      if (notReceived) await log.append({ actor, action: 'not-received', siteId: 'Site_E', reasonCode: 'NOT_RECEIVED', reasonText: notReceived })
      expect(unaccountedSites(config.sites, sites, log.entries)).toEqual(notReceived ? [] : ['Site_E'])
      await log.append({ actor, action: 'lock', reasonText: 'attested' })
      return { entries: log.entries, jsonl: log.toJsonl(), headHash: log.headHash, head: log.headBytes(config.studyId) }
    }
    const reg = { ...config, assurance: 'regulatory' as const }
    await expect(buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: reg, cross, rows, disposition: await decided() })).rejects.toThrow(/not-received entry for Site_E/)
    // A standard study is not held to it.
    await expect(buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, disposition: await decided() })).resolves.toBeDefined()

    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: reg, cross, rows, disposition: await decided('Withdrew before the run') })
    expect(out.markdown).toContain("**Sites in the protocol's site list:** 5 listed; 1 without a pack (Site_E: recorded as not received)")
    expect(out.markdown).toMatch(/\| Site_E \| `—` \| — \| \*\*not received\*\* \| NOT_RECEIVED \| Withdrew before the run \|/)
    expect(out.reviewersGuide.markdown).toContain('| Site | Disposition | Role | CDM source | CDM version | Vocabulary version | Source release | Data cut-off | Reason |')
    expect(out.reviewersGuide.markdown).toContain('| Site_E | not received | external-comparator | — | — | — | — | — | NOT_RECEIVED: Withdrew before the run |')
  })
})

describe('A3: source release and data cut-off are shown', () => {
  it('adds both columns to the audit report section 5 and the reviewer\'s guide site table', async () => {
    const { config, sites, cross } = await standardNetwork()
    const { evaluateEvidence } = await import('@/lib/studypack/evidence')
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      return { site: s, verdict, adopted: verdict.recommended === 'adopt', evidence: evaluateEvidence({ config, files: s.files }) }
    })
    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows })
    expect(out.markdown).toContain('| Site | Signatures | DQD gate (block/warn) | CDM / vocabulary | Source release | Data cut-off | Log errors |')
    expect(out.html).toContain('<th>Source release</th><th>Data cut-off</th>')
    const cs = rows.find((r) => r.site.siteId === 'Site_A')!.evidence.provenance.cdmSource!
    expect(cs.maxObservationPeriodEndDate).toBeTruthy()
    expect(out.markdown).toContain(`| ${cs.sourceReleaseDate ?? '—'} | ${cs.maxObservationPeriodEndDate} |`)
    // Without a site list the guide has no Role column.
    expect(out.reviewersGuide.markdown).toContain('| Site | Disposition | CDM source | CDM version | Vocabulary version | Source release | Data cut-off | Reason |')
  })
})
