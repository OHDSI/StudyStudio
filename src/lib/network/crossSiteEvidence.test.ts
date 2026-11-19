import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossCheckSites, loadStudyPack, siteVerdict, type LoadedSitePack } from './aggregator'
import { conceptFingerprints, crossSiteEvidence, differingFromMajority, heterogeneity, missingAttrition, siteAttrition } from './crossSiteEvidence'
import { buildRegulatoryExport } from '@/lib/export/regulatory'
import type { StudyConfig } from '@/types/studypack'

const samples = path.resolve(__dirname, '../../../samples')
const enc = new TextEncoder()
const dec = new TextDecoder()
const config = JSON.parse(readFileSync(path.join(samples, 'standard/protocol/study_config.json'), 'utf8')) as StudyConfig

async function adopted() {
  const dir = path.join(samples, 'standard/packs')
  const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
  return sites.filter((s) => s.siteId === 'Site_A' || s.siteId === 'Site_B')
}
/** A copy of a pack with extra or replaced files (the evidence functions only read files). */
const withFiles = (s: LoadedSitePack, files: Record<string, string>, siteId = s.siteId): LoadedSitePack => ({
  ...s,
  siteId,
  files: { ...s.files, ...Object.fromEntries(Object.entries(files).map(([p, t]) => [p, enc.encode(t)])) },
})

const CM_ATTRITION = [
  'sequence_number,description,subjects,exposure_id,target_comparator_id,analysis_id,outcome_id,database_id',
  '1,Original cohorts,1200,1,10,1,3,A',
  '2,First exposure only,1100,1,10,1,3,A',
  '3,Have at least 1 day at risk,-5,1,10,1,3,A',
  '1,Original cohorts,900,2,10,1,3,A',
].join('\n')

describe('A2: attrition', () => {
  it('skips a site without the tables silently', async () => {
    const [a] = await adopted()
    expect(siteAttrition(a)).toEqual({ siteId: 'Site_A' })
  })

  it('groups CohortMethod attrition by its key columns, in step order, showing censored counts as <k', async () => {
    const [a] = await adopted()
    const s = withFiles(a, { 'results/CohortMethodModule/cm_attrition.csv': CM_ATTRITION })
    const att = siteAttrition(s)
    expect(att.cohortMethod).toHaveLength(2)
    expect(att.cohortMethod![0]).toEqual({
      key: { exposure_id: '1', target_comparator_id: '10', analysis_id: '1', outcome_id: '3' },
      steps: [
        { sequence: 1, description: 'Original cohorts', subjects: '1200' },
        { sequence: 2, description: 'First exposure only', subjects: '1100' },
        { sequence: 3, description: 'Have at least 1 day at risk', subjects: '<5' },
      ],
    })
    expect(missingAttrition(s, config)).toBe(false)
    expect(missingAttrition(a, config)).toBe(true)
    expect(missingAttrition(a, { ...config, framework: { name: 'Strategus', modules: ['CohortGeneratorModule'] } })).toBe(false)
  })

  it('reads CohortGenerator inclusion-rule counts with their names', async () => {
    const [a] = await adopted()
    const s = withFiles(a, {
      'results/CohortGeneratorModule/cg_cohort_inc_stats.csv': 'database_id,cohort_definition_id,rule_sequence,person_count,gain_count,person_total,mode_id\nA,1,0,800,40,1000,1\nA,1,1,-5,2,1000,1\n',
      'results/CohortGeneratorModule/cg_cohort_inclusion.csv': 'cohort_definition_id,rule_sequence,name,description\n1,0,Age >= 18,\n1,1,No prior angioedema,\n',
    })
    expect(siteAttrition(s).inclusionRules).toEqual([
      { cohortId: '1', rule: '0', name: 'Age >= 18', personCount: '800', gainCount: '40', personTotal: '1000', modeId: '1' },
      { cohortId: '1', rule: '1', name: 'No prior angioedema', personCount: '<5', gainCount: '2', personTotal: '1000', modeId: '1' },
    ])
  })
})

