import { describe, expect, it } from 'vitest'
import type { LoadedSitePack } from './aggregator'
import { checkPlausibility } from './plausibility'

const enc = new TextEncoder()
const CG = 'results/CohortGeneratorModule/cg_cohort_count.csv'
const CM = 'results/CohortMethodModule/cm_result.csv'
const META = 'results/DatabaseMetaData/database_meta_data.csv'
const DEF = 'results/CohortGeneratorModule/cg_cohort_definition.csv'

function site(siteId: string, files: Record<string, string>, hashes: Record<string, string> = {}): LoadedSitePack {
  return {
    key: `${siteId}-key`,
    siteId,
    files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, enc.encode(t)])),
    fileHashes: hashes,
  } as unknown as LoadedSitePack
}

const cg = (db: string, a = 1200, b = 900) => `database_id,cohort_id,cohort_entries,cohort_subjects\n${db},1,${a + 10},${a}\n${db},2,${b + 5},${b}\n`
const meta = (db: string, name: string) => `database_id,cdm_source_name,cdm_version\n${db},${name},5.4\n`
const codes = (r: Map<string, { code: string }[]>, s: LoadedSitePack) => r.get(s.key)!.map((f) => f.code)

describe('plausibility checks', () => {
  it('finds nothing in independent sites', () => {
    const a = site('Site_A', { [CG]: cg('A'), [META]: meta('A', 'Hospital A') })
    const b = site('Site_B', { [CG]: cg('B', 1300, 950), [META]: meta('B', 'Hospital B') })
    const r = checkPlausibility([a, b])
    expect(codes(r, a)).toEqual([])
    expect(codes(r, b)).toEqual([])
  })

  it('finds counts copied from another site with database_id renamed, in either row order', () => {
    const a = site('Site_A', { [CG]: cg('A') })
    const lines = cg('B').trim().split('\n')
    const b = site('Site_B', { [CG]: [lines[0], lines[2], lines[1]].join('\n') + '\n' })
    const r = checkPlausibility([a, b])
    expect(r.get(b.key)).toEqual([expect.objectContaining({ code: 'duplicate-results', otherSites: ['Site_A'] })])
    expect(r.get(a.key)![0].message).toContain('CohortGeneratorModule/cg_cohort_count.csv')
  })

  it('ignores tables without counts, which are the same at every site by design', () => {
    const def = 'cohort_definition_id,cohort_name\n1,Target\n2,Comparator\n'
    const r = checkPlausibility([site('Site_A', { [DEF]: def }), site('Site_B', { [DEF]: def })])
    expect([...r.values()].flat()).toEqual([])
  })

  it('uses the results data model specification to find count columns', () => {
    const rdms = 'table_name,column_name,data_type,is_required,primary_key,min_cell_count\nx_table,database_id,varchar,Yes,Yes,No\nx_table,n,int,Yes,No,Yes\n'
    const t = (db: string) => `database_id,n\n${db},42\n`
    const files = (db: string) => ({ 'results/XModule/x_table.csv': t(db), 'results/XModule/resultsDataModelSpecification.csv': rdms })
    const r = checkPlausibility([site('Site_A', files('A')), site('Site_B', files('B'))])
    expect(r.get('Site_B-key')!.map((f) => f.code)).toEqual(['duplicate-results'])
  })

  it('does not compare two packs from the same site', () => {
    const r = checkPlausibility([site('Site_A', { [CG]: cg('A') }), { ...site('Site_A', { [CG]: cg('A') }), key: 'again' } as LoadedSitePack])
    expect([...r.values()].flat()).toEqual([])
  })

  it('finds the same database and the same DQD run at two sites', () => {
    const a = site('Site_A', { [META]: meta('SHARED', 'Hospital A') }, { 'evidence/dqd_results.json': 'f'.repeat(64) })
    const b = site('Site_B', { [META]: meta('SHARED', 'Hospital B') }, { 'evidence/dqd_results.json': 'f'.repeat(64) })
    expect(codes(checkPlausibility([a, b]), b)).toEqual(['same-database', 'same-dqd'])
  })

  it('finds counts that cannot occur together, ignoring censored values', () => {
    const cohorts = 'database_id,cohort_id,cohort_entries,cohort_subjects\nA,1,100,120\nA,2,-5,-5\nA,3,50,40\n'
    const cm = 'target_id,comparator_id,target_subjects,comparator_subjects\n1,3,90,45\n1,3,-5,-5\n'
    const r = checkPlausibility([site('Site_A', { [CG]: cohorts, [CM]: cm })])
    const messages = r.get('Site_A-key')!.filter((f) => f.code === 'impossible-counts').map((f) => f.message)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('more subjects than entries (cohort 1)')
    expect(messages[1]).toContain('more comparator subjects than the cohort has in cg_cohort_count (3: 45 > 40)')
  })
})
