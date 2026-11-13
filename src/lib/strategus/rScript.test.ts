/** R script studies: a single script (e.g. CodeToRun.R) writing aggregated CSVs, pinned and verified without Strategus. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { issueProtocol, locateStudyRepo, readProtocolFile } from './protocol'
import { commentLines, PROTECTED_MARKER, protectedSectionHash, suggestMarker } from './executeScript'
import { crossCheckSites, loadStudyPack, protocolKeyPaths, siteVerdict } from '@/lib/network/aggregator'
import { mergeSiteResults } from '@/lib/network/mergeResults'
import { evaluateReadiness } from '@/lib/studypack/readiness'
import { planBulkIngest, slotsFor } from '@/lib/studypack/slots'
import { auditCsvText } from '@/lib/audit/cellAuditor'
import type { StudyConfig } from '@/types/studypack'

const enc = new TextEncoder()
const dir = path.resolve(import.meta.dirname, '../../../samples/r-script')
const script = readFileSync(path.join(dir, 'study-repo/CodeToRun.R'), 'utf8')
const config = JSON.parse(readFileSync(path.join(dir, 'protocol/study_config.json'), 'utf8')) as StudyConfig
const meta = { studyId: 'FACT_REL_2026', studyTitle: 'Fact relationship', cdmVersion: '5.4', minCellCount: 5 }

describe('marker', () => {
  it('suggests the comment line that separates site settings from the analysis', () => {
    expect(suggestMarker(script)).toBe('# --- script starts here ----')
  })
  it('prefers the Strategus template marker, and finds nothing in a script without a boundary', () => {
    expect(suggestMarker(`x <- 1\n# ${PROTECTED_MARKER}\nStrategus::execute()\n`)).toBe(PROTECTED_MARKER)
    expect(suggestMarker('# Count rows\nx <- 1\n')).toBeUndefined()
  })
  it('lists comment lines as candidates', () => {
    expect(commentLines(script)).toContain('# --- Set database and CDM schema here (edit the values in this section) ---')
  })
  it('ignores edits to the connection settings but not to the query', async () => {
    const marker = suggestMarker(script)!
    const base = await protectedSectionHash(script, marker)
    const otherSite = script.replace('myDbms <- "postgresql"', 'myDbms <- "sql server"').replace('cdmDatabaseSchema <- "cdm"', 'cdmDatabaseSchema <- "omop.dbo"')
    expect(await protectedSectionHash(otherSite, marker)).toBe(base)
    expect(await protectedSectionHash(script.replace('GROUP BY fr.domain_concept_id_1', 'GROUP BY fr.domain_concept_id_2'), marker)).not.toBe(base)
    expect(await protectedSectionHash(script.replace('COUNT(*) AS cnt', 'COUNT(DISTINCT fr.fact_id_1) AS cnt'), marker)).not.toBe(base)
  })
})

describe('protocol issuance', () => {
  it('takes a repository with only an R script as an R script study', () => {
    const repo = locateStudyRepo([{ path: 'fact-relationship-main/CodeToRun.R', bytes: enc.encode(script) }, { path: 'fact-relationship-main/README.md', bytes: enc.encode('# x') }])
    expect(repo.kind).toBe('R script')
    expect(repo.errors).toEqual([])
  })
  it('keeps a Strategus repository a Strategus study', () => {
    const repo = locateStudyRepo([{ path: 'ExecuteAnalyses.R', bytes: enc.encode('Strategus::execute()\n') }])
    expect(repo.kind).toBe('Strategus')
    expect(repo.errors).toContain('renv.lock not found')
  })
  it('pins the script below the suggested marker, or whole when asked', async () => {
    const repo = locateStudyRepo([{ path: 'CodeToRun.R', bytes: enc.encode(script) }])
    const p = await issueProtocol(repo, meta)
    expect(p.config.framework.name).toBe('R script')
    expect(p.config.protectedSections['code/ExecuteAnalyses.R'].marker).toBe('# --- script starts here ----')
    expect(p.config.expectedHashes).toEqual({})
    expect(Object.keys(p.files)).toEqual(['code/ExecuteAnalyses.R'])
    const whole = await issueProtocol(repo, { ...meta, marker: null })
    expect(whole.config.protectedSections).toEqual({})
    expect(Object.keys(whole.config.expectedHashes)).toEqual(['code/ExecuteAnalyses.R'])
  })
  it('refuses regulatory assurance', async () => {
    const repo = locateStudyRepo([{ path: 'CodeToRun.R', bytes: enc.encode(script) }])
    await expect(issueProtocol(repo, { ...meta, assurance: 'regulatory' })).rejects.toThrow(/standard assurance/)
  })
  it('round-trips through the protocol ZIP', async () => {
    const r = await readProtocolFile('FACT_REL_2026_protocol.zip', readFileSync(path.join(dir, 'protocol/FACT_REL_2026_protocol.zip')))
    expect(r.errors).toEqual([])
    expect(r.config?.framework.name).toBe('R script')
    expect(Object.keys(r.files)).toEqual(['code/ExecuteAnalyses.R'])
  })
})

describe('site', () => {
  it('needs only the script and the result CSV', async () => {
    expect(slotsFor(config).map((s) => [s.id, s.required])).toEqual([['executeAnalyses', true], ['renvLock', false]])
    const csv = readFileSync(path.join(dir, 'site-inputs/fact_relationships-aggregated-and-relative-data.csv'), 'utf8')
    const audit = auditCsvText(csv, 'x.csv', { minCellCount: 5 })
    const r = evaluateReadiness({
      siteId: 'Site_A',
      config,
      slots: { executeAnalyses: { name: 'CodeToRun.R', sha256: 'x', protectedSha256: config.protectedSections['code/ExecuteAnalyses.R'].sha256 } },
      results: { '_root/fact.csv': { name: 'fact.csv', sha256: 'y', audit } },
    })
    expect(r.blockers).toEqual([])
    expect(r.canPackage).toBe(true)
    // Percentages only: say that small cells could not be checked.
    expect(r.warnings.some((w) => w.includes('no count column'))).toBe(true)
  })
  it('still blocks small counts when the CSV has a count column', () => {
    const audit = auditCsvText('domain,cnt\nPerson,3\n', 'x.csv', { minCellCount: 5 })
    const r = evaluateReadiness({ siteId: 'Site_A', config, slots: { executeAnalyses: { name: 'CodeToRun.R', sha256: 'x' } }, results: { '_root/x.csv': { name: 'x.csv', sha256: 'y', audit } } })
    expect(r.canPackage).toBe(false)
  })
  it('takes loose CSVs in a bulk drop as results', () => {
    const plan = planBulkIngest(['out.csv', 'CodeToRun.R'], new Set(['executeAnalyses']), { csvAsResults: true })
    expect(plan.resultCsvs).toEqual(['out.csv'])
    expect(plan.protectedByProtocol).toEqual([{ name: 'CodeToRun.R', slotId: 'executeAnalyses' }])
    expect(planBulkIngest(['out.csv'], new Set()).unknown).toEqual(['out.csv'])
  })
})

describe('coordinator', () => {
  const load = () => Promise.all(readdirSync(path.join(dir, 'packs')).sort().map((f) => loadStudyPack(f, readFileSync(path.join(dir, 'packs', f)))))

  it('adopts sites whose settings differ, excludes edited analysis code and tampered results', async () => {
    const sites = await load()
    const paths = protocolKeyPaths(config, sites)
    expect(paths).toEqual(['code/ExecuteAnalyses.R'])
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, paths)
    const verdicts = Object.fromEntries(sites.map((s) => [s.siteId, siteVerdict(s, cross, config.studyId, sites, { config })]))
    expect(verdicts.Site_A.recommended).toBe('adopt')
    expect(verdicts.Site_B.recommended).toBe('adopt')
    expect(verdicts.Site_C.reasons).toEqual(['ExecuteAnalyses.R protected section mismatch'])
    expect(verdicts.Site_D.reasons).toEqual(['Tampering detected (hash mismatch)'])
  })
  it('verifies without a protocol, using the marker the sites sealed with', async () => {
    const sites = await load()
    const paths = protocolKeyPaths(undefined, sites)
    const cross = crossCheckSites(sites, {}, {}, paths)
    expect(cross.references['code/ExecuteAnalyses.R']).toMatchObject({ kind: 'section', source: 'majority' })
    expect(sites.filter((s) => siteVerdict(s, cross, undefined, sites).recommended === 'adopt').map((s) => s.siteId)).toEqual(['Site_A', 'Site_B'])
  })
  it('merges the adopted sites into one CSV with site_id', async () => {
    const sites = (await load()).filter((s) => ['Site_A', 'Site_B'].includes(s.siteId))
    const [m] = mergeSiteResults(sites)
    expect(m.fileName).toBe('fact_relationships-aggregated-and-relative-data_merged.csv')
    expect(m.rows).toBe(6)
    const lines = m.csv.trim().split('\n')
    expect(lines[0]).toBe('site_id,domainConceptId1,domainConceptName1,domainConceptId2,domainConceptName2,percentage')
    expect(lines[1]).toBe('Site_A,56,Person,56,Person,58.4')
    expect(lines.at(-1)).toBe('Site_B,56,Person,56,Person,27.97')
  })
})
