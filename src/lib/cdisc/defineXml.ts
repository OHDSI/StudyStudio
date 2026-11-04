/**
 * CDISC Define-XML builder for v2.1 (default) and v2.0 (native string builder, no network, no DOM).
 *
 *  analysisSpecifications.json  → def:WhereClauseDef per cohort (+ def:CommentDef / MethodDef with the CIRCE logic)
 *  mapping_specification.json   → ItemDef with <def:Origin Type="Derived"> and MethodDef
 *  ScanReport.xlsx              → source-data ItemGroupDef / ItemDef
 *  Strategus result tables      → one ItemGroupDef per table, ItemDefs typed/described from the
 *                                 results data model specification (+ value-level metadata per cohort)
 *
 * v2.1: OMOP / source datasets are not CDISC-standard datasets, so every ItemGroupDef carries
 *       def:IsNonStandard="Yes"; def:Standards still lists the IG required by the schema.
 * v2.0: has no notion of non-standard datasets; the IG is declared through
 *       def:StandardName / def:StandardVersion on MetaDataVersion, and source-system fields use
 *       Origin Type="eDT" because "Collected" was introduced in v2.1.
 */
import { describeCohort } from '@/lib/codegen/circe'
import type { CombinedTable } from './datasetJson'
import { itemGroupOid, itemOid, toVarName } from './datasetJson'
import type { MappingSpec, SourceTable } from './sources'

export interface DefineCohort {
  cohortId: number
  cohortName: string
  roles: string[]
  /** CIRCE expression, when available (subset cohorts have none). */
  expression?: Record<string, unknown>
}

export const DEFINE_XML_VERSIONS = ['2.1', '2.0'] as const
export type DefineXmlVersion = (typeof DEFINE_XML_VERSIONS)[number]

export interface DefineInput {
  /** Define-XML version to emit (default v2.1). */
  version?: DefineXmlVersion
  studyId: string
  studyTitle: string
  description?: string
  protocolName?: string
  originator?: string
  sourceSystemVersion: string
  cohorts: DefineCohort[]
  /** Combined Strategus result tables; each is archived at datasets/<sourceTable>.json. */
  resultTables?: CombinedTable[]
  scanTables?: SourceTable[]
  mapping?: MappingSpec
  auditReportHref?: string
  now?: Date
}

export function xmlEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip characters not allowed in XML 1.0.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

const oid = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_')
const tt = (text: string, indent: string) =>
  `${indent}<Description>\n${indent}  <TranslatedText xml:lang="en">${xmlEscape(text)}</TranslatedText>\n${indent}</Description>`

type DefineDataType = 'text' | 'integer' | 'float' | 'date' | 'datetime'

export function mapSourceType(t?: string): DefineDataType {
  const s = (t ?? '').toLowerCase()
  if (/^(int|integer|bigint|smallint|tinyint|serial|bigserial)/.test(s)) return 'integer'
  if (/(numeric|decimal|float|double|real|number|money)/.test(s)) return 'float'
  if (/timestamp|datetime/.test(s)) return 'datetime'
  if (/^date$/.test(s)) return 'date'
  return 'text'
}

interface ItemDef {
  oid: string
  name: string
  dataType: DefineDataType
  length?: number
  description: string
  origin?: { type: 'Collected' | 'eDT' | 'Derived' | 'Assigned'; description?: string }
  valueListOid?: string
}

interface ItemRef {
  itemOid: string
  order: number
  mandatory: boolean
  methodOid?: string
  keySequence?: number
}

interface ItemGroup {
  oid: string
  name: string
  description: string
  purpose: 'Tabulation' | 'Analysis'
  structure: string
  className?: string
  leaf?: { id: string; href: string; title: string }
  refs: ItemRef[]
}

interface Method {
  oid: string
  name: string
  description: string
}

