/**
 * CDISC Define-XML builder for v2.1 (default) and v2.0 (native string builder, no network, no DOM).
 *
 *  analysisSpecifications.json  → def:WhereClauseDef per cohort (+ def:CommentDef / MethodDef with the CIRCE logic)
 *  Strategus result tables      → one ItemGroupDef per table, ItemDefs typed/described from the
 *                                 results data model specification (+ value-level metadata per cohort)
 *
 * define.xml describes the submitted datasets only. The site ETL (WhiteRabbit ScanReport, mapping
 * specification) is source-data lineage and is reported in the audit report, which define.xml references.
 *
 * The result datasets are not datasets of any CDISC standard. They are declared as non-standard
 * datasets of an ADaM submission:
 * v2.1: def:Standards names ADaMIG 1.3 and the CDISC/NCI ADaM terminology (validators require an IG and
 *       a CT standard), and every ItemGroupDef carries def:IsNonStandard="Yes".
 * v2.0: has no notion of non-standard datasets; ADaMIG 1.3 is named through def:StandardName /
 *       def:StandardVersion, which the schema requires, with the v2.0 spelling "ADaM-IG" (PMDA rejects
 *       "ADaMIG" there: Pinnacle 21 DD0021). Prefer v2.1.
 *
 * Names longer than 8 characters get an 8-character SASDatasetName / SASFieldName, unique within the
 * MetaDataVersion / dataset, as regulatory validators require; dataset files are named after the
 * SASDatasetName. Every dataset has the ADaM class "ADAM OTHER".
 *
 * Validators also report the declared standards as unreferenced (Pinnacle 21 DD0139): only a standard
 * dataset or a CDISC code list can reference one, and there are neither. That is inherent to declaring
 * non-standard datasets and is to be explained in the reviewer's guide.
 */
import { describeCohort } from '@/lib/codegen/circe'
import type { CombinedTable } from './datasetJson'
import { itemGroupOid, itemOid } from './datasetJson'

export interface DefineCohort {
  cohortId: number
  cohortName: string
  roles: string[]
  /** CIRCE expression, when available (subset cohorts have none). */
  expression?: Record<string, unknown>
}

export const DEFINE_XML_VERSIONS = ['2.1', '2.0'] as const
export type DefineXmlVersion = (typeof DEFINE_XML_VERSIONS)[number]

/** CDISC/NCI ADaM controlled terminology package declared in def:Standards (v2.1) unless one is given. */
export const DEFAULT_ADAM_CT_VERSION = '2026-03-27'

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
  /** Combined Strategus result tables; each is archived at the path given by datasetFiles(). */
  resultTables?: CombinedTable[]
  auditReportHref?: string
  /** Relative href of an XSLT stylesheet archived next to define.xml (adds an xml-stylesheet instruction). */
  stylesheetHref?: string
  /** CDISC/NCI ADaM CT package date (v2.1 def:Standards); default DEFAULT_ADAM_CT_VERSION. */
  ctVersion?: string
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

type DefineDataType = 'text' | 'integer' | 'float'

/**
 * An 8-character SAS name for `name`: kept as is when it fits, otherwise each underscore-separated
 * part contributes its first letters (CM_DIAGNOSTICS_SUMMARY → CMDIASUM). `taken` holds the names
 * already used in the same scope; a clash is resolved with a numeric suffix.
 */
export function sasName(name: string, taken: Set<string>): string {
  const clean = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  let base = clean
  if (base.length > 8) {
    const parts = clean.split('_').filter(Boolean)
    let budget = 8
    base = ''
    parts.forEach((p, i) => {
      const n = Math.max(1, Math.ceil(budget / (parts.length - i)))
      const piece = p.slice(0, n)
      base += piece
      budget -= piece.length
    })
    base = base.slice(0, 8)
  }
  if (!/^[A-Z_]/.test(base)) base = `V${base}`.slice(0, 8)
  let out = base
  for (let k = 1; taken.has(out); k++) out = `${base.slice(0, 8 - String(k).length)}${k}`
  taken.add(out)
  return out
}

