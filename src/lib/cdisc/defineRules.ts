/**
 * Conformance checks for the define.xml this tool writes, beyond what the XSD can express.
 *
 * They follow the Define-XML 2.0 / 2.1 specifications and the kind of issues a submission validator
 * (e.g. Pinnacle 21) reports: dangling or unused definitions, derived variables without a method,
 * missing descriptions, inconsistent lengths, and datasets that do not match their metadata.
 * The rule IDs are this project's own; passing these checks does not mean a validator reports nothing.
 *
 * Used by the tests (fast-xml-parser is a dev dependency); not part of the app bundle.
 */
import { XMLParser } from 'fast-xml-parser'

export interface DefineIssue {
  rule: string
  /** OID (or other identifier) of the element concerned. */
  target: string
  message: string
}

type El = Record<string, unknown>
const REPEATED = new Set([
  'ItemGroupDef', 'ItemDef', 'ItemRef', 'MethodDef', 'def:CommentDef', 'def:WhereClauseDef', 'def:ValueListDef',
  'def:leaf', 'RangeCheck', 'CheckValue', 'TranslatedText', 'def:WhereClauseRef', 'def:DocumentRef', 'def:Standard',
])
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', isArray: (name) => REPEATED.has(name), parseAttributeValue: false, parseTagValue: false })

const list = (v: unknown): El[] => (Array.isArray(v) ? (v as El[]) : v ? [v as El] : [])
const attr = (e: El, name: string) => (e[`@${name}`] as string | undefined) ?? undefined
const text = (e: El | undefined): string => {
  if (!e) return ''
  const tt = list((e.Description as El | undefined)?.TranslatedText)
  return tt.map((t) => (typeof t === 'string' ? t : String((t as El)['#text'] ?? ''))).join(' ').trim()
}

const DATA_TYPES_WITH_LENGTH = new Set(['text', 'integer', 'float'])
const DATA_TYPES_WITHOUT_LENGTH = new Set(['date', 'datetime', 'time', 'partialDate', 'partialTime', 'partialDatetime', 'incompleteDatetime', 'durationDatetime', 'intervalDatetime'])
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/

