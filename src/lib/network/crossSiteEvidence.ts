/**
 * Evidence across the adopted sites, made visible for review (assessment A2, E1, X1). Report-only: nothing here
 * excludes a site, blocks a seal or refuses an export.
 *
 *  - A2 attrition: CohortMethod `cm_attrition` (sequence_number, description, subjects, per analysis /
 *    target-comparator / outcome) and CohortGenerator `cg_cohort_inc_stats` with rule names from
 *    `cg_cohort_inclusion`.
 *  - E1 concept-set resolution: per concept set, the SHA-256 of the sorted distinct standard concept IDs that
 *    CohortDiagnostics resolved at each site (`cd_resolved_concepts`; `cd_included_source_concept` when only
 *    that is present), and the number of distinct source codes mapped (`cd_included_source_concept`).
 *  - X1 heterogeneity: versions, data-quality, cut-off and platform per site, with cells that differ from the
 *    majority marked, and the DQD checks that fail at some adopted sites but not at others.
 *
 * Table and column names are those of the HADES results data models (CohortMethod inst/csv,
 * CohortGenerator inst/csv, CohortDiagnostics inst/settings resultsDataModelSpecification.csv; Strategus
 * prefixes CohortDiagnostics tables with "cd_"). A site without a table, or a table without the expected
 * columns, is skipped silently.
 */
import Papa from 'papaparse'
import { sha256Hex } from '@/lib/integrity/hasher'
import { parseDqd } from '@/lib/audit/dqdAuditor'
import { DATABASE_META_DATA, parseDatabaseMetaData, softwareVersions } from '@/lib/provenance/cdmSource'
import { parseRunRecord } from '@/lib/strategus/runRecord'
import { RESULTS_DIR } from '@/lib/studypack/slots'
import type { StudyConfig } from '@/types/studypack'
import type { LoadedSitePack } from './aggregator'

const dec = new TextDecoder()

interface Table {
  header: string[]
  rows: Record<string, string>[]
}

