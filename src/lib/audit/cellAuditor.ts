/**
 * Zero-PHI & small-cell auditor.
 *
 * Scans tabular artifacts (CSV via PapaParse, Excel via SheetJS) for
 *   1. small cells: count values with 0 < n < minCellCount (default 1..4)
 *   2. direct identifier columns (person_id, birth date, names, ...)
 * and offers a one-click remediation that masks small cells and drops identifier columns.
 */
import Papa from 'papaparse'
import * as XLSX from 'xlsx'

/**
 * How suppressed cells are written:
 *  - 'negative': -minCellCount (HADES / Strategus convention; keeps the column numeric so results upload still works)
 *  - 'lt':       "<minCellCount"
 *  - 'na':       NA
 */
export type MaskStyle = 'negative' | 'lt' | 'na'

export interface AuditOptions {
  /** Minimum reportable count. Values 1..minCellCount-1 are violations. */
  minCellCount?: number
  /** Extra regex sources that identify count columns. */
  countColumnPatterns?: string[]
  /**
   * Exact count columns (e.g. from a Strategus resultsDataModelSpecification.csv). When given,
   * name heuristics are skipped and only these columns are scanned.
   */
  countColumns?: string[]
}

export interface SmallCellFinding {
  kind: 'smallCell'
  sheet?: string
  /** 1-based row number in the source table, including the header row. */
  row: number
  column: string
  columnIndex: number
  value: number
}

export interface IdentifierFinding {
  kind: 'identifier'
  sheet?: string
  column: string
  columnIndex: number
  reason: string
}

export type AuditFinding = SmallCellFinding | IdentifierFinding

export interface SheetSummary {
  sheet?: string
  rows: number
  countColumns: string[]
  /** How count columns were determined. */
  countColumnSource: 'specification' | 'name' | 'fallback'
}

export interface AuditResult {
  fileName: string
  format: 'csv' | 'xlsx'
  minCellCount: number
  scannedCells: number
  sheets: SheetSummary[]
  smallCellCount: number
  identifierCount: number
  findings: AuditFinding[]
  passed: boolean
  auditedAt: string
}

export const DEFAULT_MIN_CELL_COUNT = 5

type Cell = string | number | boolean | null | undefined
type Table = Cell[][]

const COUNT_HINT =
  /(count|^n$|^n[_ ]|[_ ]n$|^num|number|subjects|persons|patients|people|cases|events|outcomes|frequency|^freq|records|exposed|^total|_total$|tally)/i
const NON_COUNT_HINT =
  /(percent|pct|fraction|proportion|ratio|rate|mean|median|average|avg|^sd$|_sd$|stdev|std_|variance|estimate|^hr$|_ci_|ci_?(lb|ub|lower|upper)|p_?value|^se_|log_|^p\d{2}|_p\d{2}$)/i
const ID_LIKE =
  /(^id$|_id$|^id_|concept|code|year|month|^day|date|time|version|analysis|stratum|^database|_key$|^age|_age$|^min|^max|_min$|_max$|order|rank|seq)/i

interface IdentifierRule {
  re: RegExp
  reason: string
}

const IDENTIFIER_RULES: IdentifierRule[] = [
  { re: /^(person_id|person_source_value)$/, reason: 'OMOP person identifier (person_id)' },
  { re: /^(patient|subject|pt)_?(id|no|number)$/, reason: 'Patient identifier' },
  { re: /^(mrn|medical_record(_number)?|chart_(no|number))$/, reason: 'Medical record number' },
  { re: /^(birth_?date|birth_datetime|date_?of_?birth|dob|day_of_birth)$/, reason: 'Date of birth' },
  { re: /^(patient|person|first|last|full|given|family|sur)_?name$/, reason: 'Personal name' },
  { re: /^(address|street|street_address|address_?\d?|zip_?code|postal_?code|postcode)$/, reason: 'Address' },
  { re: /^(phone|phone_?number|tel|telephone|mobile|fax)$/, reason: 'Phone number' },
  { re: /^(e_?mail|email_address)$/, reason: 'Email address' },
  { re: /^(ssn|social_security(_number)?|national_?id|insurance_?(no|number|id))$/, reason: 'National ID / insurance number' },
]

