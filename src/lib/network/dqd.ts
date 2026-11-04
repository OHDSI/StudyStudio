/** Summarize Data Quality Dashboard (DQD) results JSON. */
export interface DqdSummary {
  total: number
  passed: number
  failed: number
  percentPassed: number
  cdmSourceName?: string
  dqdVersion?: string
}

type Dict = Record<string, unknown>
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

export function summarizeDqd(input: unknown): DqdSummary | undefined {
  if (!input || typeof input !== 'object') return undefined
  const d = input as Dict
  const meta = (Array.isArray(d.Metadata) ? d.Metadata[0] : d.Metadata) as Dict | undefined
  const base = {
    cdmSourceName: (meta?.CDM_SOURCE_NAME ?? meta?.cdmSourceName) as string | undefined,
    dqdVersion: (meta?.DQD_VERSION ?? meta?.dqdVersion) as string | undefined,
  }
  const ov = d.Overview as Dict | undefined
  if (ov) {
    const total = num(ov.countTotal) ?? 0
    const passed = num(ov.countPassed) ?? 0
    const failed = num(ov.countOverallFailed) ?? num(ov.countFailed) ?? Math.max(0, total - passed)
    const pct = num(ov.percentPassed) ?? (total ? (passed / total) * 100 : 0)
    return { total, passed, failed, percentPassed: pct, ...base }
  }
  const checks = (d.CheckResults ?? d.checkResults) as Dict[] | undefined
  if (Array.isArray(checks)) {
    const applicable = checks.filter((c) => num(c.notApplicable) !== 1)
    const failed = applicable.filter((c) => num(c.failed) === 1 || num(c.isError) === 1).length
    const total = applicable.length
    return { total, passed: total - failed, failed, percentPassed: total ? ((total - failed) / total) * 100 : 0, ...base }
  }
  return undefined
}
