import { describe, expect, it } from 'vitest'
import { planBulkIngest, SITE_PRODUCED_SLOTS, SLOT_BY_ID } from './slots'

describe('planBulkIngest', () => {
  it('never overwrites protocol-distributed artifacts and routes ZIPs to results', () => {
    const plan = planBulkIngest(
      ['ScanReport.xlsx', 'dqd_results.json', 'ExecuteAnalyses.R', 'analysisSpecifications.json', 'executionSettings.json', 'strategus_results.zip', 'notes.txt', 'cm_result.csv'],
      new Set(['executeAnalyses', 'analysisSpecifications', 'renvLock'] as const),
    )
    expect(plan.assign.map((a) => a.slotId)).toEqual(['scanReport', 'dqdResults', 'executionSettings'])
    expect(plan.protectedByProtocol.map((a) => a.slotId)).toEqual(['executeAnalyses', 'analysisSpecifications'])
    expect(plan.resultsArchives).toEqual(['strategus_results.zip'])
    expect(plan.unknown).toEqual(['notes.txt', 'cm_result.csv'])
  })
  it('accepts protocol files when no protocol copy is loaded', () => {
    expect(planBulkIngest(['ExecuteAnalyses.R'], new Set()).assign).toEqual([{ name: 'ExecuteAnalyses.R', slotId: 'executeAnalyses' }])
  })
  it('lists only site-produced artifacts as site slots', () => {
    expect(SITE_PRODUCED_SLOTS.some((id) => SLOT_BY_ID[id].fromProtocol)).toBe(false)
    expect(SITE_PRODUCED_SLOTS).toContain('executionSettings')
  })
})
