import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectedFindings, P21_EQUIVALENT, rateIssues } from './validatorProfiles'

describe('validator profiles', () => {
  it('maps only rules that the checks implement', () => {
    const source = readFileSync(path.join(__dirname, 'defineRules.ts'), 'utf8')
    for (const rule of Object.keys(P21_EQUIVALENT)) expect(source).toContain(`'${rule}'`)
  })

  it('rates an issue by the strictest corresponding rule of each agency', () => {
    const [missingStandards, precision, own] = rateIssues([
      { rule: 'SS-DEF-030', target: 'def:Standards', message: 'x' },
      { rule: 'SS-DEF-033', target: 'IT.X', message: 'x' },
      { rule: 'SS-DEF-013', target: 'IG.X', message: 'x' },
    ])
    expect(missingStandards).toMatchObject({ p21: ['DD0006', 'DD0150'], severity: { FDA: 'Warning', PMDA: 'Reject' } })
    expect(precision.severity).toEqual({ FDA: 'Warning', PMDA: 'Warning' })
    expect(own).toMatchObject({ p21: [], severity: {} })
  })

  it('lists the unreferenced-standards warning for v2.1 only', () => {
    expect(expectedFindings('2.1').map((f) => [f.p21, f.severity.PMDA])).toEqual([['DD0139', 'Warning']])
    expect(expectedFindings('2.0')).toEqual([])
  })
})