export function checkDefineXml(xml: string): DefineIssue[] {
  const issues: DefineIssue[] = []
  const add = (rule: string, target: string, message: string) => issues.push({ rule, target, message })
  const doc = parser.parse(xml) as El
  const mdv = ((doc.ODM as El)?.Study as El)?.MetaDataVersion as El | undefined
  if (!mdv) return [{ rule: 'SS-DEF-001', target: 'ODM', message: 'No Study/MetaDataVersion' }]
  const v21 = attr(mdv, 'def:DefineVersion') === '2.1.0'

  const groups = list(mdv.ItemGroupDef)
  const items = list(mdv.ItemDef)
  const methods = list(mdv.MethodDef)
  const comments = list(mdv['def:CommentDef'])
  const wheres = list(mdv['def:WhereClauseDef'])
  const valueLists = list(mdv['def:ValueListDef'])
  const mdvLeaves = list(mdv['def:leaf'])
  const groupLeaves = groups.flatMap((g) => list(g['def:leaf']))

  // OIDs are unique per element type.
  const byType: [string, El[], string][] = [
    ['ItemGroupDef', groups, 'OID'], ['ItemDef', items, 'OID'], ['MethodDef', methods, 'OID'], ['def:CommentDef', comments, 'OID'],
    ['def:WhereClauseDef', wheres, 'OID'], ['def:ValueListDef', valueLists, 'OID'], ['def:leaf', [...mdvLeaves, ...groupLeaves], 'ID'],
  ]
  for (const [type, els, key] of byType) {
    const seen = new Set<string>()
    for (const e of els) {
      const id = attr(e, key) ?? ''
      if (seen.has(id)) add('SS-DEF-002', id, `Duplicate ${type} ${key}`)
      seen.add(id)
    }
  }

  const itemById = new Map(items.map((i) => [attr(i, 'OID')!, i]))
  const allRefs: { ref: El; owner: string }[] = [
    ...groups.flatMap((g) => list(g.ItemRef).map((ref) => ({ ref, owner: attr(g, 'OID')! }))),
    ...valueLists.flatMap((vl) => list(vl.ItemRef).map((ref) => ({ ref, owner: attr(vl, 'OID')! }))),
  ]

  // Every reference resolves.
  const resolve = (kind: string, ids: Set<string>, ref: string | undefined, from: string) => {
    if (ref !== undefined && !ids.has(ref)) add('SS-DEF-003', from, `${kind} "${ref}" is not defined`)
  }
  const methodIds = new Set(methods.map((m) => attr(m, 'OID')!))
  const commentIds = new Set(comments.map((c) => attr(c, 'OID')!))
  const whereIds = new Set(wheres.map((w) => attr(w, 'OID')!))
  const vlIds = new Set(valueLists.map((v) => attr(v, 'OID')!))
  const leafIds = new Set([...mdvLeaves, ...groupLeaves].map((l) => attr(l, 'ID')!))
  const used = { item: new Set<string>(), method: new Set<string>(), comment: new Set<string>(), where: new Set<string>(), vl: new Set<string>(), leaf: new Set<string>() }
  const useComment = (e: El, from: string) => {
    const c = attr(e, 'def:CommentOID')
    resolve('def:CommentOID', commentIds, c, from)
    if (c) used.comment.add(c)
  }
  useComment(mdv, 'MetaDataVersion')
  for (const { ref, owner } of allRefs) {
    const io = attr(ref, 'ItemOID')!
    resolve('ItemOID', new Set(itemById.keys()), io, owner)
    used.item.add(io)
    const mo = attr(ref, 'MethodOID')
    resolve('MethodOID', methodIds, mo, `${owner}/${io}`)
    if (mo) used.method.add(mo)
    for (const w of list(ref['def:WhereClauseRef'])) {
      const wo = attr(w, 'WhereClauseOID')
      resolve('WhereClauseOID', whereIds, wo, `${owner}/${io}`)
      if (wo) used.where.add(wo)
    }
  }
  for (const g of groups) {
    const go = attr(g, 'OID')!
    useComment(g, go)
    const al = attr(g, 'def:ArchiveLocationID')
    resolve('def:ArchiveLocationID', leafIds, al, go)
    if (al) used.leaf.add(al)
  }
  for (const i of items) {
    const io = attr(i, 'OID')!
    useComment(i, io)
    const vl = (i['def:ValueListRef'] as El | undefined) && attr(i['def:ValueListRef'] as El, 'ValueListOID')
    resolve('ValueListOID', vlIds, vl, io)
    if (vl) used.vl.add(vl)
  }
  for (const w of wheres) {
    const wo = attr(w, 'OID')!
    useComment(w, wo)
    for (const rc of list(w.RangeCheck)) resolve('def:ItemOID', new Set(itemById.keys()), attr(rc, 'def:ItemOID'), wo)
  }
  for (const m of methods) useComment(m, attr(m, 'OID')!)
  const supp = mdv['def:SupplementalDoc'] as El | undefined
  for (const d of list(supp?.['def:DocumentRef'])) {
    const id = attr(d, 'leafID')
    resolve('leafID', leafIds, id, 'def:SupplementalDoc')
    if (id) used.leaf.add(id)
  }

  // Every definition is used.
  const unused = (rule: string, kind: string, ids: Iterable<string>, usedIds: Set<string>) => {
    for (const id of ids) if (!usedIds.has(id)) add(rule, id, `${kind} is not referenced`)
  }
  unused('SS-DEF-004', 'ItemDef', itemById.keys(), used.item)
  unused('SS-DEF-005', 'MethodDef', methodIds, used.method)
  unused('SS-DEF-006', 'def:CommentDef', commentIds, used.comment)
  unused('SS-DEF-007', 'def:WhereClauseDef', whereIds, used.where)
  unused('SS-DEF-008', 'def:ValueListDef', vlIds, used.vl)
  unused('SS-DEF-009', 'def:leaf', leafIds, used.leaf)

  // Derived variables point to a method; a method is only attached to derived variables.
  for (const { ref, owner } of allRefs) {
    const io = attr(ref, 'ItemOID')!
    const origin = attr((itemById.get(io)?.['def:Origin'] as El | undefined) ?? {}, 'Type')
    const mo = attr(ref, 'MethodOID')
    if (origin === 'Derived' && !mo) add('SS-DEF-010', `${owner}/${io}`, 'Derived variable has no MethodOID')
    if (mo && origin !== 'Derived') add('SS-DEF-011', `${owner}/${io}`, `MethodOID on a variable with Origin "${origin ?? 'none'}"`)
  }

  // ItemRefs: consecutive order numbers, unique key sequences, unique variable names.
  for (const owner of [...groups, ...valueLists]) {
    const oid = attr(owner, 'OID')!
    const refs = list(owner.ItemRef)
    if (refs.length === 0) add('SS-DEF-012', oid, 'No ItemRef')
    const orders = refs.map((r) => Number(attr(r, 'OrderNumber')))
    if (orders.some((o) => !Number.isInteger(o)) || orders.join() !== refs.map((_, i) => i + 1).join()) add('SS-DEF-013', oid, 'OrderNumber is not 1..n in document order')
    const keys = refs.map((r) => attr(r, 'KeySequence')).filter((k): k is string => k !== undefined).map(Number)
    if (new Set(keys).size !== keys.length || keys.some((k) => !Number.isInteger(k) || k < 1)) add('SS-DEF-014', oid, 'KeySequence values are not unique positive integers')
    if (owner['@Purpose'] !== undefined) {
      const names = refs.map((r) => attr(itemById.get(attr(r, 'ItemOID')!) ?? {}, 'Name'))
      const dup = names.filter((n, i) => names.indexOf(n) !== i)
      if (dup.length) add('SS-DEF-015', oid, `Variable names repeated: ${[...new Set(dup)].join(', ')}`)
    }
  }

  // Datasets: described, named, and either archived or flagged as having no data.
  for (const g of groups) {
    const oid = attr(g, 'OID')!
    if (!text(g)) add('SS-DEF-016', oid, 'ItemGroupDef has no Description')
    if (!NAME.test(attr(g, 'Name') ?? '')) add('SS-DEF-017', oid, `Dataset name "${attr(g, 'Name')}" is not a valid name`)
    const leaf = list(g['def:leaf'])[0]
    const noData = attr(g, 'def:HasNoData') === 'Yes'
    if (!leaf && !noData && v21) add('SS-DEF-018', oid, 'Dataset has neither a def:leaf nor def:HasNoData="Yes"')
    if (!leaf && !v21 && !attr(g, 'def:CommentOID')) add('SS-DEF-018', oid, 'Dataset without a def:leaf has no comment explaining why')
    if (leaf && noData) add('SS-DEF-019', oid, 'def:HasNoData="Yes" on a dataset that has a def:leaf')
    if (leaf && attr(g, 'def:ArchiveLocationID') !== attr(leaf, 'ID')) add('SS-DEF-020', oid, 'def:ArchiveLocationID does not point to the dataset def:leaf')
  }

  // Variables: described, named, lengths consistent with the data type.
  for (const i of items) {
    const oid = attr(i, 'OID')!
    if (!text(i)) add('SS-DEF-021', oid, 'ItemDef has no Description')
    if (!NAME.test(attr(i, 'Name') ?? '')) add('SS-DEF-022', oid, `Variable name "${attr(i, 'Name')}" is not a valid name`)
    const dt = attr(i, 'DataType') ?? ''
    const len = attr(i, 'Length')
    if (DATA_TYPES_WITH_LENGTH.has(dt) && (len === undefined || !/^[1-9]\d*$/.test(len))) add('SS-DEF-023', oid, `${dt} variable needs a positive Length`)
    if (DATA_TYPES_WITHOUT_LENGTH.has(dt) && len !== undefined) add('SS-DEF-024', oid, `${dt} variable must not have a Length`)
    if (!i['def:Origin']) add('SS-DEF-025', oid, 'ItemDef has no def:Origin')
  }

  // Methods, comments and where clauses carry their text.
  for (const m of methods) if (!text(m)) add('SS-DEF-026', attr(m, 'OID')!, 'MethodDef has no Description')
  for (const c of comments) if (!text(c)) add('SS-DEF-027', attr(c, 'OID')!, 'def:CommentDef has no Description')
  for (const w of wheres) {
    const rcs = list(w.RangeCheck)
    if (rcs.length === 0) add('SS-DEF-028', attr(w, 'OID')!, 'def:WhereClauseDef has no RangeCheck')
    for (const rc of rcs) if (list(rc.CheckValue).length === 0) add('SS-DEF-028', attr(w, 'OID')!, 'RangeCheck has no CheckValue')
  }

  // def:Standards (v2.1): an ItemGroupDef either follows a declared standard or is flagged non-standard.
  if (v21) {
    const stdIds = new Set(list((mdv['def:Standards'] as El | undefined)?.['def:Standard']).map((s) => attr(s, 'OID')!))
    for (const g of groups) {
      const so = attr(g, 'def:StandardOID')
      if (so) resolve('def:StandardOID', stdIds, so, attr(g, 'OID')!)
      if (!so && attr(g, 'def:IsNonStandard') !== 'Yes') add('SS-DEF-029', attr(g, 'OID')!, 'Neither def:StandardOID nor def:IsNonStandard="Yes"')
      if (so && attr(g, 'def:IsNonStandard') === 'Yes') add('SS-DEF-029', attr(g, 'OID')!, 'Both def:StandardOID and def:IsNonStandard="Yes"')
    }
  }
  // Rules a regulatory validator (Pinnacle 21, Define.xml FDA configuration) reported on earlier output.
  if (v21) {
    // def:Standards with an implementation guide and a CT package of the same family (P21 DD0006 / DD0150).
    const stds = list((mdv['def:Standards'] as El | undefined)?.['def:Standard'])
    const ig = stds.find((s) => attr(s, 'Type') === 'IG')
    const ct = stds.find((s) => attr(s, 'Type') === 'CT')
    if (!ig) add('SS-DEF-030', 'def:Standards', 'No implementation guide (Type="IG") declared')
    else if (!ct) add('SS-DEF-030', 'def:Standards', 'No controlled terminology (Type="CT") declared')
    else {
      const family = attr(ig, 'Name') === 'ADaMIG' ? ['ADaM', 'SDTM'] : attr(ig, 'Name') === 'SDTMIG' ? ['SDTM'] : attr(ig, 'Name')?.startsWith('SENDIG') ? ['SEND'] : []
      if (family.length && !stds.some((s) => attr(s, 'Type') === 'CT' && family.includes(attr(s, 'PublishingSet') ?? ''))) add('SS-DEF-030', 'def:Standards', `No CT package with PublishingSet ${family.join(' or ')} for ${attr(ig, 'Name')}`)
    }
  }
  // Standard names use the spelling of the Define-XML version (P21 DD0021, a PMDA reject).
  const V20_NAMES = ['SDTM-IG', 'SEND-IG', 'SEND-IG-AR', 'SEND-IG-DART', 'SEND-IG-GENETOX', 'ADaM-IG', 'BIMO']
  const V21_IG_NAMES = ['ADaMIG', 'SDTMIG', 'SENDIG', 'SENDIG-AR', 'SENDIG-DART', 'SENDIG-GENETOX', 'BIMO', 'CDISC/NCI']
  if (v21) {
    for (const st of list((mdv['def:Standards'] as El | undefined)?.['def:Standard']))
      if (!V21_IG_NAMES.includes(attr(st, 'Name') ?? '')) add('SS-DEF-038', attr(st, 'OID')!, `Standard name "${attr(st, 'Name')}" is not a Define-XML 2.1 standard name`)
  } else if (!V20_NAMES.includes(attr(mdv, 'def:StandardName') ?? '')) add('SS-DEF-038', 'MetaDataVersion', `def:StandardName "${attr(mdv, 'def:StandardName')}" is not a Define-XML 2.0 standard name`)

  // SAS names: present, at most 8 characters, unique per scope (P21 DD0047 / DD0051 / DD0070).
  const SAS = /^[A-Za-z_][A-Za-z0-9_]{0,7}$/
  const dsNames = new Map<string, string>()
  for (const g of groups) {
    const oid = attr(g, 'OID')!
    const n = attr(g, 'SASDatasetName')
    if (!n || !SAS.test(n)) add('SS-DEF-031', oid, `SASDatasetName "${n ?? ''}" is missing or not a SAS name`)
    else if (dsNames.has(n.toUpperCase())) add('SS-DEF-031', oid, `SASDatasetName ${n} also used by ${dsNames.get(n.toUpperCase())}`)
    else dsNames.set(n.toUpperCase(), oid)
    const fields = new Map<string, string>()
    for (const r of list(g.ItemRef)) {
      const io = attr(r, 'ItemOID')!
      const f = attr(itemById.get(io) ?? {}, 'SASFieldName')
      if (!f || !SAS.test(f)) add('SS-DEF-032', io, `SASFieldName "${f ?? ''}" is missing or not a SAS name`)
      else if (fields.has(f.toUpperCase())) add('SS-DEF-032', io, `SASFieldName ${f} also used by ${fields.get(f.toUpperCase())} in ${oid}`)
      else fields.set(f.toUpperCase(), io)
    }
  }
  for (const vl of valueLists)
    for (const r of list(vl.ItemRef)) {
      const f = attr(itemById.get(attr(r, 'ItemOID')!) ?? {}, 'SASFieldName')
      if (!f || !SAS.test(f)) add('SS-DEF-032', attr(r, 'ItemOID')!, `SASFieldName "${f ?? ''}" is missing or not a SAS name`)
    }
  // float variables declare their precision (P21 OD0071).
  for (const i of items)
    if (attr(i, 'DataType') === 'float' && !/^\d+$/.test(attr(i, 'SignificantDigits') ?? '')) add('SS-DEF-033', attr(i, 'OID')!, 'float variable has no SignificantDigits')
  // A value-level slice is not longer than the variable it belongs to (P21 DD0123).
  for (const parent of items) {
    const vlOid = (parent['def:ValueListRef'] as El | undefined) && attr(parent['def:ValueListRef'] as El, 'ValueListOID')
    const vl = valueLists.find((v) => attr(v, 'OID') === vlOid)
    for (const r of list(vl?.ItemRef)) {
      const child = itemById.get(attr(r, 'ItemOID')!)
      if (child && Number(attr(child, 'Length')) > Number(attr(parent, 'Length'))) add('SS-DEF-034', attr(child, 'OID')!, `Length ${attr(child, 'Length')} exceeds the parent variable's ${attr(parent, 'Length')}`)
    }
  }
  // The archived file is named after SASDatasetName (P21 DD0052); every dataset has a class (P21 DD0054).
  for (const g of groups) {
    const oid = attr(g, 'OID')!
    const leaf = list(g['def:leaf']).find((l) => attr(l, 'ID') === attr(g, 'def:ArchiveLocationID'))
    const base = leaf ? (attr(leaf, 'xlink:href') ?? '').split('/').pop()!.replace(/\.[^.]+$/, '') : undefined
    if (base !== undefined && base.toUpperCase() !== (attr(g, 'SASDatasetName') ?? '').toUpperCase()) add('SS-DEF-036', oid, `File ${base} does not match SASDatasetName ${attr(g, 'SASDatasetName')}`)
    const cls = v21 ? attr((g['def:Class'] as El | undefined) ?? {}, 'Name') : attr(g, 'def:Class')
    if (!cls) add('SS-DEF-037', oid, 'Dataset has no class')
  }
  // Every dataset has key variables (P21 DD0040).
  for (const g of groups) if (!list(g.ItemRef).some((r) => attr(r, 'KeySequence') !== undefined)) add('SS-DEF-035', attr(g, 'OID')!, 'No ItemRef has a KeySequence')
  return issues
}

