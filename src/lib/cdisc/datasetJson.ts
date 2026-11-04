/** CDISC Dataset-JSON (v1.1 or v1.0) serialization of the adopted sites' Strategus result tables. */
import { parseCsv } from '@/lib/audit/cellAuditor'
import type { RdmsColumn } from '@/lib/strategus/results'

export type DsjDataType = 'string' | 'integer' | 'double'

export const DATASET_JSON_VERSIONS = ['1.1', '1.0'] as const
export type DatasetJsonVersion = (typeof DATASET_JSON_VERSIONS)[number]

export interface DsjColumn {
  itemOID: string
  name: string
  label: string
  dataType: DsjDataType
  length?: number
  keySequence?: number
}

export interface DatasetJson11 {
  datasetJSONCreationDateTime: string
  datasetJSONVersion: '1.1.0'
  fileOID: string
  dbLastModifiedDateTime: string
  originator: string
  sourceSystem: { name: string; version: string }
  studyOID: string
  metaDataVersionOID: string
  metaDataRef: string
  itemGroupOID: string
  records: number
  name: string
  label: string
  columns: DsjColumn[]
  rows: (string | number | null)[][]
}

export interface CombinedColumn {
  name: string
  dataType: DsjDataType
  length: number
  description?: string
  primaryKey?: boolean
  /** Subject to min-cell-count suppression according to the results data model. */
  minCellCount?: boolean
}

export interface CombinedTable {
  /** Dataset name (upper case variable-style), e.g. CM_RESULT. */
  name: string
  /** Source Strategus table, e.g. cm_result. */
  sourceTable: string
  module: string
  label: string
  columns: CombinedColumn[]
  rows: (string | number | null)[][]
}

export function toVarName(s: string): string {
  const v = s.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  return /^[A-Z]/.test(v) ? v : `V_${v || 'X'}`
}

export const itemGroupOid = (t: { name: string }) => `IG.${t.name}`
export const itemOid = (t: { name: string }, column: string) => `IT.${t.name}.${column}`

const isNull = (v: string) => v === '' || /^(NA|NULL|NAN)$/i.test(v)

function rdmsType(t?: string): DsjDataType | undefined {
  if (!t) return undefined
  if (/^(int|integer|bigint|smallint|tinyint)$/.test(t)) return 'integer'
  if (/^(float|double|real|numeric|decimal)/.test(t)) return 'double'
  return 'string'
}

/**
 * Union one result table across adopted sites, prefixed with SITE_ID.
 * Column types come from the Strategus results data model when available, and are downgraded
 * to string if a site's values do not fit (e.g. "<5" masks).
 */
export function combineSiteCsvs(
  sites: { siteId: string; csv: string }[],
  meta: { sourceTable?: string; module?: string; label?: string; rdms?: RdmsColumn[] } = {},
): CombinedTable {
  const sourceTable = meta.sourceTable ?? 'aggregated_results'
  const rdmsByVar = new Map((meta.rdms ?? []).map((c) => [toVarName(c.name), c]))
  const names: string[] = ['SITE_ID']
  const parsed = sites.map((s) => {
    const [header = [], ...body] = parseCsv(s.csv)
    const vars = header.map((h) => toVarName(String(h)))
    vars.forEach((v) => !names.includes(v) && names.push(v))
    return { siteId: s.siteId, vars, body }
  })
  const raw: string[][] = []
  for (const p of parsed) {
    const siteCol = p.vars.indexOf('SITE_ID')
    for (const r of p.body) {
      raw.push(
        names.map((n) => {
          if (n === 'SITE_ID') return p.siteId
          const i = p.vars.indexOf(n)
          return i < 0 || i === siteCol ? '' : String(r[i] ?? '').trim()
        }),
      )
    }
  }
  const columns: CombinedColumn[] = names.map((name, ci) => {
    const vals = raw.map((r) => r[ci]).filter((v) => !isNull(v))
    const allInt = vals.length > 0 && vals.every((v) => /^-?\d+$/.test(v))
    const allNum = vals.length > 0 && vals.every((v) => Number.isFinite(Number(v)))
    const rd = rdmsByVar.get(name)
    let dataType: DsjDataType = 'string'
    if (name !== 'SITE_ID') {
      const declared = rdmsType(rd?.dataType)
      if (declared === 'integer') dataType = allInt || vals.length === 0 ? 'integer' : allNum ? 'double' : 'string'
      else if (declared === 'double') dataType = allNum || vals.length === 0 ? 'double' : 'string'
      else if (declared === 'string') dataType = 'string'
      else dataType = allInt ? 'integer' : allNum ? 'double' : 'string'
    }
    return {
      name,
      dataType,
      length: Math.max(1, ...vals.map((v) => v.length)),
      description: name === 'SITE_ID' ? 'Site identifier from the StudyPack manifest' : rd?.description,
      primaryKey: name === 'SITE_ID' || rd?.primaryKey,
      minCellCount: rd?.minCellCount,
    }
  })
  const rows = raw.map((r) => r.map((v, ci) => (isNull(v) ? null : columns[ci].dataType === 'string' ? v : Number(v))))
  return {
    name: toVarName(sourceTable),
    sourceTable,
    module: meta.module ?? '',
    label: meta.label ?? `${sourceTable}${meta.module ? ` (${meta.module})` : ''}`,
    columns,
    rows,
  }
}