describe('E1: concept-set resolution', () => {
  it('fingerprints the resolved standard concepts per site and marks the site that differs', async () => {
    const [a, b] = await adopted()
    const resolved = (ids: number[]) => ['cohort_id,concept_set_id,concept_id,database_id', ...ids.map((i) => `1,0,${i},X`)].join('\n')
    const included = 'database_id,cohort_id,concept_set_id,concept_id,source_concept_id,concept_subjects,concept_count\nX,1,0,1308216,44819192,10,12\nX,1,0,1308216,44819193,10,12\n'
    const names = 'cohort_id,concept_set_id,concept_set_sql,concept_set_name,concept_set_expression\n1,0,,ACE inhibitors,{}\n'
    const sites = [
      withFiles(a, { 'results/CohortDiagnosticsModule/cd_resolved_concepts.csv': resolved([1308216, 1310756]), 'results/CohortDiagnosticsModule/cd_included_source_concept.csv': included, 'results/CohortDiagnosticsModule/cd_concept_sets.csv': names }),
      withFiles(b, { 'results/CohortDiagnosticsModule/cd_resolved_concepts.csv': resolved([1310756, 1308216]) }),
      withFiles(b, { 'results/CohortDiagnosticsModule/cd_resolved_concepts.csv': resolved([1308216]) }, 'Site_E'),
      a,
    ]
    const rows = await conceptFingerprints(sites)
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.name).toBe('ACE inhibitors')
    // Order does not matter; a different set does.
    expect(r.sites.Site_A!.sha256).toBe(r.sites.Site_B!.sha256)
    expect(r.sites.Site_E!.concepts).toBe(1)
    expect(r.differing).toEqual(['Site_E'])
    expect(r.sites.Site_A!.sourceCodes).toBe(2)
    expect(r.sites.Site_B).toMatchObject({ concepts: 2, from: 'resolved' })
    expect(r.sites.Site_B!.sourceCodes).toBeUndefined()
  })
})

describe('X1: heterogeneity across the adopted sites', () => {
  it('shows versions, cut-off, platform and DQD per site, marks the outlier, and flags differing vocabularies when none is required', async () => {
    const [a, b] = await adopted()
    const dbm = (vocab: string) => dec.decode(a.files['results/DatabaseMetaData/database_meta_data.csv']).replace(/v5\.0 30-AUG-26/g, vocab)
    const c = withFiles(b, { 'results/DatabaseMetaData/database_meta_data.csv': dbm('v5.0 01-JAN-25') }, 'Site_E')
    const h = heterogeneity([a, b, c], config)
    expect(h.rows.map((r) => r.siteId)).toEqual(['Site_A', 'Site_B', 'Site_E'])
    expect(h.rows[0].values).toMatchObject({ 'CDM version': '5.4', 'Vocabulary version': 'v5.0 30-AUG-26', DBMS: 'postgresql' })
    expect(h.rows[0].values['Data cut-off']).toBeTruthy()
    expect(h.rows[2].differing).toContain('Vocabulary version')
    expect(h.rows[0].differing).not.toContain('Vocabulary version')
    expect(h.findings.join()).toMatch(/use 2 vocabulary versions .* and the protocol requires none/)
    expect(heterogeneity([a, b, c], { ...config, cdmRequirements: { vocabularyVersion: 'v5.0 30-AUG-26' } }).findings).toEqual([])
  })

  it('lists DQD checks that fail at some adopted sites but not at others', async () => {
    const [a, b] = await adopted()
    const dqd = JSON.parse(dec.decode(a.files['evidence/dqd_results.json']))
    const target = dqd.CheckResults.find((x: { failed: number; notApplicable?: number }) => !x.failed && !x.notApplicable)
    target.failed = 1
    const e = withFiles(b, { 'evidence/dqd_results.json': JSON.stringify(dqd) }, 'Site_E')
    const diff = heterogeneity([a, b, e], config).dqdDifferences
    expect(diff).toContainEqual(expect.objectContaining({ check: target.checkName, failingAt: ['Site_E'], passingAt: ['Site_A', 'Site_B'] }))
  })

  it('marks values against a strict majority, or all values when there is none', () => {
    expect(differingFromMajority({ A: 'x', B: 'x', C: 'y', D: undefined })).toEqual(['C'])
    expect(differingFromMajority({ A: 'x', B: 'y' })).toEqual(['A', 'B'])
    expect(differingFromMajority({ A: 'x', B: 'x' })).toEqual([])
  })
})

describe('cross-site evidence in the audit report', () => {
  it('is shown for review and never blocks an export, in any mode', async () => {
    const [a, b] = await adopted()
    const sites = [withFiles(a, { 'results/CohortMethodModule/cm_attrition.csv': CM_ATTRITION }), b]
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const rows = sites.map((s) => ({ site: s, verdict: siteVerdict(s, cross, config.studyId, sites), adopted: true }))
    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows })
    expect(out.markdown).toContain('## Cross-site evidence (for review)')
    expect(out.markdown).toContain('| Site | CDM version | Vocabulary version | DQD version | DQD failures on study tables | Source release | Data cut-off | Strategus | R | DBMS |')
    expect(out.markdown).toContain('| 3 | Have at least 1 day at risk | <5 |')
    expect(out.markdown).toContain('- Review: Site_B has no CohortMethod attrition table although CohortMethod is in the analysis specification.')
    expect(out.html).toContain('<h2>Cross-site evidence (for review)</h2>')
    const ev = await crossSiteEvidence(sites, config)
    expect(ev.missingAttrition).toEqual(['Site_B'])
  })
})
