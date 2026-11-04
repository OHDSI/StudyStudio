/**
 * Export Hub: network audit report (Markdown + printable HTML for PDF) and the
 * regulatory submission ZIP (define.xml, Dataset-JSON, reports, per-site manifests).
 */
import JSZip from 'jszip'
import type { CrossSiteResult, LoadedSitePack, SiteVerdict } from '@/lib/network/aggregator'
import { buildDefineXml, xmlEscape, type DefineXmlVersion } from '@/lib/cdisc/defineXml'
import { combineSiteCsvs, serializeDatasetJson, type CombinedTable, type DatasetJsonVersion } from '@/lib/cdisc/datasetJson'
import { parseMappingSpec, parseScanReport, type MappingSpec, type SourceTable } from '@/lib/cdisc/sources'
import { APP_VERSION, manifestEntries, safeId } from '@/lib/studypack/builder'
import { parseAnalysisSpecification } from '@/lib/strategus/spec'
import { moduleOf, parseRdms, RDMS_FILE, tableNameOf, type Rdms } from '@/lib/strategus/results'
import { PROTOCOL_PATHS } from '@/lib/strategus/protocol'
import { RESULTS_DIR } from '@/lib/studypack/slots'
import { PACK_VERSION, type FileRole, type StudyConfig, type StudyPackManifest } from '@/types/studypack'

export interface SiteRow {
  site: LoadedSitePack
  verdict: SiteVerdict
  adopted: boolean
}

export interface ReportInput {
  studyId: string
  studyTitle: string
  config?: StudyConfig
  cross: CrossSiteResult
  rows: SiteRow[]
  generatedAt: string
  exportedFiles?: { path: string; sha256: string; sizeBytes: number }[]
  standards?: { defineXml: DefineXmlVersion; datasetJson: DatasetJsonVersion }
}

const standardsLine = (i: ReportInput) =>
  i.standards ? `CDISC Define-XML v${i.standards.defineXml} / Dataset-JSON v${i.standards.datasetJson}` : undefined

const short = (h?: string) => (h ? `${h.slice(0, 12)}…` : '—')
const pct = (n?: number) => (n === undefined ? '—' : `${n.toFixed(1)}%`)
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

function siteFacts(r: SiteRow, cross: CrossSiteResult) {
  const s = r.site
  const checks = cross.perSite[s.key] ?? {}
  const st = (p: string) => (checks[p]?.status === 'match' ? '✅ Match' : checks[p]?.status === 'missing' ? '⚠️ Missing' : '❌ Mismatch')
  const a = s.reAudit
  return {
    siteId: s.siteId,
    file: s.fileName,
    integrity: s.integrity.status === 'verified' ? `✅ Verified (${s.integrity.verifiedCount})` : s.integrity.status === 'tampered' ? '❌ Tampering detected' : '❌ Invalid',
    spec: st(PROTOCOL_PATHS.analysisSpecifications),
    code: st(PROTOCOL_PATHS.executeAnalyses),
    renv: st(PROTOCOL_PATHS.renvLock),
    dqd: pct(s.dqd?.percentPassed),
    cells: !a ? '—' : a.passed ? `✅ Passed (${a.files} files)` : `❌ ${a.smallCellCount + a.identifierCount} finding(s) in ${a.failing.length} file(s)`,
    decision: r.adopted
      ? r.verdict.recommended === 'exclude' ? 'Adopted (manual override)' : 'Adopted'
      : r.verdict.recommended === 'adopt' ? 'Excluded (manual)' : 'Excluded',
    reasons: r.verdict.reasons.join('; ') || '—',
  }
}

