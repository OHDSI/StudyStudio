import { describe, expect, it } from 'vitest'
import { combineSiteCsvs } from './datasetJson'
import { fromIbmDouble, ibmDouble, readXpt, writeXpt, xptLimitIssues } from './xpt'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('IBM System/370 doubles', () => {
  it('encodes known values', () => {
    expect(hex(ibmDouble(1))).toBe('4110000000000000')
    expect(hex(ibmDouble(-118.625))).toBe('c276a00000000000') // the textbook example
    expect(hex(ibmDouble(0))).toBe('0000000000000000')
    expect(hex(ibmDouble(null))).toBe('2e00000000000000') // SAS missing "."
    expect(hex(ibmDouble(Number.NaN))).toBe('2e00000000000000')
  })

  it('round-trips the values Strategus writes exactly', () => {
    for (const x of [1, -1, 0.5, 0.1, 3.12, -5, 1.9e6, 12450, 1e-7, 123456789012, 2 ** 53 - 1, Math.PI, -0.0389, 1e75])
      expect(fromIbmDouble(ibmDouble(x))).toBe(x)
    expect(fromIbmDouble(ibmDouble(null))).toBeNull()
  })
})

describe('SAS V5 transport files', () => {
  const table = combineSiteCsvs(
    [
      { siteId: 'Site_A', csv: 'analysis_id,target_id,rr,p,database_id\n1,1781,3.12,0.09,SITE_A_EHR\n1,1782,,0.84,SITE_A_EHR\n' },
      { siteId: 'Site_B', csv: 'analysis_id,target_id,rr,p,database_id\n2,1781,1.04,NA,Hôpital B\n' },
    ],
    { sourceTable: 'cm_result', module: 'CohortMethodModule' },
  )
  const variables = ['SITE_ID', 'ANALID', 'TARGID', 'RR', 'P', 'DATAID']

  it('writes a file a reader parses back to the same values', () => {
    const b = writeXpt(table, { name: 'CMRESULT', variables, labels: table.columns.map((c) => `Label of ${c.name}`), label: 'cm_result (CohortMethodModule) with a long label', now: new Date('2026-11-11T01:02:03Z') })
    expect(b.byteLength % 80).toBe(0)
    expect(new TextDecoder().decode(b.subarray(0, 80))).toBe('HEADER RECORD*******LIBRARY HEADER RECORD!!!!!!!000000000000000000000000000000  ')
    expect(new TextDecoder().decode(b.subarray(80 * 2, 80 * 2 + 16))).toBe('11NOV26:01:02:03')
    const x = readXpt(b)
    expect(x.name).toBe('CMRESULT')
    expect(x.label).toBe('cm_result (CohortMethodModule) with a lo') // cut to 40 bytes
    expect(x.variables.map((v) => [v.name, v.type, v.length])).toEqual([
      ['SITE_ID', 'char', 6],
      ['ANALID', 'num', 8],
      ['TARGID', 'num', 8],
      ['RR', 'num', 8],
      ['P', 'num', 8],
      ['DATAID', 'char', 10], // "Hôpital B" is 10 bytes in UTF-8
    ])
    expect(x.rows).toEqual(table.rows)
  })

  it('refuses text longer than 200 bytes and names the column', () => {
    const long = combineSiteCsvs([{ siteId: 'A', csv: `cohort_definition_id,sql_command\n1,"${'x'.repeat(201)}"\n` }], { sourceTable: 'cg_cohort_definition' })
    expect(xptLimitIssues(long)).toEqual(['SQL_COMMAND: 201 bytes'])
    expect(() => writeXpt(long, { name: 'CGCOHDEF', variables: ['SITE_ID', 'COHDEFID', 'SQLCOMM'] })).toThrow('SQL_COMMAND: 201 bytes')
    expect(xptLimitIssues(table)).toEqual([])
  })
})
