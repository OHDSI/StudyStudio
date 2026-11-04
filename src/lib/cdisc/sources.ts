/** Parsers for ETL-side artifacts feeding Define-XML: WhiteRabbit ScanReport and Rabbit-In-A-Hat mappings. */
import * as XLSX from 'xlsx'

export interface SourceField {
  name: string
  type?: string
  maxLength?: number
  description?: string
}

export interface SourceTable {
  name: string
  rows?: number
  fields: SourceField[]
}

export interface FieldMapping {
  sourceTable: string
  sourceField: string
  targetTable: string
  targetField: string
  logic?: string
  comment?: string
}

export interface MappingSpec {
  tableMaps: { sourceTable: string; targetTable: string; logic?: string }[]
  fieldMaps: FieldMapping[]
}

type Dict = Record<string, unknown>
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim())

/** Parse a WhiteRabbit ScanReport workbook. Uses the "Field Overview" sheet when present. */
export function parseScanReport(data: ArrayBuffer | Uint8Array): SourceTable[] {
  const wb = XLSX.read(data, { type: 'array' })
  const overviewName = wb.SheetNames.find((n) => /field\s*overview|^overview$/i.test(n))
  if (overviewName) {
    const rows = XLSX.utils.sheet_to_json<Dict>(wb.Sheets[overviewName], { defval: '' })
    const key = (row: Dict, re: RegExp) => Object.keys(row).find((k) => re.test(k.trim()))
    const tables = new Map<string, SourceTable>()
    for (const row of rows) {
      const tk = key(row, /^table$/i)
      const fk = key(row, /^field$/i)
      if (!tk || !fk) continue
      const tname = str(row[tk])
      const fname = str(row[fk])
      if (!tname || !fname) continue
      const t = tables.get(tname) ?? { name: tname, fields: [] }
      const nRows = Number(row[key(row, /^n\s*rows$/i) ?? ''])
      if (Number.isFinite(nRows) && nRows > 0) t.rows = nRows
      const maxLen = Number(row[key(row, /max\s*length/i) ?? ''])
      t.fields.push({
        name: fname,
        type: str(row[key(row, /^type$/i) ?? '']) || undefined,
        maxLength: Number.isFinite(maxLen) && maxLen > 0 ? maxLen : undefined,
        description: str(row[key(row, /description/i) ?? '']) || undefined,
      })
      tables.set(tname, t)
    }
    if (tables.size) return [...tables.values()]
  }
  // Fallback: each table sheet has a header of "<field> | Frequency | <field> | Frequency ...".
  return wb.SheetNames.filter((n) => !/overview|meta|^_/i.test(n)).map((name) => {
    const [header = []] = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '' })
    return {
      name,
      fields: header.map(str).filter((h) => h && !/^frequency$/i.test(h)).map((h) => ({ name: h })),
    }
  })
}

/**
 * Parse a mapping specification. Supports a flat format
 *   { mappings: [{ sourceTable, sourceField, targetTable, targetField, logic }] }
 * and Rabbit-In-A-Hat JSON, by walking the tree for {source, target} map objects.
 */
export function parseMappingSpec(input: unknown): MappingSpec {
  const spec: MappingSpec = { tableMaps: [], fieldMaps: [] }
  if (!input || typeof input !== 'object') return spec
  const flat = (input as Dict).mappings
  if (Array.isArray(flat)) {
    for (const m of flat as Dict[]) {
      if (m.sourceField || m.targetField)
        spec.fieldMaps.push({
          sourceTable: str(m.sourceTable),
          sourceField: str(m.sourceField),
          targetTable: str(m.targetTable),
          targetField: str(m.targetField),
          logic: str(m.logic) || undefined,
          comment: str(m.comment) || undefined,
        })
      else if (m.sourceTable && m.targetTable) spec.tableMaps.push({ sourceTable: str(m.sourceTable), targetTable: str(m.targetTable), logic: str(m.logic) || undefined })
    }
    return spec
  }
  const seen = new Set<string>()
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const o = node as Dict
    const src = o.source as Dict | undefined
    const tgt = o.target as Dict | undefined
    if (src && tgt && typeof src === 'object' && typeof tgt === 'object' && src.name && tgt.name) {
      const st = (src.table as Dict | undefined)?.name
      const tt = (tgt.table as Dict | undefined)?.name
      if (st && tt) {
        const k = `${st}.${src.name}->${tt}.${tgt.name}`
        if (!seen.has(k)) {
          seen.add(k)
          spec.fieldMaps.push({
            sourceTable: str(st),
            sourceField: str(src.name),
            targetTable: str(tt),
            targetField: str(tgt.name),
            logic: str(o.logic) || undefined,
            comment: str(o.comment) || undefined,
          })
        }
      } else {
        const k = `${src.name}->${tgt.name}`
        if (!seen.has(k)) {
          seen.add(k)
          spec.tableMaps.push({ sourceTable: str(src.name), targetTable: str(tgt.name), logic: str(o.logic) || undefined })
        }
      }
    }
    Object.values(o).forEach(walk)
  }
  walk(input)
  return spec
}