const DSJ_TO_DEFINE: Record<string, string> = { string: 'text', integer: 'integer', double: 'float', float: 'float', decimal: 'float', date: 'date', datetime: 'datetime', time: 'time', boolean: 'text', URI: 'text' }

/**
 * Datasets against their metadata: each archived dataset exists and is described, and its columns
 * match the ItemRefs (OID, name, order, type, keys) with no value longer than its declared Length.
 * `datasets` maps archive paths (def:leaf xlink:href) to Dataset-JSON v1.1 text.
 */
export function checkDatasetsAgainstDefine(xml: string, datasets: Record<string, string>): DefineIssue[] {
  const issues: DefineIssue[] = []
  const add = (rule: string, target: string, message: string) => issues.push({ rule, target, message })
  const mdv = (((parser.parse(xml) as El).ODM as El).Study as El).MetaDataVersion as El
  const itemById = new Map(list(mdv.ItemDef).map((i) => [attr(i, 'OID')!, i]))
  const described = new Set<string>()
  for (const g of list(mdv.ItemGroupDef)) {
    const leaf = list(g['def:leaf'])[0]
    if (!leaf) continue
    const href = attr(leaf, 'xlink:href')!
    const go = attr(g, 'OID')!
    described.add(href)
    const raw = datasets[href]
    if (raw === undefined) {
      add('SS-DSJ-001', go, `Archived dataset ${href} is missing`)
      continue
    }
    const ds = JSON.parse(raw) as { itemGroupOID: string; name: string; records: number; columns: { itemOID: string; name: string; dataType: string; length?: number; keySequence?: number }[]; rows: unknown[][] }
    if (ds.itemGroupOID !== go) add('SS-DSJ-002', href, `itemGroupOID ${ds.itemGroupOID} ≠ ${go}`)
    if (ds.name !== attr(g, 'Name')) add('SS-DSJ-002', href, `name ${ds.name} ≠ ${attr(g, 'Name')}`)
    if (ds.records !== ds.rows.length) add('SS-DSJ-003', href, `records ${ds.records} ≠ ${ds.rows.length} rows`)
    const refs = list(g.ItemRef)
    if (refs.length !== ds.columns.length) add('SS-DSJ-004', href, `${ds.columns.length} columns, ${refs.length} ItemRefs`)
    ds.columns.forEach((c, ci) => {
      const ref = refs[ci]
      const where = `${href}#${c.name}`
      if (!ref || attr(ref, 'ItemOID') !== c.itemOID) return add('SS-DSJ-004', where, `column ${ci + 1} is ${c.itemOID}, ItemRef ${ref ? attr(ref, 'ItemOID') : 'none'}`)
      const item = itemById.get(c.itemOID)
      if (!item) return
      if (attr(item, 'Name') !== c.name) add('SS-DSJ-005', where, `name ≠ ItemDef Name ${attr(item, 'Name')}`)
      if (DSJ_TO_DEFINE[c.dataType] !== attr(item, 'DataType')) add('SS-DSJ-006', where, `dataType ${c.dataType} ≠ ItemDef DataType ${attr(item, 'DataType')}`)
      const key = attr(ref, 'KeySequence')
      if ((key === undefined ? undefined : Number(key)) !== c.keySequence) add('SS-DSJ-007', where, `keySequence ${c.keySequence} ≠ ItemRef KeySequence ${key}`)
      const len = Number(attr(item, 'Length'))
      if (c.dataType === 'string' && Number.isFinite(len)) {
        const longest = Math.max(0, ...ds.rows.map((r) => (typeof r[ci] === 'string' ? (r[ci] as string).length : 0)))
        if (longest > len) add('SS-DSJ-008', where, `value of length ${longest} exceeds Length ${len}`)
        if (c.length !== undefined && c.length !== len) add('SS-DSJ-008', where, `length ${c.length} ≠ ItemDef Length ${len}`)
      }
      const mandatory = attr(ref, 'Mandatory') === 'Yes'
      if (mandatory && ds.rows.some((r) => r[ci] === null || r[ci] === '')) add('SS-DSJ-009', where, 'Mandatory variable has missing values')
    })
  }
  for (const href of Object.keys(datasets)) if (!described.has(href)) add('SS-DSJ-010', href, 'Dataset is not described in define.xml')
  return issues
}