function normalizeHeader(h: Cell): string {
  return String(h ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

export function detectIdentifier(header: Cell): string | undefined {
  const raw = String(header ?? '').trim()
  const n = normalizeHeader(header)
  for (const rule of IDENTIFIER_RULES) if (rule.re.test(n) || rule.re.test(raw)) return rule.reason
  return undefined
}

/** Parse a cell as an integer count. Returns undefined for non-integers / masked values. */
export function parseCount(cell: Cell): number | undefined {
  if (typeof cell === 'number') return Number.isInteger(cell) ? cell : undefined
  if (typeof cell !== 'string') return undefined
  const s = cell.trim().replace(/,/g, '')
  if (!/^-?\d+(\.0+)?$/.test(s)) return undefined
  return Number.parseInt(s, 10)
}

function isSmall(n: number | undefined, min: number): n is number {
  return n !== undefined && n > 0 && n < min
}

function compilePatterns(src?: string[]): RegExp[] {
  return (src ?? []).flatMap((p) => {
    try {
      return [new RegExp(p, 'i')]
    } catch {
      return []
    }
  })
}

/** Determine which column indexes hold counts. */
export function detectCountColumns(
  table: Table,
  extra: RegExp[] = [],
  explicit?: string[],
): { indexes: number[]; source: SheetSummary['countColumnSource'] } {
  const header = table[0] ?? []
  if (explicit) {
    const wanted = new Set(explicit.map((c) => normalizeHeader(c)))
    return { indexes: header.flatMap((h, i) => (wanted.has(normalizeHeader(h)) ? [i] : [])), source: 'specification' }
  }
  const hinted: number[] = []
  header.forEach((h, i) => {
    const n = normalizeHeader(h)
    if (!n) return
    if (extra.some((re) => re.test(n))) return hinted.push(i)
    if (NON_COUNT_HINT.test(n)) return
    if (COUNT_HINT.test(n)) hinted.push(i)
  })
  if (hinted.length > 0) return { indexes: hinted, source: 'name' }

  // Fallback (privacy-conservative): any all-integer column that does not look like an ID / code / date.
  const body = table.slice(1)
  const fallback: number[] = []
  header.forEach((h, i) => {
    const n = normalizeHeader(h)
    if (ID_LIKE.test(n) || NON_COUNT_HINT.test(n)) return
    let seen = 0
    for (const row of body) {
      const c = row[i]
      if (c === '' || c === null || c === undefined) continue
      if (parseCount(c) === undefined && !/^<\s*\d+$/.test(String(c).trim()) && String(c).trim().toUpperCase() !== 'NA') return
      seen++
    }
    if (seen > 0) fallback.push(i)
  })
  return { indexes: fallback, source: 'fallback' }
}

function auditTable(table: Table, sheet: string | undefined, min: number, extra: RegExp[], explicit?: string[]) {
  const findings: AuditFinding[] = []
  const header = table[0] ?? []
  header.forEach((h, i) => {
    const reason = detectIdentifier(h)
    if (reason) findings.push({ kind: 'identifier', sheet, column: String(h), columnIndex: i, reason })
  })
  const { indexes, source } = detectCountColumns(table, extra, explicit)
  let scanned = 0
  for (let r = 1; r < table.length; r++) {
    const row = table[r]
    for (const i of indexes) {
      scanned++
      const n = parseCount(row[i])
      if (isSmall(n, min)) findings.push({ kind: 'smallCell', sheet, row: r + 1, column: String(header[i] ?? `col${i + 1}`), columnIndex: i, value: n })
    }
  }
  const summary: SheetSummary = {
    sheet,
    rows: Math.max(0, table.length - 1),
    countColumns: indexes.map((i) => String(header[i] ?? `col${i + 1}`)),
    countColumnSource: source,
  }
  return { findings, scanned, summary }
}

function finalize(fileName: string, format: 'csv' | 'xlsx', min: number, parts: ReturnType<typeof auditTable>[]): AuditResult {
  const findings = parts.flatMap((p) => p.findings)
  const smallCellCount = findings.filter((f) => f.kind === 'smallCell').length
  const identifierCount = findings.filter((f) => f.kind === 'identifier').length
  return {
    fileName,
    format,
    minCellCount: min,
    scannedCells: parts.reduce((a, p) => a + p.scanned, 0),
    sheets: parts.map((p) => p.summary),
    smallCellCount,
    identifierCount,
    findings,
    passed: findings.length === 0,
    auditedAt: new Date().toISOString(),
  }
}

export function parseCsv(text: string): Table {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { header: false, skipEmptyLines: 'greedy' })
  return res.data
}

export function auditCsvText(text: string, fileName = 'results.csv', opts: AuditOptions = {}): AuditResult {
  const min = opts.minCellCount ?? DEFAULT_MIN_CELL_COUNT
  return finalize(fileName, 'csv', min, [auditTable(parseCsv(text), undefined, min, compilePatterns(opts.countColumnPatterns), opts.countColumns)])
}

function workbookTables(wb: XLSX.WorkBook): [string, Table][] {
  return wb.SheetNames.map((name) => [
    name,
    XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  ])
}

export function auditWorkbook(data: ArrayBuffer | Uint8Array, fileName = 'ScanReport.xlsx', opts: AuditOptions = {}): AuditResult {
  const min = opts.minCellCount ?? DEFAULT_MIN_CELL_COUNT
  const extra = compilePatterns(opts.countColumnPatterns)
  const wb = XLSX.read(data, { type: 'array' })
  return finalize(fileName, 'xlsx', min, workbookTables(wb).map(([name, t]) => auditTable(t, name, min, extra)))
}

export function maskValue(min: number, style: MaskStyle): string {
  return style === 'negative' ? `-${min}` : style === 'lt' ? `<${min}` : 'NA'
}

/** Returns column indexes to drop: identifier columns plus their paired WhiteRabbit "Frequency" column. */
function columnsToDrop(table: Table): Set<number> {
  const header = table[0] ?? []
  const drop = new Set<number>()
  header.forEach((h, i) => {
    if (!detectIdentifier(h)) return
    drop.add(i)
    if (/^frequency$/i.test(String(header[i + 1] ?? '').trim())) drop.add(i + 1)
  })
  return drop
}

function remediateTable(table: Table, min: number, style: MaskStyle, extra: RegExp[], explicit?: string[]): Table {
  const { indexes } = detectCountColumns(table, extra, explicit)
  const drop = columnsToDrop(table)
  const mask = maskValue(min, style)
  return table.map((row, r) => {
    const out = row.map((c, i) => (r > 0 && indexes.includes(i) && isSmall(parseCount(c), min) ? mask : c))
    return out.filter((_, i) => !drop.has(i))
  })
}

export function remediateCsvText(text: string, opts: AuditOptions = {}, style: MaskStyle = 'negative'): string {
  const min = opts.minCellCount ?? DEFAULT_MIN_CELL_COUNT
  const fixed = remediateTable(parseCsv(text), min, style, compilePatterns(opts.countColumnPatterns), opts.countColumns)
  return Papa.unparse(fixed as unknown[][], { newline: '\n' }) + '\n'
}

export function remediateWorkbook(data: ArrayBuffer | Uint8Array, opts: AuditOptions = {}, style: MaskStyle = 'negative'): ArrayBuffer {
  const min = opts.minCellCount ?? DEFAULT_MIN_CELL_COUNT
  const extra = compilePatterns(opts.countColumnPatterns)
  const wb = XLSX.read(data, { type: 'array' })
  const out = XLSX.utils.book_new()
  for (const [name, table] of workbookTables(wb)) {
    XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(remediateTable(table, min, style, extra)), name)
  }
  return XLSX.write(out, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}
