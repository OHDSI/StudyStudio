/**
 * Simplified trial summary (ts.xpt) of the FDA Study Data Technical Conformance Guide (October 2026),
 * section 8.1.2.2 and Appendix G: a dataset named ts.xpt with the four variables STUDYID, TSPARMCD, TSVAL
 * and TSVALNF and one row, TSPARMCD = SSTDTC (study start date). It lets the FDA inbound processing identify
 * xpt datasets that are not required to have SDTM and ADaM datasets.
 *
 * - Example A (study with a valid start date): TSVAL = the start date (yyyy-mm-dd). For clinical studies that
 *   started on or before 2016-12-17 (before standardized data were required).
 * - Example B (study without a valid start date): TSVAL empty, TSVALNF = "NA". Also what the guide asks for
 *   when SDTM and ADaM do not apply to a study that started after 2016-12-17 — the case of aggregated results.
 *
 * STUDYID must be the study ID of the study tagging file (eCTD v3.2.2) or the Study Id keyword (eCTD v4.0).
 */
import type { CombinedTable } from './datasetJson'
import { writeXpt } from './xpt'

/** Clinical studies that started after this date require SDTM and ADaM (FDA Data Standards Catalog). */
export const STANDARDIZED_DATA_REQUIRED_AFTER = '2016-12-17'

export interface SimplifiedTs {
  /** Appendix G example used. */
  example: 'A' | 'B'
  /** TSVAL: the study start date (example A), or null (example B, TSVALNF = "NA"). */
  studyStartDate: string | null
}

/**
 * Which example applies: A with the start date when the study started on or before 2016-12-17, B otherwise
 * (no start date given, or a later study whose data are not SDTM / ADaM).
 */
export function simplifiedTsFor(studyStartDate?: string): SimplifiedTs {
  const d = studyStartDate?.trim()
  if (!d) return { example: 'B', studyStartDate: null }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d)
    throw new Error(`Study start date "${d}" is not a date (yyyy-mm-dd)`)
  return d <= STANDARDIZED_DATA_REQUIRED_AFTER ? { example: 'A', studyStartDate: d } : { example: 'B', studyStartDate: null }
}

export function simplifiedTsTable(studyId: string, ts: SimplifiedTs): CombinedTable {
  const text = (name: string, description: string) => ({ name, dataType: 'string' as const, length: 1, description })
  return {
    name: 'TS',
    sourceTable: 'ts',
    module: '',
    label: 'Trial Summary',
    columns: [text('STUDYID', 'Study Identifier'), text('TSPARMCD', 'Trial Summary Parameter Short Name'), text('TSVAL', 'Parameter Value'), text('TSVALNF', 'Parameter Null Flavor')],
    rows: [[studyId, 'SSTDTC', ts.studyStartDate ?? '', ts.studyStartDate ? '' : 'NA']],
  }
}

/** ts.xpt bytes. */
export function writeSimplifiedTs(studyId: string, ts: SimplifiedTs, now?: Date): Uint8Array {
  const t = simplifiedTsTable(studyId, ts)
  return writeXpt(t, { name: 'TS', variables: t.columns.map((c) => c.name), labels: t.columns.map((c) => c.description!), label: t.label, now })
}