export function buildMarkdownReport(i: ReportInput): string {
  const adopted = i.rows.filter((r) => r.adopted)
  const L: string[] = []
  L.push(`# Network Integrity & Privacy Audit Report — ${i.studyId}`, '')
  L.push(`- **Study:** ${i.studyTitle}`)
  if (i.config?.principalInvestigator) L.push(`- **Principal Investigator:** ${i.config.principalInvestigator}`)
  if (i.config?.sponsor) L.push(`- **Sponsor:** ${i.config.sponsor}`)
  L.push(`- **Generated:** ${i.generatedAt} by Study Studio ${APP_VERSION} (offline, in-browser)`)
  L.push(`- **Protocol issued:** ${i.config?.issuedAt ?? '— (no study_config.json loaded; majority hashes used as reference)'}`)
  L.push(`- **Minimum cell count:** ${i.config?.minCellCount ?? 5} (values 0 < n < ${i.config?.minCellCount ?? 5} must be suppressed)`)
  if (i.standards) L.push(`- **Submission standards:** ${standardsLine(i)}`)
  L.push(`- **Sites received:** ${i.rows.length} / **adopted:** ${adopted.length} / **excluded:** ${i.rows.length - adopted.length}`, '')

  L.push('## 1. Protocol reference hashes (SHA-256)', '')
  L.push('| Artifact | Reference | Source |', '|---|---|---|')
  for (const [p, r] of Object.entries(i.cross.references)) L.push(`| \`${p}\`${r.kind === 'section' ? ' (protected section)' : ''} | \`${r.hash ?? '—'}\` | ${r.source} |`)
  L.push('')

  L.push('## 2. Site verification summary', '')
  L.push('| Site | Manifest integrity | analysisSpecifications.json | ExecuteAnalyses.R | renv.lock | DQD pass rate | Small-cell audit | Decision | Reasons |')
  L.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of i.rows) {
    const f = siteFacts(r, i.cross)
    L.push(`| ${mdCell(f.siteId)} | ${f.integrity} | ${f.spec} | ${f.code} | ${f.renv} | ${f.dqd} | ${f.cells} | **${f.decision}** | ${mdCell(f.reasons)} |`)
  }
  L.push('')

  L.push('## 3. Site details', '')
  for (const r of i.rows) {
    const s = r.site
    L.push(`### ${s.siteId} (${r.adopted ? 'adopted' : 'excluded'})`, '')
    L.push(`- Package: \`${s.fileName}\` — SHA-256 \`${s.zipSha256}\``)
    L.push(`- Manifest generated: ${s.manifest?.generatedAt ?? '—'} / CDM ${s.manifest?.cdmVersion ?? '—'}`)
    if (s.dqd) L.push(`- DQD: ${s.dqd.passed}/${s.dqd.total} checks passed (${pct(s.dqd.percentPassed)})${s.dqd.dqdVersion ? `, DQD ${s.dqd.dqdVersion}` : ''}`)
    if (s.auditReport) L.push(`- Site self-audit: ${s.auditReport.passed ? 'passed' : 'FAILED'} at ${s.auditReport.generatedAt}`)
    if (s.exportedMinCellCount !== undefined) L.push(`- Exported with minCellCount ${s.exportedMinCellCount} (executionSettings.json)`)
    if (s.reAudit) {
      L.push(`- Coordinator re-audit of ${s.reAudit.files} Strategus result file(s): ${s.reAudit.scannedCells} cells scanned, ${s.reAudit.smallCellCount} small cells, ${s.reAudit.identifierCount} identifier columns`)
      for (const f of s.reAudit.failing) L.push(`  - ❌ \`results/${f.path}\`: ${f.smallCellCount} small cell(s), ${f.identifierCount} identifier column(s)`)
    }
    for (const m of s.integrity.mismatched) L.push(`- ❌ Hash mismatch \`${m.path}\`: manifest ${short(m.expected)} vs actual ${short(m.actual)}`)
    for (const m of s.integrity.missing) L.push(`- ❌ Listed but missing: \`${m}\``)
    for (const m of s.integrity.unlisted) L.push(`- ❌ Present but not in manifest: \`${m}\``)
    for (const e of s.integrity.errors) L.push(`- ❌ ${e}`)
    L.push('')
  }

  if (i.exportedFiles?.length) {
    L.push('## 4. Submission package contents', '')
    L.push('| File | SHA-256 | Bytes |', '|---|---|---|')
    for (const f of i.exportedFiles) L.push(`| \`${f.path}\` | \`${f.sha256}\` | ${f.sizeBytes} |`)
    L.push('')
  }
  L.push('---', '', '_All processing was performed client-side; no data was transmitted to any server._', '')
  return L.join('\n')
}