export function buildDefineXml(input: DefineInput): string {
  const v20 = input.version === '2.0'
  const now = (input.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '')
  const studyOid = `STUDY.${oid(input.studyId)}`
  const mdvOid = `MDV.${oid(input.studyId)}.1`

  const groups: ItemGroup[] = []
  const items = new Map<string, ItemDef>()
  const methods = new Map<string, Method>()
  const comments: { oid: string; text: string }[] = []
  const whereClauses: { oid: string; commentOid: string; itemOid: string; value: string }[] = []
  const valueLists: { oid: string; refs: (ItemRef & { whereOid: string })[] }[] = []
  const addItem = (d: ItemDef) => {
    if (!items.has(d.oid)) items.set(d.oid, d)
  }

  // ---- Strategus result tables + cohort where clauses ----------------------
  const tables = input.resultTables ?? []
  const hasCohortId = (t: CombinedTable) => t.columns.some((c) => c.name === 'COHORT_ID')
  const cohortTable = tables.find((t) => t.sourceTable === 'cg_cohort_count' && hasCohortId(t)) ?? tables.find(hasCohortId)
  const countVar = cohortTable?.columns.find((c) => c.name === 'COHORT_SUBJECTS')?.name
  const vlOid = cohortTable && countVar ? `VL.${cohortTable.name}.${countVar}` : undefined

  const vlRefs: (ItemRef & { whereOid: string })[] = []
  input.cohorts.forEach((c, i) => {
    const com = `COM.COHORT.${c.cohortId}`
    const logic = c.expression ? describeCohort(c.expression) : 'Defined in the Strategus analysis specification (subset or non-CIRCE cohort).'
    comments.push({ oid: com, text: `Cohort ${c.cohortId} "${c.cohortName}"${c.roles.length ? ` (${c.roles.join(', ')})` : ''}. ${logic}` })
    if (!cohortTable) return
    const wc = `WC.${cohortTable.name}.COHORT_ID.${c.cohortId}`
    whereClauses.push({ oid: wc, commentOid: com, itemOid: itemOid(cohortTable, 'COHORT_ID'), value: String(c.cohortId) })
    if (vlOid && countVar) {
      const mt = `MT.COHORT.${c.cohortId}`
      methods.set(mt, {
        oid: mt,
        name: `Cohort ${c.cohortId} subject count`,
        description: `Distinct persons in OMOP cohort ${c.cohortId} (${c.cohortName}) generated by the Strategus CohortGeneratorModule; values 0 < n < minCellCount are censored as -minCellCount. ${logic}`,
      })
      const itOid = `${itemOid(cohortTable, countVar)}.C${c.cohortId}`
      addItem({ oid: itOid, name: countVar, dataType: 'integer', length: 12, description: `Subjects in cohort ${c.cohortId}: ${c.cohortName}`, origin: { type: 'Derived' } })
      vlRefs.push({ itemOid: itOid, order: i + 1, mandatory: false, methodOid: mt, whereOid: wc })
    }
  })
  if (vlOid && vlRefs.length) valueLists.push({ oid: vlOid, refs: vlRefs })

  for (const t of tables) {
    const mt = `MT.${t.name}`
    methods.set(mt, {
      oid: mt,
      name: `Derivation of ${t.name}`,
      description: `Computed at each site by Strategus${t.module ? ` ${t.module}` : ''} (table ${t.sourceTable}) and exported with min-cell-count suppression; rows from adopted sites are concatenated with SITE_ID.`,
    })
    const keys = t.columns.filter((c) => c.primaryKey).map((c) => c.name)
    const refs: ItemRef[] = t.columns.map((c, i) => {
      const itOid = itemOid(t, c.name)
      const dataType: DefineDataType = c.dataType === 'string' ? 'text' : c.dataType === 'integer' ? 'integer' : 'float'
      addItem({
        oid: itOid,
        name: c.name,
        dataType,
        length: Math.min(dataType === 'text' ? 2000 : 32, Math.max(1, c.length)),
        description: c.description || c.name.replace(/_/g, ' ').toLowerCase(),
        origin:
          c.name === 'SITE_ID'
            ? { type: 'Assigned', description: 'Assigned from the StudyPack manifest siteId' }
            : { type: 'Derived', description: c.minCellCount ? 'Subject to min-cell-count suppression (censored values are reported as -minCellCount)' : undefined },
        valueListOid: t === cohortTable && c.name === countVar && valueLists.length ? vlOid : undefined,
      })
      return { itemOid: itOid, order: i + 1, mandatory: !!c.primaryKey, methodOid: c.name === 'SITE_ID' ? undefined : mt }
    })
    groups.push({
      oid: itemGroupOid(t),
      name: t.name,
      description: `${t.label} — ${t.rows.length} record(s)`,
      purpose: 'Analysis',
      structure: keys.length ? `One record per ${keys.join(', ')}` : 'One record per site result row',
      leaf: { id: `LF.${t.name}`, href: `datasets/${t.sourceTable}.json`, title: `${t.sourceTable}.json` },
      refs,
    })
  }

  // ---- Source data (WhiteRabbit ScanReport) -------------------------------
  for (const t of input.scanTables ?? []) {
    const gName = toVarName(`SRC_${t.name.replace(/\.[a-z]+$/i, '')}`)
    const refs = t.fields.map((f, i) => {
      const itOid = `IT.${gName}.${toVarName(f.name)}`
      const dataType = mapSourceType(f.type)
      addItem({
        oid: itOid,
        name: toVarName(f.name),
        dataType,
        length: dataType === 'text' || dataType === 'integer' || dataType === 'float' ? Math.min(2000, f.maxLength ?? (dataType === 'text' ? 200 : 8)) : undefined,
        description: f.description || `${t.name}.${f.name}${f.type ? ` (${f.type})` : ''}`,
        origin: { type: v20 ? 'eDT' : 'Collected', description: `Source system field ${t.name}.${f.name} profiled by WhiteRabbit` },
      })
      return { itemOid: itOid, order: i + 1, mandatory: false }
    })
    if (refs.length)
      groups.push({
        oid: `IG.${gName}`,
        name: gName,
        description: `Source table ${t.name}${t.rows ? ` (${t.rows} rows profiled)` : ''} — WhiteRabbit ScanReport`,
        purpose: 'Tabulation',
        structure: 'As profiled in source system',
        refs,
      })
  }

  // ---- ETL mapping (Rabbit-In-A-Hat) → OMOP CDM target tables -------------
  const byTarget = new Map<string, MappingSpec['fieldMaps']>()
  for (const m of input.mapping?.fieldMaps ?? []) {
    if (!m.targetTable || !m.targetField) continue
    byTarget.set(m.targetTable, [...(byTarget.get(m.targetTable) ?? []), m])
  }
  for (const [table, maps] of byTarget) {
    const gName = toVarName(`CDM_${table}`)
    const fields = new Map<string, MappingSpec['fieldMaps']>()
    maps.forEach((m) => fields.set(m.targetField, [...(fields.get(m.targetField) ?? []), m]))
    const refs: ItemRef[] = [...fields.entries()].map(([field, fm], i) => {
      const itOid = `IT.${gName}.${toVarName(field)}`
      const mt = `MT.${gName}.${toVarName(field)}`
      const text = fm
        .map((m) => `${m.sourceTable}.${m.sourceField} → ${table}.${field}${m.logic ? `: ${m.logic}` : ' (direct copy)'}${m.comment ? ` [${m.comment}]` : ''}`)
        .join('; ')
      methods.set(mt, { oid: mt, name: `ETL ${table}.${field}`, description: text })
      addItem({
        oid: itOid,
        name: toVarName(field),
        dataType: /(_id|_concept_id)$/i.test(field) ? 'integer' : /_datetime$/i.test(field) ? 'datetime' : /_date$/i.test(field) ? 'date' : 'text',
        length: /(_id)$/i.test(field) ? 20 : /_date/i.test(field) ? undefined : 200,
        description: `OMOP CDM ${table}.${field}`,
        origin: { type: 'Derived', description: `Derived by ETL from ${fm.map((m) => `${m.sourceTable}.${m.sourceField}`).join(', ')}` },
      })
      return { itemOid: itOid, order: i + 1, mandatory: false, methodOid: mt }
    })
    const tableLogic = input.mapping?.tableMaps.filter((t) => t.targetTable === table).map((t) => t.sourceTable)
    groups.push({
      oid: `IG.${gName}`,
      name: gName,
      description: `OMOP CDM table ${table}${tableLogic?.length ? ` populated from ${tableLogic.join(', ')}` : ''}`,
      purpose: 'Tabulation',
      structure: 'OMOP CDM',
      refs,
    })
  }

  // ---- Serialize --------------------------------------------------------
  const L: string[] = []
  const auditLeaf = input.auditReportHref ? { id: 'LF.AUDIT_REPORT', href: input.auditReportHref } : undefined
  L.push('<?xml version="1.0" encoding="UTF-8"?>')
  L.push(
    `<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:def="http://www.cdisc.org/ns/def/v${v20 ? '2.0' : '2.1'}"` +
      ` ODMVersion="1.3.2" FileType="Snapshot" FileOID="DEFINE.${oid(input.studyId)}" CreationDateTime="${now}"` +
      ` Originator="${xmlEscape(input.originator ?? 'Study Studio')}" SourceSystem="Study Studio" SourceSystemVersion="${xmlEscape(input.sourceSystemVersion)}"${v20 ? '' : ' def:Context="Submission"'}>`,
  )
  L.push(`  <Study OID="${studyOid}">`)
  L.push('    <GlobalVariables>')
  L.push(`      <StudyName>${xmlEscape(input.studyId)}</StudyName>`)
  L.push(`      <StudyDescription>${xmlEscape(input.description || input.studyTitle)}</StudyDescription>`)
  L.push(`      <ProtocolName>${xmlEscape(input.protocolName || input.studyTitle)}</ProtocolName>`)
  L.push('    </GlobalVariables>')
  L.push(`    <MetaDataVersion OID="${mdvOid}" Name="${xmlEscape(input.studyTitle)} — OMOP network study" Description="Generated from OHDSI StudyPacks by Study Studio" ${v20 ? 'def:DefineVersion="2.0.0" def:StandardName="ADaMIG" def:StandardVersion="1.3"' : 'def:DefineVersion="2.1.0"'}>`)
  if (!v20) {
    L.push('      <def:Standards>')
    L.push('        <def:Standard OID="STD.ADAMIG.1.3" Name="ADaMIG" Type="IG" Version="1.3" Status="Final"/>')
    L.push('      </def:Standards>')
  }
  if (auditLeaf) {
    L.push('      <def:SupplementalDoc>')
    L.push(`        <def:DocumentRef leafID="${auditLeaf.id}"/>`)
    L.push('      </def:SupplementalDoc>')
  }
  for (const vl of valueLists) {
    L.push(`      <def:ValueListDef OID="${vl.oid}">`)
    for (const r of vl.refs) {
      L.push(`        <ItemRef ItemOID="${r.itemOid}" OrderNumber="${r.order}" Mandatory="${r.mandatory ? 'Yes' : 'No'}"${r.methodOid ? ` MethodOID="${r.methodOid}"` : ''}>`)
      L.push(`          <def:WhereClauseRef WhereClauseOID="${r.whereOid}"/>`)
      L.push('        </ItemRef>')
    }
    L.push('      </def:ValueListDef>')
  }
  for (const w of whereClauses) {
    L.push(`      <def:WhereClauseDef OID="${w.oid}" def:CommentOID="${w.commentOid}">`)
    L.push(`        <RangeCheck Comparator="EQ" SoftHard="Soft" def:ItemOID="${w.itemOid}">`)
    L.push(`          <CheckValue>${xmlEscape(w.value)}</CheckValue>`)
    L.push('        </RangeCheck>')
    L.push('      </def:WhereClauseDef>')
  }
  for (const g of groups) {
    L.push(
      `      <ItemGroupDef OID="${g.oid}" Name="${xmlEscape(g.name)}" Repeating="Yes" IsReferenceData="No"` +
        ` Purpose="${g.purpose}" def:Structure="${xmlEscape(g.structure)}"${v20 ? '' : ' def:IsNonStandard="Yes"'}${g.leaf ? ` def:ArchiveLocationID="${g.leaf.id}"` : ''}>`,
    )
    L.push(tt(g.description, '        '))
    for (const r of g.refs)
      L.push(`        <ItemRef ItemOID="${r.itemOid}" OrderNumber="${r.order}" Mandatory="${r.mandatory ? 'Yes' : 'No'}"${r.methodOid ? ` MethodOID="${r.methodOid}"` : ''}/>`)
    if (g.leaf) {
      L.push(`        <def:leaf ID="${g.leaf.id}" xlink:href="${xmlEscape(g.leaf.href)}">`)
      L.push(`          <def:title>${xmlEscape(g.leaf.title)}</def:title>`)
      L.push('        </def:leaf>')
    }
    L.push('      </ItemGroupDef>')
  }
  for (const it of items.values()) {
    L.push(`      <ItemDef OID="${it.oid}" Name="${xmlEscape(it.name)}" DataType="${it.dataType}"${it.length ? ` Length="${it.length}"` : ''}>`)
    L.push(tt(it.description, '        '))
    if (it.valueListOid) L.push(`        <def:ValueListRef ValueListOID="${it.valueListOid}"/>`)
    if (it.origin) {
      if (it.origin.description) {
        L.push(`        <def:Origin Type="${it.origin.type}">`)
        L.push(tt(it.origin.description, '          '))
        L.push('        </def:Origin>')
      } else L.push(`        <def:Origin Type="${it.origin.type}"/>`)
    }
    L.push('      </ItemDef>')
  }
  for (const m of methods.values()) {
    L.push(`      <MethodDef OID="${m.oid}" Name="${xmlEscape(m.name)}" Type="Computation">`)
    L.push(tt(m.description, '        '))
    L.push('      </MethodDef>')
  }
  for (const c of comments) {
    L.push(`      <def:CommentDef OID="${c.oid}">`)
    L.push(tt(c.text, '        '))
    L.push('      </def:CommentDef>')
  }
  if (auditLeaf) {
    L.push(`      <def:leaf ID="${auditLeaf.id}" xlink:href="${xmlEscape(auditLeaf.href)}">`)
    L.push('        <def:title>Network integrity &amp; privacy audit report</def:title>')
    L.push('      </def:leaf>')
  }
  L.push('    </MetaDataVersion>')
  L.push('  </Study>')
  L.push('</ODM>')
  return L.join('\n') + '\n'
}