/**
 * SASDatasetName and archive path of each result table. The file is named after the SAS dataset name
 * (datasets/<sasname>.json), as validators expect the def:leaf file name to equal SASDatasetName.
 */
export function datasetFiles(tables: { name: string }[]): Map<string, { sasName: string; path: string }> {
  const taken = new Set<string>()
  return new Map(
    tables.map((t) => {
      const n = sasName(t.name, taken)
      return [t.name, { sasName: n, path: `datasets/${n.toLowerCase()}.json` }]
    }),
  )
}

/** Digits after the decimal point needed to show every value of a numeric column (def SignificantDigits). */
export function significantDigits(values: unknown[]): number {
  let max = 0
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const m = String(v).match(/^-?\d*(?:\.(\d+))?(?:e([+-]\d+))?$/i)
    if (m) max = Math.max(max, (m[1]?.length ?? 0) - Number(m[2] ?? 0))
  }
  return max
}

interface ItemDef {
  oid: string
  name: string
  sasName: string
  dataType: DefineDataType
  length: number
  significantDigits?: number
  description: string
  origin: { type: 'Derived' | 'Assigned'; description?: string }
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
  sasName: string
  description: string
  structure: string
  leaf: { id: string; href: string; title: string }
  commentOid?: string
  refs: ItemRef[]
}

interface Method {
  oid: string
  name: string
  description: string
}

