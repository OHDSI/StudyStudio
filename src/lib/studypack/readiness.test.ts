import { describe, expect, it } from 'vitest'
import { auditCsvText } from '@/lib/audit/cellAuditor'
import { evaluateReadiness } from './readiness'
import { evaluateEvidence } from './evidence'
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
const signers = [{ role: 'operator' }]
const result = (csv: string) => ({ 'CohortGeneratorModule/cg_cohort_count.csv': { name: 'cg', sha256: 'x', audit: auditCsvText(csv, 'cg', { countColumns: ['cohort_subjects'] }) } })

describe('evaluateReadiness', () => {
  it('locks packaging while small cells remain and unlocks after remediation', () => {
    const dirty = evaluateReadiness({ siteId: 'A', config, slots, results: result('cohort_id,cohort_subjects\n1,3\n') })
    expect(dirty.canPackage).toBe(false)
    expect(dirty.privacyViolations).toBe(1)
    const clean = evaluateReadiness({ siteId: 'A', config, slots, signers, results: result('cohort_id,cohort_subjects\n1,-5\n') })
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
    const ok = evaluateReadiness({ siteId: 'A', config, slots, signers, results: result('cohort_id,cohort_subjects\n1,9\n') })
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
  it('does not nag about signatures in standard mode and blocks a missing one in regulatory mode', () => {
    const std = evaluateReadiness({ siteId: 'A', config, slots, results: result('cohort_id,cohort_subjects\n1,9\n') })
    expect(std.canPackage).toBe(true)
    expect(std.warnings).toEqual([])
    const reg = evaluateReadiness({ siteId: 'A', config: { ...config, assurance: 'regulatory' }, slots, results: result('cohort_id,cohort_subjects\n1,9\n') })
    expect(reg.canPackage).toBe(false)
    expect(reg.blockers.join('\n')).toMatch(/must be signed/)
  })
  it('turns regulatory evidence findings into blockers', () => {
    const evidence = evaluateEvidence({ config: { ...config, assurance: 'regulatory' }, files: {} })
    const r = evaluateReadiness({ siteId: 'A', config: { ...config, assurance: 'regulatory' }, slots, signers, results: result('cohort_id,cohort_subjects\n1,9\n'), evidence })
    const text = r.blockers.join('\n')
    expect(text).toMatch(/Data quality \(dqd-missing\)/)
    expect(text).toMatch(/cdm_source/)
    expect(text).toMatch(/execution log is missing/)
    const std = evaluateEvidence({ config, files: {} })
    const stdReadiness = evaluateReadiness({ siteId: 'A', config, slots, signers, results: result('cohort_id,cohort_subjects\n1,9\n'), evidence: std })
    expect(stdReadiness.canPackage).toBe(true)
    // The execution log is optional in standard studies: no warning when it is absent.
    expect(stdReadiness.warnings.join('\n')).not.toMatch(/execution log/)
  })
})
