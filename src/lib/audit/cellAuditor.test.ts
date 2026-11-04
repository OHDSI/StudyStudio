import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { auditCsvText, auditWorkbook, detectIdentifier, remediateCsvText, remediateWorkbook } from './cellAuditor'

const csv = `cohort_id,cohort_name,subject_count,mean_age,percent_male
1,A,120,54.2,0.5
2,B,3,60.1,0.2
3,C,0,70,0.1
4,D,"1,234",40,0.3
`

describe('cellAuditor', () => {
  it('flags 0 < n < 5 only in count columns', () => {
    const r = auditCsvText(csv)
    expect(r.passed).toBe(false)
    expect(r.smallCellCount).toBe(1)
    expect(r.findings[0]).toMatchObject({ kind: 'smallCell', row: 3, column: 'subject_count', value: 3 })
    expect(r.sheets[0].countColumns).toEqual(['subject_count'])
  })

  it('respects a custom minCellCount', () => {
    expect(auditCsvText(csv, 'x.csv', { minCellCount: 11 }).smallCellCount).toBe(1)
    expect(auditCsvText('n\n7\n', 'x.csv', { minCellCount: 11 }).smallCellCount).toBe(1)
  })

  it('detects direct identifiers', () => {
    expect(detectIdentifier('person_id')).toBeTruthy()
    expect(detectIdentifier('Date of Birth')).toBeTruthy()
    expect(detectIdentifier('national_id')).toBeTruthy()
    expect(detectIdentifier('cohort_name')).toBeUndefined()
    expect(detectIdentifier('concept_id')).toBeUndefined()
    const r = auditCsvText('person_id,n\n10,50\n')
    expect(r.identifierCount).toBe(1)
    expect(r.passed).toBe(false)
  })

  it('falls back to integer columns when no count hint exists', () => {
    const r = auditCsvText('cohort_id,stratum,value_a\n1,x,2\n2,y,40\n')
    expect(r.sheets[0].countColumnSource).toBe('fallback')
    expect(r.sheets[0].countColumns).toEqual(['value_a'])
    expect(r.smallCellCount).toBe(1)
  })

  it('remediation masks small cells, drops identifiers and then passes', () => {
    const dirty = 'person_id,subject_count\n1,3\n2,40\n'
    const fixed = remediateCsvText(dirty)
    expect(fixed).toBe('subject_count\n-5\n40\n')
    expect(auditCsvText(fixed).passed).toBe(true)
    expect(remediateCsvText(dirty, {}, 'lt')).toBe('subject_count\n<5\n40\n')
    expect(remediateCsvText(dirty, {}, 'na')).toBe('subject_count\nNA\n40\n')
  })

  it('audits and remediates Excel workbooks (WhiteRabbit layout)', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['sex', 'Frequency', 'person_id', 'Frequency'], ['M', 100, 1, 1], ['F', 2, 2, 1]]), 'patients')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const r = auditWorkbook(buf)
    expect(r.identifierCount).toBe(1)
    expect(r.smallCellCount).toBe(3)
    const fixed = remediateWorkbook(buf)
    const r2 = auditWorkbook(fixed)
    expect(r2.passed).toBe(true)
    const rows = XLSX.utils.sheet_to_json(XLSX.read(fixed, { type: 'array' }).Sheets.patients, { header: 1 })
    expect(rows).toEqual([['sex', 'Frequency'], ['M', 100], ['F', '-5']])
  })

  it('uses explicit count columns (results data model) instead of name heuristics', () => {
    const text = 'database_id,cohort_id,cohort_entries,cohort_subjects\nX,3,10,3\n'
    // Heuristics would also scan nothing named like an id; the specification decides exactly.
    const r = auditCsvText(text, 'cg_cohort_count.csv', { countColumns: ['cohort_subjects'] })
    expect(r.sheets[0].countColumnSource).toBe('specification')
    expect(r.sheets[0].countColumns).toEqual(['cohort_subjects'])
    expect(r.smallCellCount).toBe(1)
    expect(remediateCsvText(text, { countColumns: ['cohort_subjects'] })).toBe('database_id,cohort_id,cohort_entries,cohort_subjects\nX,3,10,-5\n')
  })

  it('treats HADES-censored negative values as already suppressed', () => {
    expect(auditCsvText('subject_count\n-5\n0\n12\n').passed).toBe(true)
  })
})
