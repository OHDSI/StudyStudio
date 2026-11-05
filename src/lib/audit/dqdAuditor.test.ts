import { describe, expect, it } from 'vitest'
import { defaultDqdPolicy, evaluateDqdGate, studyTablesFor } from './dqdAuditor'

const check = (o: Record<string, unknown>) => ({ checkName: 'x', checkLevel: 'FIELD', category: 'Plausibility', failed: 0, isError: 0, notApplicable: 0, ...o })
const dqd = (checks: Record<string, unknown>[]) => ({
  startTimestamp: '2026-10-28 09:12:03',
  endTimestamp: '2026-10-28 10:41:55',
  Metadata: [{ CDM_SOURCE_NAME: 'Demo', VOCABULARY_VERSION: 'v5.0 30-AUG-26', DQD_VERSION: '2.6.1' }],
  CheckResults: checks,
})

describe('studyTablesFor', () => {
  it('derives tables from CIRCE criteria and covariate-using modules', () => {
    const expr = { PrimaryCriteria: { CriteriaList: [{ DrugExposure: { CodesetId: 1 } }] }, AdditionalCriteria: { CriteriaList: [{ Criteria: { ConditionOccurrence: {} } }] } }
    expect(studyTablesFor([expr], ['SelfControlledCaseSeriesModule'])).toEqual(['CONDITION_OCCURRENCE', 'DRUG_EXPOSURE', 'OBSERVATION_PERIOD', 'PERSON'])
    expect(studyTablesFor([], ['CohortMethodModule'])).toContain('MEASUREMENT')
  })
})

describe('evaluateDqdGate', () => {
  const policy = defaultDqdPolicy(['DRUG_EXPOSURE'])

  it('blocks when DQD is missing or has no per-check results', () => {
    expect(evaluateDqdGate(undefined, policy).blocked).toBe(true)
    expect(evaluateDqdGate({ Overview: { countTotal: 10 } }, policy).findings[0].ruleId).toBe('check-results-missing')
    expect(evaluateDqdGate(undefined, { ...policy, requireDqd: false }).blocked).toBe(false)
  })

  it('blocks structural conformance failures on study tables only', () => {
    const r = evaluateDqdGate(
      dqd([
        check({ checkName: 'isRequired', category: 'Conformance', cdmTableName: 'drug_exposure', cdmFieldName: 'drug_concept_id', failed: 1 }),
        check({ checkName: 'isRequired', category: 'Conformance', cdmTableName: 'NOTE', failed: 1 }),
      ]),
      policy,
    )
    expect(r.counts).toEqual({ block: 1, warn: 0, info: 1 })
    expect(r.blocked).toBe(true)
    expect(r.metadata.vocabularyVersion).toBe('v5.0 30-AUG-26')
  })

  it('warns on other study-table failures, blocks errored checks on study tables, skips not-applicable', () => {
    const r = evaluateDqdGate(
      dqd([
        check({ checkName: 'plausibleValueHigh', cdmTableName: 'DRUG_EXPOSURE', failed: 1, pctViolatedRows: 0.02 }),
        check({ checkName: 'measureValueCompleteness', cdmTableName: 'PERSON', isError: 1 }),
        check({ checkName: 'measureValueCompleteness', cdmTableName: 'NOTE', isError: 1 }),
        check({ checkName: 'cdmTable', cdmTableName: 'DRUG_EXPOSURE', failed: 1, notApplicable: 1 }),
        check({ checkName: 'cdmField', cdmTableName: 'PERSON' }),
      ]),
      policy,
    )
    expect(r.checksEvaluated).toBe(4)
    expect(r.counts).toEqual({ block: 1, warn: 2, info: 0 })
    expect(r.findings.map((f) => f.ruleId)).toEqual(['study-table', 'check-error', 'check-error'])
  })

  it('passes a clean run', () => {
    const r = evaluateDqdGate(dqd([check({ cdmTableName: 'PERSON' })]), policy)
    expect(r.blocked).toBe(false)
    expect(r.counts).toEqual({ block: 0, warn: 0, info: 0 })
  })
})
