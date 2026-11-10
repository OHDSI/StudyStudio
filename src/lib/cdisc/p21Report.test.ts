import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { parseP21Report, reportMismatches, runLabel } from './p21Report'
import { p21Workbook } from './p21Report.testutil'

describe('Pinnacle 21 reports', () => {
  it('reads the run, the datasets validated and the issues, without local paths', () => {
    const r = parseP21Report(
      'pmda_adam.xlsx',
      p21Workbook({
        engine: 'PMDA 2411.1',
        config: 'ADaM-IG 1.3 (PMDA)',
        datasets: ['CMRESULT', 'CGCOHCOU'],
        problems: ['MedDRA not configured'],
        issues: [
          ['GLOBAL', 'AD0001', 'Missing ADSL dataset', 'Reject', 1],
          ['GLOBAL', 'SD0061', 'Domain referenced in define.xml, but dataset is missing', 'Error', 2],
          ['CGCOHCOU', 'AD9999', 'Dataset CGCOHCOU not validated', 'Warning', 1],
          ['CMRESULT', 'AD9999', 'Dataset CMRESULT not validated', 'Warning', 1],
        ],
      }),
    )
    expect(r).toMatchObject({
      validator: 'Pinnacle 21',
      softwareVersion: '1.0.9',
      engine: 'PMDA 2411.1',
      configuration: 'ADaM-IG 1.3 (PMDA)',
      define: 'define.xml',
      ctVersion: '2026-03-27',
      generated: '2026-11-11T02:06:28+09:00',
      installationProblems: ['MedDRA not configured'],
    })
    expect(r.datasets.map((d) => [d.name, d.source, d.records])).toEqual([['CMRESULT', 'cmresult.xpt', 3], ['CGCOHCOU', 'cgcohcou.xpt', 3]])
    expect(r.issues.map((i) => [i.id, i.severity, i.count, i.sources])).toEqual([
      ['AD0001', 'Reject', 1, ['GLOBAL']],
      ['SD0061', 'Error', 2, ['GLOBAL']],
      ['AD9999', 'Warning', 2, ['CGCOHCOU', 'CMRESULT']],
    ])
    expect(JSON.stringify(r)).not.toContain('someone')
    expect(runLabel(r)).toBe('PMDA 2411.1, ADaM-IG 1.3 (PMDA)')
    expect(reportMismatches(r, ['CMRESULT', 'CGCOHCOU'])).toEqual([])
    expect(reportMismatches(r, ['CMRESULT', 'CMDIASUM'])).toEqual(['validated dataset(s) not in this package: CGCOHCOU', 'package dataset(s) not validated: CMDIASUM'])
  })

  it('reads a define.xml-only run and refuses other workbooks', () => {
    const r = parseP21Report('define.xlsx', p21Workbook({ engine: 'FDA 2508.1', config: 'Define-XML 2.1 (FDA)', issues: [['DEFINE', 'DD0139', "Standard 'ADaM' is not referenced", 'Warning', 2]] }))
    expect(r.datasets).toEqual([])
    expect(r.issues).toEqual([{ id: 'DD0139', message: "Standard 'ADaM' is not referenced", severity: 'Warning', count: 2, sources: ['DEFINE'] }])
    const other = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(other, XLSX.utils.aoa_to_sheet([['Field Overview']]), 'Sheet1')
    expect(() => parseP21Report('scan.xlsx', new Uint8Array(XLSX.write(other, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))).toThrow('not a Pinnacle 21 validator report')
  })
})