export interface DatasetJsonOptions {
  studyOID: string
  metaDataVersionOID: string
  originator: string
  sourceVersion: string
  now?: Date
}

function columnMeta(table: CombinedTable) {
  let seq = 0
  return table.columns.map((c) => ({
    itemOID: itemOid(table, c.name),
    name: c.name,
    label: c.name.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase()),
    dataType: c.dataType,
    length: c.dataType === 'string' ? c.length : undefined,
    keySequence: c.primaryKey ? ++seq : undefined,
  }))
}

const timestamp = (now?: Date) => (now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '')

/** Dataset-JSON v1.1: flat top-level metadata with columns / rows. */
export function buildDatasetJson(table: CombinedTable, opts: DatasetJsonOptions): DatasetJson11 {
  const ts = timestamp(opts.now)
  return {
    datasetJSONCreationDateTime: ts,
    datasetJSONVersion: '1.1.0',
    fileOID: `${opts.studyOID}.${table.name}`,
    dbLastModifiedDateTime: ts,
    originator: opts.originator,
    sourceSystem: { name: 'Study Studio', version: opts.sourceVersion },
    studyOID: opts.studyOID,
    metaDataVersionOID: opts.metaDataVersionOID,
    metaDataRef: 'define.xml',
    itemGroupOID: itemGroupOid(table),
    records: table.rows.length,
    name: table.name,
    label: table.label,
    columns: columnMeta(table).map((c) => ({
      itemOID: c.itemOID,
      name: c.name,
      label: c.label,
      dataType: c.dataType,
      ...(c.length !== undefined ? { length: c.length } : {}),
      ...(c.keySequence !== undefined ? { keySequence: c.keySequence } : {}),
    })),
    rows: table.rows,
  }
}

export interface DatasetJson10 {
  creationDateTime: string
  datasetJSONVersion: '1.0.0'
  fileOID: string
  asOfDateTime: string
  originator: string
  sourceSystem: string
  sourceSystemVersion: string
  clinicalData: {
    studyOID: string
    metaDataVersionOID: string
    metaDataRef: string
    itemGroupData: Record<
      string,
      {
        records: number
        name: string
        label: string
        items: { OID: string; name: string; label: string; type: DsjDataType; length?: number; keySequence?: number }[]
        itemData: (string | number | null)[][]
      }
    >
  }
}

/** Dataset-JSON v1.0: data nested under clinicalData.itemGroupData, with the required ITEMGROUPDATASEQ column. */
export function buildDatasetJson10(table: CombinedTable, opts: DatasetJsonOptions): DatasetJson10 {
  const ts = timestamp(opts.now)
  return {
    creationDateTime: ts,
    datasetJSONVersion: '1.0.0',
    fileOID: `${opts.studyOID}.${table.name}`,
    asOfDateTime: ts,
    originator: opts.originator,
    sourceSystem: 'Study Studio',
    sourceSystemVersion: opts.sourceVersion,
    clinicalData: {
      studyOID: opts.studyOID,
      metaDataVersionOID: opts.metaDataVersionOID,
      metaDataRef: 'define.xml',
      itemGroupData: {
        [itemGroupOid(table)]: {
          records: table.rows.length,
          name: table.name,
          label: table.label,
          items: [
            { OID: 'ITEMGROUPDATASEQ', name: 'ITEMGROUPDATASEQ', label: 'Record identifier', type: 'integer' },
            ...columnMeta(table).map((c) => ({
              OID: c.itemOID,
              name: c.name,
              label: c.label,
              type: c.dataType,
              ...(c.length !== undefined ? { length: c.length } : {}),
              ...(c.keySequence !== undefined ? { keySequence: c.keySequence } : {}),
            })),
          ],
          itemData: table.rows.map((r, i) => [i + 1, ...r]),
        },
      },
    },
  }
}

export function serializeDatasetJson(version: DatasetJsonVersion, table: CombinedTable, opts: DatasetJsonOptions): string {
  return JSON.stringify(version === '1.0' ? buildDatasetJson10(table, opts) : buildDatasetJson(table, opts))
}