export function buildHtmlReport(i: ReportInput): string {
  const adopted = i.rows.filter((r) => r.adopted).length
  const rows = i.rows
    .map((r) => {
      const f = siteFacts(r, i.cross)
      return `<tr class="${r.adopted ? '' : 'excluded'}"><td>${xmlEscape(f.siteId)}</td><td>${f.integrity}</td><td>${f.spec}</td><td>${f.code}</td><td>${f.renv}</td><td>${f.dqd}</td><td>${f.cells}</td><td><b>${f.decision}</b></td><td>${xmlEscape(f.reasons)}</td></tr>`
    })
    .join('\n')
  const refs = Object.entries(i.cross.references)
    .map(([p, r]) => `<tr><td><code>${xmlEscape(p)}</code>${r.kind === 'section' ? ' (protected section)' : ''}</td><td><code>${r.hash ?? '—'}</code></td><td>${r.source}</td></tr>`)
    .join('\n')
  const files = (i.exportedFiles ?? []).map((f) => `<tr><td><code>${xmlEscape(f.path)}</code></td><td><code>${f.sha256}</code></td><td>${f.sizeBytes}</td></tr>`).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Audit Report — ${xmlEscape(i.studyId)}</title>
<style>
 body{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:32px;}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
 table{border-collapse:collapse;width:100%;font-size:11.5px} th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}
 th{background:#f2f2f2} code{font-size:10.5px;word-break:break-all} tr.excluded td{background:#fff3f3}
 .meta{color:#444} .foot{margin-top:24px;color:#666;font-size:11px}
 @media print{body{margin:12mm} .noprint{display:none}}
</style></head><body>
<button class="noprint" onclick="window.print()" style="float:right">Print / Save as PDF</button>
<h1>Network Integrity &amp; Privacy Audit Report</h1>
<div class="meta">${xmlEscape(i.studyId)} — ${xmlEscape(i.studyTitle)}<br>
Generated ${xmlEscape(i.generatedAt)} · Study Studio ${APP_VERSION} · min cell count ${i.config?.minCellCount ?? 5}<br>
Sites received ${i.rows.length} · adopted ${adopted} · excluded ${i.rows.length - adopted}${i.standards ? `<br>${standardsLine(i)}` : ''}</div>
<h2>1. Protocol reference hashes (SHA-256)</h2>
<table><tr><th>Artifact</th><th>Reference</th><th>Source</th></tr>${refs}</table>
<h2>2. Site verification summary</h2>
<table><tr><th>Site</th><th>Manifest</th><th>Analysis spec</th><th>ExecuteAnalyses.R</th><th>renv.lock</th><th>DQD</th><th>Small cells</th><th>Decision</th><th>Reasons</th></tr>
${rows}</table>
${files ? `<h2>3. Submission package contents</h2><table><tr><th>File</th><th>SHA-256</th><th>Bytes</th></tr>${files}</table>` : ''}
<p class="foot">All processing was performed client-side; no data was transmitted to any server.</p>
</body></html>
`
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function firstJson<T>(sites: LoadedSitePack[], path: string): T | undefined {
  for (const s of sites) {
    const b = s.files[path]
    if (!b) continue
    try {
      return JSON.parse(dec.decode(b)) as T
    } catch {
      /* try next site */
    }
  }
  return undefined
}

export interface ResultTableInfo {
  /** "<Module>/<table>" */
  key: string
  module: string
  table: string
  sites: number
  rows: number
}

const resultCsvs = (s: LoadedSitePack) =>
  Object.keys(s.files).filter((p) => p.startsWith(RESULTS_DIR + '/') && p.endsWith('.csv') && !p.endsWith('/' + RDMS_FILE))

const countRows = (b: Uint8Array) => Math.max(0, dec.decode(b).split(/\r?\n/).filter((l) => l.trim()).length - 1)

/** Strategus result tables available across the adopted sites (for selection in the Export Hub). */
export function listResultTables(sites: LoadedSitePack[]): ResultTableInfo[] {
  const map = new Map<string, ResultTableInfo>()
  for (const s of sites)
    for (const p of resultCsvs(s)) {
      const rel = p.slice(RESULTS_DIR.length + 1)
      const key = `${moduleOf(rel)}/${tableNameOf(rel)}`
      const info = map.get(key) ?? { key, module: moduleOf(rel), table: tableNameOf(rel), sites: 0, rows: 0 }
      info.sites++
      info.rows += countRows(s.files[p])
      map.set(key, info)
    }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key))
}

export interface RegulatoryExport {
  zipBlob: Blob
  zipName: string
  defineXml: string
  /** Dataset-JSON text per archive path (datasets/<table>.json). */
  datasets: Record<string, string>
  tables: CombinedTable[]
  markdown: string
  html: string
  manifest: StudyPackManifest
  standards: { defineXml: DefineXmlVersion; datasetJson: DatasetJsonVersion }
}

export async function buildRegulatoryExport(params: {
  studyId: string
  studyTitle: string
  config?: StudyConfig
  cross: CrossSiteResult
  rows: SiteRow[]
  defineXmlVersion?: DefineXmlVersion
  datasetJsonVersion?: DatasetJsonVersion
  /** "<Module>/<table>" keys to include; default all. */
  tables?: string[]
  now?: Date
}): Promise<RegulatoryExport> {
  const standards = { defineXml: params.defineXmlVersion ?? '2.1', datasetJson: params.datasetJsonVersion ?? '1.1' } as const
  const generatedAt = (params.now ?? new Date()).toISOString()
  const adopted = params.rows.filter((r) => r.adopted).map((r) => r.site)
  if (adopted.length === 0) throw new Error('No adopted sites')

  // Cohorts come from the reference analysis specification (a site whose spec matches the reference hash).
  const specPath = PROTOCOL_PATHS.analysisSpecifications
  const refHash = params.cross.references[specPath]?.hash
  const refSite = adopted.find((s) => s.fileHashes[specPath] === refHash) ?? adopted.find((s) => s.files[specPath])
  let cohorts: { cohortId: number; cohortName: string; roles: string[]; expression?: Record<string, unknown> }[] = []
  if (refSite?.files[specPath]) {
    try {
      cohorts = parseAnalysisSpecification(dec.decode(refSite.files[specPath])).cohorts
    } catch {
      /* spec unreadable: fall back to the protocol's cohort list */
    }
  }
  if (!cohorts.length && params.config) cohorts = params.config.cohorts

  let scanTables: SourceTable[] | undefined
  for (const s of adopted) {
    const x = s.files['etl/ScanReport_sanitized.xlsx']
    if (!x) continue
    try {
      scanTables = parseScanReport(x)
      break
    } catch {
      /* ignore */
    }
  }
  const mappingRaw = firstJson<unknown>(adopted, 'etl/mapping_specification.json')
  const mapping: MappingSpec | undefined = mappingRaw ? parseMappingSpec(mappingRaw) : undefined

  // Results data model per module (first adopted site that ships it).
  const rdmsByModule = new Map<string, Rdms>()
  for (const site of adopted)
    for (const [p, b] of Object.entries(site.files)) {
      if (!p.startsWith(RESULTS_DIR + '/') || !p.endsWith('/' + RDMS_FILE)) continue
      const mod = moduleOf(p.slice(RESULTS_DIR.length + 1))
      if (!rdmsByModule.has(mod)) rdmsByModule.set(mod, parseRdms(dec.decode(b)))
    }
  const wanted = params.tables ? new Set(params.tables) : undefined
  const tables: CombinedTable[] = listResultTables(adopted)
    .filter((t) => !wanted || wanted.has(t.key))
    .map((t) =>
      combineSiteCsvs(
        adopted.flatMap((s) => {
          const b = s.files[`${RESULTS_DIR}/${t.key}.csv`]
          return b ? [{ siteId: s.siteId, csv: dec.decode(b) }] : []
        }),
        { sourceTable: t.table, module: t.module, rdms: rdmsByModule.get(t.module)?.get(t.table) },
      ),
    )
  if (tables.length === 0) throw new Error('No Strategus result tables selected')

  const studyOID = `STUDY.${safeId(params.studyId)}`
  const mdvOID = `MDV.${safeId(params.studyId)}.1`

  const datasets: Record<string, string> = {}
  for (const t of tables)
    datasets[`datasets/${t.sourceTable}.json`] = serializeDatasetJson(standards.datasetJson, t, {
      studyOID,
      metaDataVersionOID: mdvOID,
      originator: params.config?.sponsor || 'Study Studio',
      sourceVersion: APP_VERSION,
      now: params.now,
    })
  const defineXml = buildDefineXml({
    version: standards.defineXml,
    studyId: params.studyId,
    studyTitle: params.studyTitle,
    description: params.config?.description,
    originator: params.config?.sponsor,
    sourceSystemVersion: APP_VERSION,
    cohorts,
    resultTables: tables,
    scanTables,
    mapping,
    auditReportHref: 'audit_report.html',
    now: params.now,
  })

  const content: { path: string; bytes: Uint8Array; role: FileRole }[] = [
    { path: 'define.xml', bytes: enc.encode(defineXml), role: 'metadata' },
    ...Object.entries(datasets).map(([path, text]) => ({ path, bytes: enc.encode(text), role: 'result' as FileRole })),
  ]
  for (const s of params.rows) {
    const m = s.site.files['manifest.json']
    if (m) content.push({ path: `sites/${safeId(s.site.siteId)}/manifest.json`, bytes: m, role: 'evidence' })
  }
  const exportedFiles = await manifestEntries(content)
  const reportInput: ReportInput = { ...params, generatedAt, exportedFiles, standards }
  const markdown = buildMarkdownReport(reportInput)
  const html = buildHtmlReport(reportInput)
  content.push({ path: 'audit_report.md', bytes: enc.encode(markdown), role: 'evidence' })
  content.push({ path: 'audit_report.html', bytes: enc.encode(html), role: 'evidence' })

  const manifest: StudyPackManifest = {
    packVersion: PACK_VERSION,
    studyId: params.studyId,
    siteId: 'NETWORK',
    roleMode: 'admin',
    generatedAt,
    cdmVersion: params.config?.cdmVersion ?? adopted[0].manifest?.cdmVersion ?? 'unknown',
    files: await manifestEntries(content),
  }
  const zip = new JSZip()
  const root = zip.folder(`${safeId(params.studyId)}-submission`)!
  for (const c of content) root.file(c.path, c.bytes)
  root.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  return { zipBlob, zipName: `${safeId(params.studyId)}_regulatory_submission.zip`, defineXml, datasets, tables, markdown, html, manifest, standards }
}
