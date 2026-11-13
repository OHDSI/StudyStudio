import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planBulkIngest, SITE_PRODUCED_SLOTS, SLOT_BY_ID, SLOTS } from './slots'

const SLOTS_FROM_PROTOCOL = SLOTS.filter((s) => s.fromProtocol).map((s) => s.id)

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

describe('samples/site-inputs', () => {
  const dir = path.resolve(__dirname, '../../../samples/site-inputs')
  const protocolFilled = new Set(SLOTS_FROM_PROTOCOL)
  // Each scenario folder is meant to be dropped as a whole onto the bulk drop zone in Site Mode step 2.
  for (const scenario of ['clean', 'small-cells', 'dqd-failure']) {
    it(`${scenario}/ fills every site slot and the results when dropped as a whole`, () => {
      const names = readdirSync(path.join(dir, scenario)).map((n) => `${scenario}/${n}`)
      const plan = planBulkIngest(names, protocolFilled)
      expect(plan.unknown).toEqual([])
      expect(plan.protectedByProtocol).toEqual([])
      expect(plan.resultsArchives).toHaveLength(1)
      // run_record.json comes from the results ZIP; every other site-produced slot from a file of its own.
      expect(plan.assign.map((a) => a.slotId).sort()).toEqual(SITE_PRODUCED_SLOTS.filter((id) => id !== 'runRecord').sort())
    })
  }
})
