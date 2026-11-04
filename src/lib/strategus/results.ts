/**
 * Strategus results folder handling.
 *
 * Layout written by Strategus::execute() (and zipped by Strategus::zipResults()):
 *   <ModuleName>/<table>.csv
 *   <ModuleName>/resultsDataModelSpecification.csv   (table_name, column_name, data_type, ..., min_cell_count, ..., description)
 *   DatabaseMetaData/database_meta_data.csv
 *
 * The results data model specification (RDMS) tells us exactly which columns are subject to
 * min-cell-count suppression, so the audit does not have to guess from column names.
 */
import JSZip from 'jszip'
import Papa from 'papaparse'
import { auditCsvText, type AuditOptions, type AuditResult } from '@/lib/audit/cellAuditor'

export const RDMS_FILE = 'resultsDataModelSpecification.csv'

export interface RdmsColumn {
  name: string
  dataType: string
  required: boolean
  primaryKey: boolean
  minCellCount: boolean
  description?: string
}

/** table name → columns */
export type Rdms = Map<string, RdmsColumn[]>

const yes = (v: unknown) => /^(yes|true|1)$/i.test(String(v ?? '').trim())

export function parseRdms(text: string): Rdms {
  const res = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' })
  const out: Rdms = new Map()
  for (const row of res.data) {
    const key = (re: RegExp) => Object.keys(row).find((k) => re.test(k.trim()))
    const table = String(row[key(/^table_?name$/i) ?? ''] ?? '').trim()
    const column = String(row[key(/^column_?name$/i) ?? ''] ?? '').trim()
    if (!table || !column) continue
    const cols = out.get(table) ?? []
    cols.push({
      name: column,
      dataType: String(row[key(/^data_?type$/i) ?? ''] ?? '').trim().toLowerCase(),
      required: yes(row[key(/^is_?required$/i) ?? '']),
      primaryKey: yes(row[key(/^primary_?key$/i) ?? '']),
      minCellCount: yes(row[key(/^min_?cell_?count$/i) ?? '']),
      description: String(row[key(/^description$/i) ?? ''] ?? '').trim() || undefined,
    })
    out.set(table, cols)
  }
  return out
}

const INTEGER_TYPES = /^(int|integer|bigint|smallint|tinyint)$/

/** Integer columns flagged min_cell_count = Yes (float means are censored by HADES too, but cannot be 0<n<k checked). */
export function rdmsCountColumns(rdms: Rdms, table: string): string[] | undefined {
  const cols = rdms.get(table)
  if (!cols) return undefined
  return cols.filter((c) => c.minCellCount && INTEGER_TYPES.test(c.dataType)).map((c) => c.name)
}

/** Normalize an archive path to "<ModuleName>/<file>.csv" relative to the results root. */
export function normalizeResultPaths(paths: string[]): Map<string, string> {
  const csv = paths.filter((p) => /\.csv$/i.test(p) && !p.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('.')))
  // The results root is the deepest common prefix that still leaves "<Module>/<file>.csv".
  const depthOfModule = (p: string) => p.split('/').length - 2
  const minDepth = Math.min(...csv.map(depthOfModule))
  const out = new Map<string, string>()
  for (const p of csv) {
    const parts = p.split('/')
    const rel = parts.slice(Math.max(0, minDepth)).join('/')
    out.set(p, rel.includes('/') ? rel : `_root/${rel}`)
  }
  return out
}

export interface ResultFile {
  /** Path relative to the results root, e.g. "CohortMethodModule/cm_result.csv". */
  path: string
  bytes: Uint8Array
}

/** Read a Strategus results ZIP (Strategus::zipResults output) in memory. */
export async function readResultsZip(data: ArrayBuffer | Uint8Array): Promise<ResultFile[]> {
  const zip = await JSZip.loadAsync(data)
  const entries = Object.entries(zip.files).filter(([p, e]) => !e.dir && !p.includes('..'))
  const map = normalizeResultPaths(entries.map(([p]) => p))
  const out: ResultFile[] = []
  for (const [p, e] of entries) {
    const rel = map.get(p)
    if (rel) out.push({ path: rel, bytes: await e.async('uint8array') })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Files chosen with a directory picker (File.webkitRelativePath) or dropped individually. */
export function resultFilesFromList(files: { name: string; bytes: Uint8Array }[]): ResultFile[] {
  const map = normalizeResultPaths(files.map((f) => f.name))
  return files.flatMap((f) => (map.has(f.name) ? [{ path: map.get(f.name)!, bytes: f.bytes }] : [])).sort((a, b) => a.path.localeCompare(b.path))
}

export const tableNameOf = (path: string) => path.split('/').pop()!.replace(/\.csv$/i, '')
export const moduleOf = (path: string) => (path.includes('/') ? path.split('/')[0] : '_root')

/** RDMS per module folder. */
export function collectRdms(files: ResultFile[]): Map<string, Rdms> {
  const dec = new TextDecoder()
  const out = new Map<string, Rdms>()
  for (const f of files) if (f.path.endsWith('/' + RDMS_FILE)) out.set(moduleOf(f.path), parseRdms(dec.decode(f.bytes)))
  return out
}

/** Audit options for one results file, using its module's RDMS when it covers the table. */
export function auditOptionsFor(path: string, rdmsByModule: Map<string, Rdms>, base: AuditOptions): AuditOptions {
  if (path.endsWith('/' + RDMS_FILE)) return { ...base, countColumns: [] } // metadata, no data cells
  const rdms = rdmsByModule.get(moduleOf(path))
  const cols = rdms ? rdmsCountColumns(rdms, tableNameOf(path)) : undefined
  return cols ? { ...base, countColumns: cols } : base
}

export function auditResultFiles(files: ResultFile[], base: AuditOptions): Map<string, AuditResult> {
  const rdms = collectRdms(files)
  const dec = new TextDecoder()
  const out = new Map<string, AuditResult>()
  for (const f of files) out.set(f.path, auditCsvText(dec.decode(f.bytes), f.path, auditOptionsFor(f.path, rdms, base)))
  return out
}

export interface ResultsAuditSummary {
  files: number
  passed: boolean
  scannedCells: number
  smallCellCount: number
  identifierCount: number
  failing: { path: string; smallCellCount: number; identifierCount: number }[]
}

export function summarizeResultsAudit(audits: Map<string, AuditResult>): ResultsAuditSummary {
  const all = [...audits.entries()]
  const failing = all.filter(([, a]) => !a.passed).map(([path, a]) => ({ path, smallCellCount: a.smallCellCount, identifierCount: a.identifierCount }))
  return {
    files: all.length,
    passed: failing.length === 0,
    scannedCells: all.reduce((n, [, a]) => n + a.scannedCells, 0),
    smallCellCount: all.reduce((n, [, a]) => n + a.smallCellCount, 0),
    identifierCount: all.reduce((n, [, a]) => n + a.identifierCount, 0),
    failing,
  }
}
