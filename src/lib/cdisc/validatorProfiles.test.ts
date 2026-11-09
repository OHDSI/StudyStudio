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

  it('lists the define.xml findings of the version and the dataset findings, with their ratings', () => {
    const rows = (v: '2.1' | '2.0') => expectedFindings(v).map((f) => [f.p21, f.scope, f.severity.FDA, f.severity.PMDA])
    const data = [
      ['AD0001', 'data', 'Reject', 'Reject'],
      ['AD1024', 'data', 'Warning', 'Error'],
      ['AD1026', 'data', 'Warning', 'Error'],
      ['SD0061', 'data', 'Warning', 'Error'],
      ['AD9999', 'data', 'Warning', 'Warning'],
    ]
    expect(rows('2.1')).toEqual([['DD0139', 'define', 'Warning', 'Warning'], ...data])
    expect(rows('2.0')).toEqual(data)
    for (const f of expectedFindings('2.1')) expect(f.explanation.length).toBeGreaterThan(40)
  })
})
