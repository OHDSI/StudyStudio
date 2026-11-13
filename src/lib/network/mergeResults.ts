/**
 * Merged results for a quick look across adopted sites: one CSV per result table, the rows of every site
 * stacked under a leading site_id column. Columns are the union across sites, in first-seen order; values
 * are copied as text, so masked cells (e.g. "-5" or "<5") stay as the sites sealed them.
 */
import Papa from 'papaparse'
import { RESULTS_DIR } from '@/lib/studypack/slots'
import type { LoadedSitePack } from './aggregator'

export interface MergedTable {
  /** Path relative to results/, e.g. "_root/counts.csv" or "CohortMethodModule/cm_result.csv". */
  path: string
  /** Download name, e.g. "counts_merged.csv". */
  fileName: string
  sites: string[]
  rows: number
  csv: string
}

const dec = new TextDecoder()

export function mergeSiteResults(sites: LoadedSitePack[]): MergedTable[] {
  const byPath = new Map<string, { siteId: string; text: string }[]>()
  for (const s of sites)
    for (const [p, b] of Object.entries(s.files))
      if (p.startsWith(RESULTS_DIR + '/') && p.endsWith('.csv')) {
        const rel = p.slice(RESULTS_DIR.length + 1)
        byPath.set(rel, [...(byPath.get(rel) ?? []), { siteId: s.siteId, text: dec.decode(b) }])
      }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, parts]) => {
      const columns: string[] = ['site_id']
      const rows: Record<string, string>[] = []
      for (const part of parts) {
        const parsed = Papa.parse<Record<string, string>>(part.text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy', dynamicTyping: false })
        for (const f of parsed.meta.fields ?? []) if (!columns.includes(f)) columns.push(f)
        for (const r of parsed.data) rows.push({ ...r, site_id: part.siteId })
      }
      const csv = Papa.unparse({ fields: columns, data: rows.map((r) => columns.map((c) => r[c] ?? '')) }, { newline: '\n' }) + '\n'
      const base = path.split('/').pop()!.replace(/\.csv$/i, '')
      return { path, fileName: `${base}_merged.csv`, sites: [...new Set(parts.map((p) => p.siteId))], rows: rows.length, csv }
    })
}
