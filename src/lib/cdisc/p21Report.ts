/**
 * Reads a Pinnacle 21 validator report (the Excel file written by P21 Community, GUI or CLI) so that the
 * reviewer's guide can state what was validated, with which engine and configuration, and what the
 * validator reported. The validator is run by the user; this only reads its report.
 *
 * Local paths in the report (configuration, define.xml) are reduced to file names: they name the user's
 * machine and do not belong in a submission document.
 */
import * as XLSX from 'xlsx'

export interface ValidatorIssue {
  /** Pinnacle 21 rule ID, e.g. AD0001. */
  id: string
  message: string
  /** Severity as the report rates it (Reject / Error / Warning / Notice). */
  severity: string
  /** Total occurrences. */
  count: number
  /** Datasets it was reported on (GLOBAL for package-level findings). */
  sources: string[]
}

export interface ValidatorRun {
  /** File name of the report as loaded. */
  file: string
  validator: 'Pinnacle 21'
  softwareVersion?: string
  /** e.g. "PMDA 2411.1". */
  engine?: string
  /** Configuration file name without extension, e.g. "ADaM-IG 1.3 (PMDA)". */
  configuration?: string
  /** File name of the define.xml validated. */
  define?: string
  ctVersion?: string
  /** Report time as written by the validator. */
  generated?: string
  /** Datasets the validator read (empty when only define.xml was validated). */
  datasets: { name: string; source: string; records?: number }[]
  issues: ValidatorIssue[]
  /** Installation problems the validator reported (e.g. "MedDRA not configured"). */
  installationProblems: string[]
}

type Row = unknown[]
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim()
const baseName = (p: string) => p.split(/[\\/]/).pop()!

export function parseP21Report(file: string, data: ArrayBuffer | Uint8Array): ValidatorRun {
  const wb = XLSX.read(data, { type: 'array' })
  const sheet = (name: string): Row[] => (wb.Sheets[name] ? XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { header: 1, blankrows: false }) : [])
  const summary = sheet('Validation Summary')
  if (!wb.Sheets['Issue Summary'] || !str(summary[0]?.[0]).startsWith('Pinnacle 21')) throw new Error(`${file} is not a Pinnacle 21 validator report`)

  const field = (key: string) => {
    const line = summary.map((r) => str(r[0])).find((t) => t.startsWith(`${key}:`))
    const v = line?.slice(key.length + 1).trim()
    return v && v !== 'null' ? v : undefined
  }
  const configuration = field('Configuration')
  const define = field('Define.xml')

  const problems: string[] = []
  const at = summary.findIndex((r) => str(r[0]) === 'Problem' && str(r[1]) === 'Details')
  if (at >= 0) for (const r of summary.slice(at + 1)) if (str(r[0])) problems.push(str(r[0]))

  // Processed sources: the datasets read, between the header after "Processed Sources" and "Total".
  const datasets: ValidatorRun['datasets'] = []
  const ds = sheet('Dataset Summary')
  const start = ds.findIndex((r) => str(r[0]) === 'Processed Sources')
  if (start >= 0)
    for (const r of ds.slice(start + 2)) {
      const name = str(r[0])
      if (!name || name === 'Total') break
      if (name !== 'GLOBAL') datasets.push({ name, source: str(r[3]), records: typeof r[4] === 'number' ? r[4] : undefined })
    }

  const issues = new Map<string, ValidatorIssue>()
  let source = ''
  for (const r of sheet('Issue Summary')) {
    const [s, id, message, severity, count] = r.map(str)
    if (s && !id) source = s
    if (!/^[A-Z]{2}\d{4}$/.test(id)) continue
    const i = issues.get(id) ?? { id, message, severity, count: 0, sources: [] }
    i.count += Number(count) || 0
    if (source && !i.sources.includes(source)) i.sources.push(source)
    issues.set(id, i)
  }

  return {
    file,
    validator: 'Pinnacle 21',
    softwareVersion: field('Software Version'),
    engine: field('Validation Engine Name'),
    configuration: configuration ? baseName(configuration).replace(/\.xml$/i, '') : undefined,
    define: define ? baseName(define) : undefined,
    ctVersion: field('CDISC ADaM CT Version'),
    generated: field('Generated'),
    datasets,
    issues: [...issues.values()],
    installationProblems: problems,
  }
}

/** "PMDA 2411.1, ADaM-IG 1.3 (PMDA)" */
export const runLabel = (r: ValidatorRun) => [r.engine, r.configuration].filter(Boolean).join(', ') || r.file

/**
 * Signs that a report is not about this package: datasets it read that the package does not contain,
 * or package datasets it did not read when it read any.
 */
export function reportMismatches(r: ValidatorRun, packageDatasets: string[]): string[] {
  if (!r.datasets.length) return []
  const read = new Set(r.datasets.map((d) => d.name.toUpperCase()))
  const pkg = new Set(packageDatasets.map((n) => n.toUpperCase()))
  const extra = [...read].filter((n) => !pkg.has(n))
  const missing = [...pkg].filter((n) => !read.has(n))
  return [
    ...(extra.length ? [`validated dataset(s) not in this package: ${extra.join(', ')}`] : []),
    ...(missing.length ? [`package dataset(s) not validated: ${missing.join(', ')}`] : []),
  ]
}
