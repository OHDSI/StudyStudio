import { describe, expect, it } from 'vitest'
import { auditCsvText } from '@/lib/audit/cellAuditor'
import { evaluateReadiness } from './readiness'
import type { StudyConfig } from '@/types/studypack'

const config = {
  studyId: 'S',
  cdmVersion: '5.4',
  minCellCount: 5,
  expectedHashes: { 'code/renv.lock': 'a'.repeat(64) },
  protectedSections: { 'code/ExecuteAnalyses.R': { marker: 'DO NOT MODIFY BELOW THIS POINT', sha256: 'b'.repeat(64) } },
} as unknown as StudyConfig
const slots = {
  dqdResults: { name: 'd', sha256: 'x' },
  analysisSpecifications: { name: 's', sha256: 'x' },
  renvLock: { name: 'r', sha256: 'a'.repeat(64) },
  executeAnalyses: { name: 'e', sha256: 'whatever-the-site-typed', protectedSha256: 'b'.repeat(64) },
}
const result = (csv: string) => ({ 'CohortGeneratorModule/cg_cohort_count.csv': { name: 'cg', sha256: 'x', audit: auditCsvText(csv, 'cg', { countColumns: ['cohort_subjects'] }) } })

describe('evaluateReadiness', () => {
  it('locks packaging while small cells remain and unlocks after remediation', () => {
    const dirty = evaluateReadiness({ siteId: 'A', config, slots, results: result('cohort_id,cohort_subjects\n1,3\n') })
    expect(dirty.canPackage).toBe(false)
    expect(dirty.privacyViolations).toBe(1)
    const clean = evaluateReadiness({ siteId: 'A', config, slots, results: result('cohort_id,cohort_subjects\n1,-5\n') })
    expect(clean.canPackage).toBe(true)
    expect(clean.warnings).toEqual([])
  })
  it('requires protocol, site id, required slots and results', () => {
    const r = evaluateReadiness({ siteId: '', slots: {}, results: {} })
    expect(r.canPackage).toBe(false)
    expect(r.blockers.join('\n')).toMatch(/Strategus results are not loaded/)
    expect(r.blockers.length).toBeGreaterThanOrEqual(6)
  })
  it('compares ExecuteAnalyses.R on its protected section only, and warns on a lower exported minCellCount', () => {
    const ok = evaluateReadiness({ siteId: 'A', config, slots, results: result('cohort_id,cohort_subjects\n1,9\n') })
    expect(ok.warnings).toEqual([])
    const edited = evaluateReadiness({
      siteId: 'A',
      config,
      slots: { ...slots, executeAnalyses: { ...slots.executeAnalyses, protectedSha256: 'c'.repeat(64) } },
      results: result('cohort_id,cohort_subjects\n1,9\n'),
      exportedMinCellCount: 0,
    })
    expect(edited.canPackage).toBe(true)
    expect(edited.warnings.join('\n')).toMatch(/differs from the protocol/)
    expect(edited.warnings.join('\n')).toMatch(/minCellCount 0/)
  })
})