/** A results table by name, wherever the module folder is; undefined when absent or unreadable. */
function table(site: LoadedSitePack, name: string, required: string[]): Table | undefined {
  const path = Object.keys(site.files).find((p) => p.startsWith(`${RESULTS_DIR}/`) && p.toLowerCase().endsWith(`/${name}.csv`))
  if (!path) return undefined
  const res = Papa.parse<Record<string, string>>(dec.decode(site.files[path]).replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', transformHeader: (h) => h.trim().toLowerCase() })
  const header = res.meta.fields ?? []
  if (!required.every((c) => header.includes(c))) return undefined
  return { header, rows: res.data }
}

/** A count as reported: HADES censors 0 < n < k as -k, shown here as "<k". */
export const countCell = (v?: string) => {
  const n = Number(v)
  if (v === undefined || v === '' || Number.isNaN(n)) return v?.trim() || '—'
  return n < 0 ? `<${-n}` : String(n)
}

// ------------------------------------------------------------------------------------------- A2

export interface AttritionGroup {
  /** The identifying columns of the group (analysis_id, target_comparator_id or target_id/comparator_id, outcome_id, …). */
  key: Record<string, string>
  steps: { sequence: number; description: string; subjects: string }[]
}

export interface SiteAttrition {
  siteId: string
  cohortMethod?: AttritionGroup[]
  inclusionRules?: { cohortId: string; rule: string; name?: string; personCount: string; gainCount?: string; personTotal?: string; modeId?: string }[]
}

const ATTRITION_VALUE_COLUMNS = new Set(['sequence_number', 'description', 'subjects', 'database_id'])

export function siteAttrition(site: LoadedSitePack): SiteAttrition {
  const out: SiteAttrition = { siteId: site.siteId }
  const cm = table(site, 'cm_attrition', ['sequence_number', 'description', 'subjects'])
  if (cm) {
    const keyCols = cm.header.filter((h) => !ATTRITION_VALUE_COLUMNS.has(h))
    const groups = new Map<string, AttritionGroup>()
    for (const r of cm.rows) {
      const key = Object.fromEntries(keyCols.map((c) => [c, r[c] ?? '']))
      const k = JSON.stringify(key)
      if (!groups.has(k)) groups.set(k, { key, steps: [] })
      groups.get(k)!.steps.push({ sequence: Number(r.sequence_number), description: r.description ?? '', subjects: countCell(r.subjects) })
    }
    out.cohortMethod = [...groups.values()].map((g) => ({ ...g, steps: g.steps.sort((a, b) => a.sequence - b.sequence) }))
  }
  const stats = table(site, 'cg_cohort_inc_stats', ['cohort_definition_id', 'rule_sequence', 'person_count'])
  if (stats) {
    const names = table(site, 'cg_cohort_inclusion', ['cohort_definition_id', 'rule_sequence', 'name'])
    const nameOf = (c: string, s: string) => names?.rows.find((r) => r.cohort_definition_id === c && r.rule_sequence === s)?.name
    out.inclusionRules = stats.rows.map((r) => ({
      cohortId: r.cohort_definition_id,
      rule: r.rule_sequence,
      name: nameOf(r.cohort_definition_id, r.rule_sequence),
      personCount: countCell(r.person_count),
      ...(r.gain_count !== undefined ? { gainCount: countCell(r.gain_count) } : {}),
      ...(r.person_total !== undefined ? { personTotal: countCell(r.person_total) } : {}),
      ...(r.mode_id !== undefined ? { modeId: r.mode_id } : {}),
    }))
  }
  return out
}

/** CohortMethod is in the specification but the site has no attrition table (a review finding, never an exclusion). */
export function missingAttrition(site: LoadedSitePack, config?: StudyConfig): boolean {
  return !!config?.framework?.modules?.includes('CohortMethodModule') && !table(site, 'cm_attrition', ['sequence_number', 'description', 'subjects'])
}

// ------------------------------------------------------------------------------------------- E1

export interface ConceptSetRow {
  cohortId: string
  conceptSetId: string
  name?: string
  /** Per site: fingerprint of the resolved standard concepts, their number, and the distinct source codes mapped. */
  sites: Record<string, { sha256: string; concepts: number; sourceCodes?: number; from: 'resolved' | 'included' } | undefined>
  /** Sites whose fingerprint differs from the majority (or all of them when there is no majority). */
  differing: string[]
}

export async function conceptFingerprints(sites: LoadedSitePack[]): Promise<ConceptSetRow[]> {
  const rows = new Map<string, ConceptSetRow>()
  const row = (cohortId: string, conceptSetId: string) => {
    const k = `${cohortId}/${conceptSetId}`
    if (!rows.has(k)) rows.set(k, { cohortId, conceptSetId, sites: {}, differing: [] })
    return rows.get(k)!
  }
  for (const s of sites) {
    const resolved = table(s, 'cd_resolved_concepts', ['cohort_id', 'concept_set_id', 'concept_id'])
    const included = table(s, 'cd_included_source_concept', ['cohort_id', 'concept_set_id', 'concept_id'])
    const names = table(s, 'cd_concept_sets', ['cohort_id', 'concept_set_id', 'concept_set_name'])
    const by = (t: Table | undefined, col: string) => {
      const m = new Map<string, Set<string>>()
      for (const r of t?.rows ?? []) {
        const v = r[col]?.trim()
        if (!v || v === '0') continue
        const k = `${r.cohort_id}/${r.concept_set_id}`
        if (!m.has(k)) m.set(k, new Set())
        m.get(k)!.add(v)
      }
      return m
    }
    const standard = resolved ? by(resolved, 'concept_id') : by(included, 'concept_id')
    const source = included?.header.includes('source_concept_id') ? by(included, 'source_concept_id') : undefined
    for (const [k, ids] of standard) {
      const [cohortId, conceptSetId] = k.split('/')
      const sorted = [...ids].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
      row(cohortId, conceptSetId).sites[s.siteId] = { sha256: await sha256Hex(sorted.join('\n')), concepts: sorted.length, ...(source ? { sourceCodes: source.get(k)?.size ?? 0 } : {}), from: resolved ? 'resolved' : 'included' }
    }
    for (const r of names?.rows ?? []) if (r.concept_set_name && rows.has(`${r.cohort_id}/${r.concept_set_id}`)) rows.get(`${r.cohort_id}/${r.concept_set_id}`)!.name ??= r.concept_set_name
  }
  for (const r of rows.values()) r.differing = differingFromMajority(Object.fromEntries(Object.entries(r.sites).map(([k, v]) => [k, v?.sha256])))
  return [...rows.values()].sort((a, b) => Number(a.cohortId) - Number(b.cohortId) || Number(a.conceptSetId) - Number(b.conceptSetId))
}

// ------------------------------------------------------------------------------------------- X1

export const HETEROGENEITY_COLUMNS = ['CDM version', 'Vocabulary version', 'DQD version', 'DQD failures on study tables', 'Source release', 'Data cut-off', 'Strategus', 'R', 'DBMS'] as const
export type HeterogeneityColumn = (typeof HETEROGENEITY_COLUMNS)[number]

export interface Heterogeneity {
  rows: { siteId: string; values: Record<HeterogeneityColumn, string | undefined>; differing: HeterogeneityColumn[] }[]
  /** DQD checks that fail at some adopted sites (with check results) but not at others. */
  dqdDifferences: { check: string; table?: string; field?: string; failingAt: string[]; passingAt: string[] }[]
  /** Review findings for the network (never exclude a site). */
  findings: string[]
}

export function heterogeneity(sites: LoadedSitePack[], config?: StudyConfig): Heterogeneity {
  const studyTables = new Set(config?.dataQuality?.studyTables ?? [])
  const checksBySite = new Map<string, ReturnType<typeof parseDqd>['checks']>()
  const rows = sites.map((s) => {
    const dbm = s.files[`${RESULTS_DIR}/${DATABASE_META_DATA}`]
    const cs = dbm ? parseDatabaseMetaData(dec.decode(dbm)) : undefined
    let dqd: ReturnType<typeof parseDqd> | undefined
    try {
      const b = s.files['evidence/dqd_results.json']
      dqd = b ? parseDqd(JSON.parse(dec.decode(b))) : undefined
    } catch {
      dqd = undefined
    }
    if (dqd?.checks) checksBySite.set(s.siteId, dqd.checks)
    let last: ReturnType<typeof parseRunRecord>['runs'][number] | undefined
    try {
      const b = s.files['evidence/run_record.json']
      last = b ? parseRunRecord(b).runs.at(-1) : undefined
    } catch {
      last = undefined
    }
    const renv = s.files['code/renv.lock'] ? softwareVersions(dec.decode(s.files['code/renv.lock'])) : undefined
    const failures = dqd?.checks && studyTables.size ? String(dqd.checks.filter((c) => c.failed && !c.notApplicable && c.cdmTableName && studyTables.has(c.cdmTableName)).length) : undefined
    const values: Record<HeterogeneityColumn, string | undefined> = {
      'CDM version': cs?.cdmVersion ?? s.manifest?.cdmVersion,
      'Vocabulary version': cs?.vocabularyVersion,
      'DQD version': dqd?.metadata.dqdVersion,
      'DQD failures on study tables': failures,
      'Source release': cs?.sourceReleaseDate,
      'Data cut-off': cs?.maxObservationPeriodEndDate,
      Strategus: last?.packages?.Strategus ?? renv?.packages.Strategus,
      R: last?.r ?? renv?.r,
      DBMS: last?.dbms ?? undefined,
    }
    return { siteId: s.siteId, values, differing: [] as HeterogeneityColumn[] }
  })
  for (const col of HETEROGENEITY_COLUMNS) {
    const diff = new Set(differingFromMajority(Object.fromEntries(rows.map((r) => [r.siteId, r.values[col]]))))
    for (const r of rows) if (diff.has(r.siteId)) r.differing.push(col)
  }

  const findings: string[] = []
  const vocabularies = new Set(rows.map((r) => r.values['Vocabulary version']).filter(Boolean))
  if (!config?.cdmRequirements?.vocabularyVersion && vocabularies.size > 1)
    findings.push(`The adopted sites use ${vocabularies.size} vocabulary versions (${[...vocabularies].join(', ')}) and the protocol requires none: concept sets may resolve differently between sites (see the concept-set resolution table, where present).`)

  const failing = new Map<string, { check: string; table?: string; field?: string; failingAt: Set<string> }>()
  for (const [site, checks] of checksBySite)
    for (const c of checks ?? []) {
      if (!c.failed || c.notApplicable) continue
      const k = `${c.checkName}|${c.cdmTableName ?? ''}|${c.cdmFieldName ?? ''}`
      if (!failing.has(k)) failing.set(k, { check: c.checkName, table: c.cdmTableName, field: c.cdmFieldName, failingAt: new Set() })
      failing.get(k)!.failingAt.add(site)
    }
  const withChecks = [...checksBySite.keys()]
  const dqdDifferences = withChecks.length < 2 ? [] : [...failing.values()]
    .filter((f) => f.failingAt.size < withChecks.length)
    .map((f) => ({ check: f.check, table: f.table, field: f.field, failingAt: [...f.failingAt].sort(), passingAt: withChecks.filter((s) => !f.failingAt.has(s)).sort() }))
    .sort((a, b) => Number(studyTables.has(b.table ?? '')) - Number(studyTables.has(a.table ?? '')) || (a.table ?? '').localeCompare(b.table ?? '') || a.check.localeCompare(b.check))
  return { rows, dqdDifferences, findings }
}

/**
 * Sites whose value differs from the strict majority of the sites that have one; when there is no strict
 * majority and the values differ, every site with a value is marked. Missing values are not marked.
 */
export function differingFromMajority(values: Record<string, string | undefined>): string[] {
  const present = Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== '')
  const counts = new Map<string, number>()
  for (const [, v] of present) counts.set(v, (counts.get(v) ?? 0) + 1)
  if (counts.size <= 1) return []
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  if (n * 2 > present.length) return present.filter(([, v]) => v !== top).map(([s]) => s)
  return present.map(([s]) => s)
}

// ------------------------------------------------------------------------------------------- all

export interface CrossSiteEvidence {
  attrition: SiteAttrition[]
  missingAttrition: string[]
  concepts: ConceptSetRow[]
  heterogeneity: Heterogeneity
}

export async function crossSiteEvidence(adopted: LoadedSitePack[], config?: StudyConfig): Promise<CrossSiteEvidence> {
  return {
    attrition: adopted.map(siteAttrition),
    missingAttrition: adopted.filter((s) => missingAttrition(s, config)).map((s) => s.siteId),
    concepts: await conceptFingerprints(adopted),
    heterogeneity: heterogeneity(adopted, config),
  }
}
