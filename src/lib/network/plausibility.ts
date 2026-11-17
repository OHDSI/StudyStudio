/**
 * Plausibility checks across and within sites (requirements R5.5, limitation 7).
 *
 * A pack is written on the site's machine, so a site that wants to can produce results some other way
 * and seal them. Nothing in the pack can rule that out. What the coordinator can do is look for the
 * traces that copying or editing usually leaves:
 *   - the same counts as another site (results copied from another site, with database_id renamed),
 *   - the same database or the same DQD run as another site,
 *   - counts that cannot occur together (more subjects than entries, more subjects in an analysis than
 *     in its cohort).
 * Findings are for review only. They never exclude a site by themselves: sites that share a data
 * source, or a coincidence in a small table, can explain them. The coordinator decides, and the
 * decision is recorded in the disposition audit trail.
 */
import Papa from 'papaparse'
import { collectRdms, rdmsCountColumns, tableNameOf, type Rdms } from '@/lib/strategus/results'
import { DATABASE_META_DATA, parseDatabaseMetaData } from '@/lib/provenance/cdmSource'
import { RESULTS_DIR } from '@/lib/studypack/slots'
import type { LoadedSitePack } from './aggregator'

export interface PlausibilityFinding {
  code: 'duplicate-results' | 'same-database' | 'same-dqd' | 'impossible-counts'
  message: string
  /** The other site(s) involved, for cross-site findings. */
  otherSites?: string[]
}

const dec = new TextDecoder()
const DQD_PATH = 'evidence/dqd_results.json'
/** Count columns by name, for tables without a results data model specification. */
const COUNT_NAME = /(^|_)(subjects|persons|entries|outcomes|events|count)$/i

interface Table {
  header: string[]
  rows: string[][]
}

function parseCsv(bytes: Uint8Array): Table | undefined {
  const res = Papa.parse<string[]>(dec.decode(bytes).replace(/^﻿/, ''), { header: false, skipEmptyLines: 'greedy' })
  const [header, ...rows] = res.data
  return header?.length ? { header: header.map((h) => h.trim().toLowerCase()), rows } : undefined
}

function resultTables(site: LoadedSitePack): Map<string, Table> {
  const out = new Map<string, Table>()
  for (const [p, b] of Object.entries(site.files)) {
    if (!p.startsWith(RESULTS_DIR + '/') || !/\.csv$/i.test(p) || p.endsWith('/resultsDataModelSpecification.csv')) continue
    const t = parseCsv(b)
    if (t) out.set(p.slice(RESULTS_DIR.length + 1), t)
  }
  return out
}

function siteRdms(site: LoadedSitePack): Map<string, Rdms> {
  const files = Object.entries(site.files)
    .filter(([p]) => p.startsWith(RESULTS_DIR + '/'))
    .map(([p, bytes]) => ({ path: p.slice(RESULTS_DIR.length + 1), bytes }))
  return collectRdms(files)
}

/** Columns that hold person counts: from the module's specification, else by name. */
function countColumns(path: string, t: Table, rdms: Map<string, Rdms>): number[] {
  const spec = rdms.get(path.includes('/') ? path.split('/')[0] : '_root')
  const named = spec ? rdmsCountColumns(spec, tableNameOf(path))?.map((c) => c.toLowerCase()) : undefined
  return t.header.flatMap((h, i) => ((named ? named.includes(h) : COUNT_NAME.test(h)) ? [i] : []))
}