const COM_COHORTS = 'COM.COHORTS'
/** ADaM class for analysis datasets that follow none of the ADaM structures. */
const CLASS = 'ADAM OTHER'

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
  const fieldSasNames = new Map<string, Map<string, string>>()
  const fieldSas = (t: CombinedTable, column: string) => {
    if (!fieldSasNames.has(t.name)) fieldSasNames.set(t.name, new Map())
    const names = fieldSasNames.get(t.name)!
    if (!names.has(column)) names.set(column, sasName(column, new Set(names.values())))
    return names.get(column)!
  }

  // ---- Strategus result tables + cohort where clauses ----------------------
  const tables = input.resultTables ?? []
  const hasCohortId = (t: CombinedTable) => t.columns.some((c) => c.name === 'COHORT_ID')
  const cohortTable = tables.find((t) => t.sourceTable === 'cg_cohort_count' && hasCohortId(t)) ?? tables.find(hasCohortId)
  const countCol = cohortTable?.columns.find((c) => c.name === 'COHORT_SUBJECTS')
  const vlOid = cohortTable && countCol ? `VL.${cohortTable.name}.${countCol.name}` : undefined
  const lengthOf = (dataType: DefineDataType, length: number) => Math.min(dataType === 'text' ? 2000 : 32, Math.max(1, length))
  const typeOf = (c: CombinedTable['columns'][number]): DefineDataType => (c.dataType === 'string' ? 'text' : c.dataType === 'integer' ? 'integer' : 'float')

  // Cohorts are described through value-level metadata on the cohort count (one where clause, method
  // and comment per cohort). Without a cohort count table, a single comment lists them all and is
  // attached to the result datasets (or, in v2.1, to MetaDataVersion), so no definition is left unreferenced.
  const vlRefs: (ItemRef & { whereOid: string })[] = []
  const cohortTexts: string[] = []
  input.cohorts.forEach((c, i) => {
    const logic = c.expression ? describeCohort(c.expression) : 'Defined in the Strategus analysis specification (subset or non-CIRCE cohort).'
    const text = `Cohort ${c.cohortId} "${c.cohortName}"${c.roles.length ? ` (${c.roles.join(', ')})` : ''}. ${logic}`
    if (!cohortTable || !vlOid || !countCol) return cohortTexts.push(text)
    const com = `COM.COHORT.${c.cohortId}`
    comments.push({ oid: com, text })
    const wc = `WC.${cohortTable.name}.COHORT_ID.${c.cohortId}`
    whereClauses.push({ oid: wc, commentOid: com, itemOid: itemOid(cohortTable, 'COHORT_ID'), value: String(c.cohortId) })
    const mt = `MT.COHORT.${c.cohortId}`
    methods.set(mt, {
      oid: mt,
      name: `Cohort ${c.cohortId} subject count`,
      description: `Distinct persons in OMOP cohort ${c.cohortId} (${c.cohortName}) generated by the Strategus CohortGeneratorModule; values 0 < n < minCellCount are censored as -minCellCount. ${logic}`,
    })
    const itOid = `${itemOid(cohortTable, countCol.name)}.C${c.cohortId}`
    const dataType = typeOf(countCol)
    items.set(itOid, {
      oid: itOid,
      name: countCol.name,
      sasName: fieldSas(cohortTable, countCol.name),
      dataType,
      // A value-level slice is never longer than its parent variable.
      length: lengthOf(dataType, countCol.length),
      significantDigits: dataType === 'float' ? significantDigits(cohortTable.rows.map((r) => r[cohortTable.columns.indexOf(countCol)])) : undefined,
      description: `Subjects in cohort ${c.cohortId}: ${c.cohortName}`,
      origin: { type: 'Derived' },
    })
    vlRefs.push({ itemOid: itOid, order: i + 1, mandatory: false, methodOid: mt, whereOid: wc })
  })
  if (vlOid && vlRefs.length) valueLists.push({ oid: vlOid, refs: vlRefs })
  const cohortsComment = cohortTexts.length && (tables.length || !v20) ? COM_COHORTS : undefined
  if (cohortsComment) comments.push({ oid: cohortsComment, text: `Study cohorts. ${cohortTexts.join(' ')}` })

  const files = datasetFiles(tables)
  for (const t of tables) {
    const file = files.get(t.name)!
    const mt = `MT.${t.name}`
    methods.set(mt, {
      oid: mt,
      name: `Derivation of ${t.name}`,
      description: `Computed at each site by Strategus${t.module ? ` ${t.module}` : ''} (table ${t.sourceTable}) and exported with min-cell-count suppression; rows from adopted sites are concatenated with SITE_ID.`,
    })
    const keys = t.columns.filter((c) => c.primaryKey).map((c) => c.name)
    const refs: ItemRef[] = t.columns.map((c, i) => {
      const itOid = itemOid(t, c.name)
      const dataType = typeOf(c)
      items.set(itOid, {
        oid: itOid,
        name: c.name,
        sasName: fieldSas(t, c.name),
        dataType,
        length: lengthOf(dataType, c.length),
        significantDigits: dataType === 'float' ? significantDigits(t.rows.map((r) => r[i])) : undefined,
        description: c.description || c.name.replace(/_/g, ' ').toLowerCase(),
        origin:
          c.name === 'SITE_ID'
            ? { type: 'Assigned', description: 'Assigned from the StudyPack manifest siteId' }
            : { type: 'Derived', description: c.minCellCount ? 'Subject to min-cell-count suppression (censored values are reported as -minCellCount)' : undefined },
        valueListOid: t === cohortTable && c === countCol && valueLists.length ? vlOid : undefined,
      })
      const keySequence = c.primaryKey ? keys.indexOf(c.name) + 1 : undefined
      return { itemOid: itOid, order: i + 1, mandatory: !!c.primaryKey, keySequence, methodOid: c.name === 'SITE_ID' ? undefined : mt }
    })
    groups.push({
      oid: itemGroupOid(t),
      name: t.name,
      sasName: file.sasName,
      description: `${t.label} — ${t.rows.length} record(s)`,
      structure: keys.length ? `One record per ${keys.join(', ')}` : 'One record per site result row',
      leaf: { id: `LF.${t.name}`, href: file.path, title: file.path.slice('datasets/'.length) },
      commentOid: cohortsComment,
      refs,
    })
  }

  // ---- Serialize --------------------------------------------------------
  const L: string[] = []
  const auditLeaf = input.auditReportHref ? { id: 'LF.AUDIT_REPORT', href: input.auditReportHref } : undefined
  L.push('<?xml version="1.0" encoding="UTF-8"?>')
  if (input.stylesheetHref) L.push(`<?xml-stylesheet type="text/xsl" href="${xmlEscape(input.stylesheetHref)}"?>`)
  L.push(
    `<ODM xmlns="http://www.cdisc.org/ns/odm/v1.3" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:def="http://www.cdisc.org/ns/def/v${v20 ? '2.0' : '2.1'}"` +
      ` ODMVersion="1.3.2" FileType="Snapshot" FileOID="DEFINE.${oid(input.studyId)}" CreationDateTime="${now}"` +
      ` Originator="${xmlEscape(input.originator ?? 'OHDSI Study Studio')}" SourceSystem="OHDSI Study Studio" SourceSystemVersion="${xmlEscape(input.sourceSystemVersion)}"${v20 ? '' : ' def:Context="Submission"'}>`,
  )
  L.push(`  <Study OID="${studyOid}">`)
  L.push('    <GlobalVariables>')
  L.push(`      <StudyName>${xmlEscape(input.studyId)}</StudyName>`)
  L.push(`      <StudyDescription>${xmlEscape(input.description || input.studyTitle)}</StudyDescription>`)
  L.push(`      <ProtocolName>${xmlEscape(input.protocolName || input.studyTitle)}</ProtocolName>`)
  L.push('    </GlobalVariables>')
  L.push(
    `    <MetaDataVersion OID="${mdvOid}" Name="${xmlEscape(input.studyTitle)} — OMOP network study" Description="Generated from StudyPacks by OHDSI Study Studio" ` +
      `${v20 ? 'def:DefineVersion="2.0.0" def:StandardName="ADaM-IG" def:StandardVersion="1.3"' : 'def:DefineVersion="2.1.0"'}${cohortsComment && !tables.length ? ` def:CommentOID="${cohortsComment}"` : ''}>`,
  )
  if (!v20) {
    L.push('      <def:Standards>')
    L.push('        <def:Standard OID="STD.ADAMIG.1.3" Name="ADaMIG" Type="IG" Version="1.3" Status="Final"/>')
    L.push(`        <def:Standard OID="STD.CT.ADAM" Name="CDISC/NCI" Type="CT" PublishingSet="ADaM" Version="${xmlEscape(input.ctVersion ?? DEFAULT_ADAM_CT_VERSION)}" Status="Final"/>`)
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
      `      <ItemGroupDef OID="${g.oid}" Name="${xmlEscape(g.name)}" SASDatasetName="${g.sasName}" Repeating="Yes" IsReferenceData="No"` +
        ` Purpose="Analysis" def:Structure="${xmlEscape(g.structure)}"${v20 ? ` def:Class="${CLASS}"` : ' def:IsNonStandard="Yes"'}` +
        `${g.commentOid ? ` def:CommentOID="${g.commentOid}"` : ''} def:ArchiveLocationID="${g.leaf.id}">`,
    )
    L.push(tt(g.description, '        '))
    for (const r of g.refs)
      L.push(`        <ItemRef ItemOID="${r.itemOid}" OrderNumber="${r.order}" Mandatory="${r.mandatory ? 'Yes' : 'No'}"${r.keySequence ? ` KeySequence="${r.keySequence}"` : ''}${r.methodOid ? ` MethodOID="${r.methodOid}"` : ''}/>`)
    if (!v20) L.push(`        <def:Class Name="${CLASS}"/>`)
    L.push(`        <def:leaf ID="${g.leaf.id}" xlink:href="${xmlEscape(g.leaf.href)}">`)
    L.push(`          <def:title>${xmlEscape(g.leaf.title)}</def:title>`)
    L.push('        </def:leaf>')
    L.push('      </ItemGroupDef>')
  }
  for (const it of items.values()) {
    L.push(
      `      <ItemDef OID="${it.oid}" Name="${xmlEscape(it.name)}" SASFieldName="${it.sasName}" DataType="${it.dataType}" Length="${it.length}"` +
        `${it.significantDigits !== undefined ? ` SignificantDigits="${it.significantDigits}"` : ''}>`,
    )
    L.push(tt(it.description, '        '))
    if (it.valueListOid) L.push(`        <def:ValueListRef ValueListOID="${it.valueListOid}"/>`)
    if (it.origin.description) {
      L.push(`        <def:Origin Type="${it.origin.type}">`)
      L.push(tt(it.origin.description, '          '))
      L.push('        </def:Origin>')
    } else L.push(`        <def:Origin Type="${it.origin.type}"/>`)
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