const count = (v: string | undefined) => {
  const n = Number(v)
  // Negative values are Strategus' censored "<k" marks, not counts.
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * The table's content without database_id, rows sorted, when it holds at least one positive count.
 * Tables without counts (analysis and cohort definitions) are the same at every site by design.
 */
function countFingerprint(path: string, t: Table, rdms: Map<string, Rdms>): string | undefined {
  const counts = countColumns(path, t, rdms)
  if (!counts.length || !t.rows.some((r) => counts.some((i) => (count(r[i]) ?? 0) > 0))) return undefined
  const drop = t.header.indexOf('database_id')
  const keep = (r: string[]) => r.filter((_, i) => i !== drop).map((v) => v.trim())
  return [keep(t.header).join(','), ...t.rows.map((r) => keep(r).join(',')).sort()].join('\n')
}

function impossibleCounts(tables: Map<string, Table>): string[] {
  const out: string[] = []
  const col = (t: Table, name: string) => t.header.indexOf(name)
  // Cohort subjects by cohort ID, from CohortGenerator.
  const cohortSubjects = new Map<string, number>()
  for (const [p, t] of tables) {
    const id = col(t, 'cohort_id')
    const entries = col(t, 'cohort_entries')
    const subjects = col(t, 'cohort_subjects')
    if (id < 0 || subjects < 0) continue
    const bad = entries < 0 ? [] : t.rows.filter((r) => (count(r[subjects]) ?? -1) > (count(r[entries]) ?? Infinity))
    if (bad.length) out.push(`${p}: ${bad.length} cohort(s) with more subjects than entries (cohort ${bad.slice(0, 3).map((r) => r[id]).join(', ')})`)
    if (tableNameOf(p) === 'cg_cohort_count') for (const r of t.rows) if (count(r[subjects]) !== undefined) cohortSubjects.set(r[id].trim(), count(r[subjects])!)
  }
  if (!cohortSubjects.size) return out
  // An analysis cannot include more subjects than its cohort has.
  for (const [p, t] of tables) {
    for (const role of ['target', 'comparator'] as const) {
      const id = col(t, `${role}_id`)
      const subjects = col(t, `${role}_subjects`)
      if (id < 0 || subjects < 0) continue
      const bad = new Set<string>()
      for (const r of t.rows) {
        const n = count(r[subjects])
        const cohort = cohortSubjects.get(r[id]?.trim())
        if (n !== undefined && cohort !== undefined && n > cohort) bad.add(`${r[id].trim()}: ${n} > ${cohort}`)
      }
      if (bad.size) out.push(`${p}: more ${role} subjects than the cohort has in cg_cohort_count (${[...bad].slice(0, 3).join('; ')})`)
    }
  }
  return out
}

function databaseIdentity(site: LoadedSitePack): { id?: string; name?: string } {
  const b = site.files[`${RESULTS_DIR}/${DATABASE_META_DATA}`]
  const facts = b ? parseDatabaseMetaData(dec.decode(b)) : undefined
  return { id: facts?.databaseId, name: facts?.cdmSourceName ?? site.dqd?.cdmSourceName }
}

/** Findings per site (keyed by LoadedSitePack.key). Packs from the same site ID are not compared. */
export function checkPlausibility(sites: readonly LoadedSitePack[]): Map<string, PlausibilityFinding[]> {
  const out = new Map<string, PlausibilityFinding[]>(sites.map((s) => [s.key, []]))
  const add = (s: LoadedSitePack, f: PlausibilityFinding) => out.get(s.key)!.push(f)
  const info = sites.map((s) => {
    const tables = resultTables(s)
    const rdms = siteRdms(s)
    const fingerprints = new Map<string, string>()
    for (const [p, t] of tables) {
      const fp = countFingerprint(p, t, rdms)
      if (fp) fingerprints.set(p, fp)
    }
    return { site: s, tables, fingerprints, db: databaseIdentity(s) }
  })

  for (const a of info) {
    for (const p of impossibleCounts(a.tables)) add(a.site, { code: 'impossible-counts', message: `Counts that cannot occur together — ${p}` })
    const others = info.filter((b) => b.site.siteId !== a.site.siteId)
    const copied = new Map<string, string[]>()
    for (const b of others) {
      const same = [...a.fingerprints].filter(([p, fp]) => b.fingerprints.get(p) === fp).map(([p]) => p)
      if (same.length) copied.set(b.site.siteId, same)
    }
    for (const [other, paths] of copied)
      add(a.site, { code: 'duplicate-results', otherSites: [other], message: `${paths.length} result table(s) have the same counts as ${other}, apart from database_id: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}` })
    const sameDb = others.filter((b) => (a.db.id && b.db.id === a.db.id) || (a.db.name && b.db.name === a.db.name)).map((b) => b.site.siteId)
    if (sameDb.length) add(a.site, { code: 'same-database', otherSites: [...new Set(sameDb)], message: `Same database as ${[...new Set(sameDb)].join(', ')} (${a.db.id ?? a.db.name})` })
    const dqd = a.site.fileHashes[DQD_PATH]
    const sameDqd = dqd ? others.filter((b) => b.site.fileHashes[DQD_PATH] === dqd).map((b) => b.site.siteId) : []
    if (sameDqd.length) add(a.site, { code: 'same-dqd', otherSites: sameDqd, message: `The same DQD results file as ${sameDqd.join(', ')}` })
  }
  return out
}
