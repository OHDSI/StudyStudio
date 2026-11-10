/**
 * Export Hub: network audit report (Markdown + printable HTML for PDF) and the
 * regulatory submission ZIP (define.xml, Dataset-JSON, reports, per-site manifests).
 */
import JSZip from 'jszip'
import type { CrossSiteResult, LoadedSitePack, SiteVerdict } from '@/lib/network/aggregator'
import type { SiteEvidence } from '@/lib/studypack/evidence'
import { kidFingerprint, type DetachedJws, type SignatureCheck } from '@/lib/security/signer'
import type { DispositionEntry } from '@/lib/network/dispositionLog'
import { buildDefineXml, columnSasNames, datasetFiles, DEFAULT_ADAM_CT_VERSION, xmlEscape, type DatasetFormat, type DefineXmlVersion } from '@/lib/cdisc/defineXml'
import { writeXpt, xptLimitIssues } from '@/lib/cdisc/xpt'
import { checkDatasetsAgainstDefine, checkDefineXml } from '@/lib/cdisc/defineRules'
import { AGENCY_LABELS, expectedFindings, rateIssues, type Agency, type ExpectedFinding, type RatedIssue } from '@/lib/cdisc/validatorProfiles'
import { bundledStylesheet, type DefineStylesheet } from '@/lib/cdisc/stylesheet'
import { combineSiteCsvs, serializeDatasetJson, type CombinedTable, type DatasetJsonVersion } from '@/lib/cdisc/datasetJson'
import { parseMappingSpec, parseScanReport, type MappingSpec, type SourceTable } from '@/lib/cdisc/sources'
import { APP_VERSION, manifestEntries, safeId } from '@/lib/studypack/builder'
import { parseAnalysisSpecification, type AnalysisSpecSummary } from '@/lib/strategus/spec'
import { buildReviewersGuideHtml, buildReviewersGuideMarkdown, parseRenvLock, type ReviewersGuideInput } from './reviewersGuide'
import type { ValidatorRun } from '@/lib/cdisc/p21Report'
import { moduleOf, parseRdms, RDMS_FILE, tableNameOf, type Rdms } from '@/lib/strategus/results'
import { PROTOCOL_PATHS } from '@/lib/strategus/protocol'
import { RESULTS_DIR } from '@/lib/studypack/slots'
import { PACK_VERSION, type FileRole, type StudyConfig, type StudyPackManifest } from '@/types/studypack'

export interface SiteRow {
  site: LoadedSitePack
  verdict: SiteVerdict
  adopted: boolean
  evidence?: SiteEvidence
  /** Signature checks with roster enrollment applied. */
  signatures?: SignatureCheck[]
  /** Explicit decision recorded in the disposition log (undefined = following the recommendation, not yet decided). */
  decision?: 'adopt' | 'exclude'
}

export interface ReportInput {
  studyId: string
  studyTitle: string
  config?: StudyConfig
  cross: CrossSiteResult
  rows: SiteRow[]
  generatedAt: string
  exportedFiles?: { path: string; sha256: string; sizeBytes: number }[]
  standards?: Standards
  /** Result of the define.xml conformance checks, for the submission package. */
  conformance?: Conformance
  /** Disposition audit trail entries (R6). */
  disposition?: readonly DispositionEntry[]
  dispositionHead?: string
  /** Site ETL lineage (WhiteRabbit ScanReport, mapping specification) of the adopted sites. */
  etl?: SiteEtl[]
}

export interface Standards {
  defineXml: DefineXmlVersion
  /** Archive format of the datasets; absent = Dataset-JSON. */
  datasetFormat?: DatasetFormat
  /** Dataset-JSON version (when the datasets are Dataset-JSON). */
  datasetJson: DatasetJsonVersion
  /** CDISC/NCI ADaM CT package declared in define.xml (v2.1). */
  ctVersion?: string
  /** Agency whose validator profile rates the conformance issues (does not change the output). */
  agency?: Agency
}

export interface Conformance {
  issues: RatedIssue[]
  /** Findings a validator reports on this output by design, with the explanation for the reviewer's guide. */
  expected: ExpectedFinding[]
}

export interface SiteEtl {
  siteId: string
  scanTables?: SourceTable[]
  mapping?: MappingSpec
}

/** ETL lineage section: source tables profiled and source → OMOP CDM field mappings, per site. */
function etlSection(etl: SiteEtl[] | undefined): { md: string[]; html: string } {
  const sites = (etl ?? []).filter((e) => e.scanTables?.length || e.mapping?.fieldMaps.length || e.mapping?.tableMaps.length)
  if (!sites.length) return { md: [], html: '' }
  const intro = 'Source data never leaves the sites; these artifacts document how each site populated its OMOP CDM. They are not submitted datasets and are therefore not described in define.xml.'
  const md = ['## Data lineage (site ETL)', '', intro, '']
  let html = `<h2>Data lineage (site ETL)</h2><p>${xmlEscape(intro)}</p>`
  for (const e of sites) {
    md.push(`### ${e.siteId}`, '')
    html += `<h3>${xmlEscape(e.siteId)}</h3>`
    if (e.scanTables?.length) {
      md.push('Source tables profiled (WhiteRabbit ScanReport):', '', '| Source table | Rows profiled | Fields |', '|---|---|---|')
      for (const t of e.scanTables) md.push(`| ${mdCell(t.name)} | ${t.rows ?? '—'} | ${mdCell(t.fields.map((f) => (f.type ? `${f.name} (${f.type})` : f.name)).join(', '))} |`)
      md.push('')
      html += `<table><tr><th>Source table</th><th>Rows profiled</th><th>Fields</th></tr>${e.scanTables
        .map((t) => `<tr><td>${xmlEscape(t.name)}</td><td>${t.rows ?? '—'}</td><td>${xmlEscape(t.fields.map((f) => (f.type ? `${f.name} (${f.type})` : f.name)).join(', '))}</td></tr>`)
        .join('')}</table>`
    }
    const m = e.mapping
    if (m?.tableMaps.length || m?.fieldMaps.length) {
      md.push('Mapping specification (source → OMOP CDM):', '', '| Source | OMOP CDM target | Logic |', '|---|---|---|')
      const lines = [
        ...(m?.tableMaps ?? []).map((t) => [t.sourceTable, t.targetTable, t.logic ?? '']),
        ...(m?.fieldMaps ?? []).map((f) => [`${f.sourceTable}.${f.sourceField}`, `${f.targetTable}.${f.targetField}`, [f.logic ?? 'direct copy', f.comment].filter(Boolean).join(' — ')]),
      ]
      for (const [a, b, c] of lines) md.push(`| ${mdCell(a)} | ${mdCell(b)} | ${mdCell(c || '—')} |`)
      md.push('')
      html += `<table><tr><th>Source</th><th>OMOP CDM target</th><th>Logic</th></tr>${lines.map(([a, b, c]) => `<tr><td>${xmlEscape(a)}</td><td>${xmlEscape(b)}</td><td>${xmlEscape(c || '—')}</td></tr>`).join('')}</table>`
    }
  }
  return { md, html }
}

/** Latest decision entry per pack, for the disposition table. */
function lastDecision(entries: readonly DispositionEntry[] | undefined, packSha256: string): DispositionEntry | undefined {
  return [...(entries ?? [])].reverse().find((e) => (e.action === 'adopt' || e.action === 'exclude') && e.packSha256 === packSha256)
}

/** One-line summary of the run-record comparison for the audit report. */
function runRecordCell(e?: SiteEvidence): string {
  const r = e?.runRecord
  if (!r) return '—'
  if (!r.present) return 'none'
  const inputs = `${r.inputs.filter((c) => c.status === 'match').length}/${r.inputs.length} inputs match`
  return `${r.results.matched}/${r.results.recorded} results as written${r.results.withheld ? `, ${r.results.withheld} masked (checked at the site)` : ''}; ${inputs}`
}

function signatureLine(c?: SignatureCheck[]): string {
  if (!c?.length) return 'unsigned'
  return c.map((x) => `${x.valid ? (x.enrolled ? '✅' : '⚠️') : '❌'} ${x.signer?.name ?? '?'} (${x.signer?.role ?? '?'}, ${x.meaning ?? '?'}, ${x.signedAt ?? '?'}, key ${kidFingerprint(x.kid)}${x.valid && !x.enrolled ? `; ${x.enrollmentIssue}` : ''})`).join('; ')
}

function dispositionRows(i: ReportInput) {
  return i.rows.map((r) => {
    const d = lastDecision(i.disposition, r.site.zipSha256)
    return {
      siteId: r.site.siteId,
      pack: r.site.zipSha256,
      recommended: r.verdict.recommended,
      decision: r.decision ?? (r.adopted ? 'adopt (not recorded)' : 'exclude (not recorded)'),
      code: d?.reasonCode ?? '—',
      text: d?.reasonText ?? (r.verdict.reasons.join('; ') || '—'),
      by: d ? `${d.actor.name} (${d.actor.role}${d.actor.organization ? `, ${d.actor.organization}` : ''})` : '—',
      at: d?.at ?? '—',
      deviates: !!d?.deviatesFromRecommendation,
    }
  })
}

const LIMITATIONS = [
  'Seal, signature and decision times come from device clocks; no trusted time source is available offline. Seal times are only bounded by the protocol issue time and the coordinator receipt time.',
  'Masked results and redacted logs are represented by salted commitments; the originals and their salts are retained at each site.',
  'Data-quality evaluation checks the CDM’s internal consistency (OHDSI DQD); source-to-CDM reconciliation is documented by each data holder.',
  'Exported datasets contain aggregate Strategus results, not patient-level SDTM/ADaM data.',
  'Run records are written by R on each site’s machine. They show that the sealed results are the ones the recorded run wrote from the protocol’s inputs; they cannot rule out a record produced some other way. Masked results are compared with the record at the site only.',
]

/** "Dataset-JSON v1.1" or "SAS V5 transport (XPT)". */
export const datasetFormatLabel = (s: Pick<Standards, 'datasetFormat' | 'datasetJson'>) => (s.datasetFormat === 'xpt' ? 'SAS V5 transport (XPT)' : `Dataset-JSON v${s.datasetJson}`)

const standardsLine = (i: ReportInput) =>
  i.standards
    ? `CDISC Define-XML v${i.standards.defineXml} / ${datasetFormatLabel(i.standards)}` +
      `${i.standards.defineXml === '2.1' && i.standards.ctVersion ? ` / CDISC/NCI ADaM CT ${i.standards.ctVersion}` : ''}` +
      `${i.standards.agency ? ` / validator profile: ${AGENCY_LABELS[i.standards.agency]}` : ''}`
    : undefined

/** Conformance section: Study Studio's own checks and the validator findings expected by design. */
function conformanceSection(c: Conformance | undefined, agency: Agency | undefined): { md: string[]; html: string } {
  if (!c) return { md: [], html: '' }
  const rate = (s: Partial<Record<'FDA' | 'PMDA', string>>) =>
    agency && agency !== 'OTHER' ? (s[agency] ?? 'not rated') : `FDA ${s.FDA ?? '—'} / PMDA ${s.PMDA ?? '—'}`
  const md = ['## Define-XML conformance', '']
  let html = '<h2>Define-XML conformance</h2>'
  const summary = c.issues.length ? `${c.issues.length} issue(s) found by OHDSI Study Studio's define.xml checks.` : "No issues found by OHDSI Study Studio's define.xml checks (schema, references, SAS names, keys, lengths, datasets against define.xml)."
  md.push(summary, '')
  html += `<p>${xmlEscape(summary)}</p>`
  if (c.issues.length) {
    md.push('| Rule | Pinnacle 21 | Rating | Element | Issue |', '|---|---|---|---|---|')
    for (const i of c.issues) md.push(`| ${i.rule} | ${i.p21.join(', ') || '—'} | ${rate(i.severity)} | ${mdCell(i.target)} | ${mdCell(i.message)} |`)
    md.push('')
    html += `<table><tr><th>Rule</th><th>Pinnacle 21</th><th>Rating</th><th>Element</th><th>Issue</th></tr>${c.issues
      .map((i) => `<tr><td>${i.rule}</td><td>${i.p21.join(', ') || '—'}</td><td>${rate(i.severity)}</td><td>${xmlEscape(i.target)}</td><td>${xmlEscape(i.message)}</td></tr>`)
      .join('')}</table>`
  }
  if (c.expected.length) {
    md.push('Validator findings expected by design (to be explained in the reviewer\'s guide):', '')
    html += "<p>Validator findings expected by design (to be explained in the reviewer's guide):</p><ul>"
    for (const e of c.expected) {
      const scope = e.scope === 'define' ? 'define.xml' : 'datasets'
      md.push(`- **${e.p21}** (${rate(e.severity)}; ${scope}): ${e.message}. ${e.explanation}`)
      html += `<li><b>${e.p21}</b> (${rate(e.severity)}; ${scope}): ${xmlEscape(e.message)}. ${xmlEscape(e.explanation)}</li>`
    }
    md.push('')
    html += '</ul>'
  }
  return { md, html }
}

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
    decision: (r.adopted
      ? r.verdict.recommended === 'exclude' ? 'Adopted (against recommendation)' : 'Adopted'
      : r.verdict.recommended === 'adopt' ? 'Excluded (against recommendation)' : 'Excluded') + (r.decision ? '' : ' — not recorded'),
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
  L.push(`- **Generated:** ${i.generatedAt} by OHDSI Study Studio ${APP_VERSION} (offline, in-browser)`)
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

  const lock = i.disposition?.find((e) => e.action === 'lock')
  L.push('## 4. Site disposition', '')
  L.push(`- **Assurance level:** ${i.config?.assurance ?? 'standard'}`)
  L.push(`- **Exclusion reasons pre-specified in the protocol:** ${(i.config?.adoptionPolicy?.reasonCodes ?? []).map((r) => r.code).join(', ') || '— (default reason codes)'}`)
  L.push(`- **Dispositions locked:** ${lock ? `yes — by ${lock.actor.name} at ${lock.at}. Attestation: “${lock.reasonText ?? ''}”` : 'no'}`, '')
  L.push('| Site | Pack SHA-256 | Recommended | Decision | Reason code | Justification / reasons | Decided by | When (UTC) |', '|---|---|---|---|---|---|---|---|')
  for (const d of dispositionRows(i))
    L.push(`| ${mdCell(d.siteId)} | \`${short(d.pack)}\` | ${d.recommended} | **${d.decision}**${d.deviates ? ' ⚠️ against recommendation' : ''} | ${d.code} | ${mdCell(d.text)} | ${mdCell(d.by)} | ${d.at} |`)
  L.push('')

  L.push('## 5. Signatures, data quality and provenance', '')
  L.push('| Site | Signatures | DQD gate (block/warn) | CDM / vocabulary | Log errors | Run record | Provenance, run & time issues |', '|---|---|---|---|---|---|---|')
  for (const r of i.rows) {
    const e = r.evidence
    const cs = e?.provenance.cdmSource
    const issues = e ? [...e.provenance.issues.map((x) => x.message), ...(e.runRecord?.issues ?? []).map((x) => `Run record: ${x.message}`), ...e.timeline.issues.map((x) => x.message)] : []
    L.push(
      `| ${mdCell(r.site.siteId)} | ${mdCell(signatureLine(r.signatures))} | ${e ? `${e.dqdGate.counts.block}/${e.dqdGate.counts.warn} (${e.dqdGate.checksEvaluated} checks, policy ${e.dqdPolicy.policyVersion})` : '—'} | ${cs ? mdCell(`${cs.cdmSourceName ?? '?'} · CDM ${cs.cdmVersion ?? '?'} · ${cs.vocabularyVersion ?? '?'}`) : '—'} | ${e?.log ? e.log.counts.ERROR + e.log.counts.FATAL : 'no log'} | ${mdCell(runRecordCell(e))} | ${mdCell(issues.join('; ') || '—')} |`,
    )
  }
  L.push('')

  if (i.disposition?.length) {
    L.push('## 6. Disposition audit trail', '')
    L.push(`Append-only; each entry carries the SHA-256 of the previous one. Head: \`${i.dispositionHead ?? '—'}\` (${i.disposition.length} entries).`, '')
    L.push('| # | When (UTC) | Who | Action | Site | Change | Reason |', '|---|---|---|---|---|---|---|')
    for (const e of i.disposition)
      L.push(`| ${e.seq} | ${e.at} | ${mdCell(`${e.actor.name} (${e.actor.role})`)} | ${e.action} | ${mdCell(e.siteId ?? '—')} | ${e.to ? `${e.from ?? '—'} → ${e.to}` : '—'} | ${mdCell([e.reasonCode, e.reasonText].filter(Boolean).join(': ') || '—')} |`)
    L.push('')
  }

  L.push(...etlSection(i.etl).md)
  L.push(...conformanceSection(i.conformance, i.standards?.agency).md)

  L.push('## Limitations', '')
  for (const l of LIMITATIONS) L.push(`- ${l}`)
  L.push('')

  if (i.exportedFiles?.length) {
    L.push('## 7. Submission package contents', '')
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
Generated ${xmlEscape(i.generatedAt)} · OHDSI Study Studio ${APP_VERSION} · min cell count ${i.config?.minCellCount ?? 5}<br>
Sites received ${i.rows.length} · adopted ${adopted} · excluded ${i.rows.length - adopted}${i.standards ? `<br>${standardsLine(i)}` : ''}</div>
<h2>1. Protocol reference hashes (SHA-256)</h2>
<table><tr><th>Artifact</th><th>Reference</th><th>Source</th></tr>${refs}</table>
<h2>2. Site verification summary</h2>
<table><tr><th>Site</th><th>Manifest</th><th>Analysis spec</th><th>ExecuteAnalyses.R</th><th>renv.lock</th><th>DQD</th><th>Small cells</th><th>Decision</th><th>Reasons</th></tr>
${rows}</table>
${htmlDisposition(i)}
${etlSection(i.etl).html}
${conformanceSection(i.conformance, i.standards?.agency).html}
${files ? `<h2>7. Submission package contents</h2><table><tr><th>File</th><th>SHA-256</th><th>Bytes</th></tr>${files}</table>` : ''}
<p class="foot">All processing was performed client-side; no data was transmitted to any server.</p>
</body></html>
`
}

function htmlDisposition(i: ReportInput): string {
  const lock = i.disposition?.find((e) => e.action === 'lock')
  const disp = dispositionRows(i)
    .map((d) => `<tr><td>${xmlEscape(d.siteId)}</td><td><code>${short(d.pack)}</code></td><td>${d.recommended}</td><td><b>${xmlEscape(d.decision)}</b>${d.deviates ? ' ⚠️' : ''}</td><td>${xmlEscape(d.code)}</td><td>${xmlEscape(d.text)}</td><td>${xmlEscape(d.by)}</td><td>${d.at}</td></tr>`)
    .join('\n')
  const ev = i.rows
    .map((r) => {
      const e = r.evidence
      const cs = e?.provenance.cdmSource
      const issues = e ? [...e.provenance.issues.map((x) => x.message), ...(e.runRecord?.issues ?? []).map((x) => `Run record: ${x.message}`), ...e.timeline.issues.map((x) => x.message)] : []
      return `<tr><td>${xmlEscape(r.site.siteId)}</td><td>${xmlEscape(signatureLine(r.signatures))}</td><td>${e ? `${e.dqdGate.counts.block}/${e.dqdGate.counts.warn}` : '—'}</td><td>${cs ? xmlEscape(`${cs.cdmSourceName ?? '?'} · CDM ${cs.cdmVersion ?? '?'} · ${cs.vocabularyVersion ?? '?'}`) : '—'}</td><td>${e?.log ? e.log.counts.ERROR + e.log.counts.FATAL : 'no log'}</td><td>${xmlEscape(runRecordCell(e))}</td><td>${xmlEscape(issues.join('; ') || '—')}</td></tr>`
    })
    .join('\n')
  const trail = (i.disposition ?? [])
    .map((e) => `<tr><td>${e.seq}</td><td>${e.at}</td><td>${xmlEscape(`${e.actor.name} (${e.actor.role})`)}</td><td>${e.action}</td><td>${xmlEscape(e.siteId ?? '—')}</td><td>${e.to ? `${e.from ?? '—'} → ${e.to}` : '—'}</td><td>${xmlEscape([e.reasonCode, e.reasonText].filter(Boolean).join(': ') || '—')}</td></tr>`)
    .join('\n')
  return `<h2>4. Site disposition</h2>
<p>Assurance: ${i.config?.assurance ?? 'standard'} · Dispositions locked: ${lock ? `yes — ${xmlEscape(lock.actor.name)} at ${lock.at}` : 'no'}</p>
<table><tr><th>Site</th><th>Pack</th><th>Recommended</th><th>Decision</th><th>Code</th><th>Justification / reasons</th><th>Decided by</th><th>When (UTC)</th></tr>${disp}</table>
<h2>5. Signatures, data quality and provenance</h2>
<table><tr><th>Site</th><th>Signatures</th><th>DQD block/warn</th><th>CDM / vocabulary</th><th>Log errors</th><th>Run record</th><th>Issues</th></tr>${ev}</table>
${trail ? `<h2>6. Disposition audit trail</h2><p>Head <code>${i.dispositionHead ?? '—'}</code></p><table><tr><th>#</th><th>When (UTC)</th><th>Who</th><th>Action</th><th>Site</th><th>Change</th><th>Reason</th></tr>${trail}</table>` : ''}
<h2>Limitations</h2><ul>${LIMITATIONS.map((l) => `<li>${xmlEscape(l)}</li>`).join('')}</ul>`
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
  /** The table copies the analysis specification (see SPECIFICATION_TABLES) rather than holding results. */
  specification: boolean
}

/**
 * Strategus tables that store the study's own specification (cohort definitions with their JSON and SQL,
 * cohort subset operators, analysis settings) rather than results. They are pinned and hash-verified as the analysis specification,
 * so the Export Hub leaves them out of the datasets by default.
 */
export const SPECIFICATION_TABLES: ReadonlySet<string> = new Set([
  'cg_cohort_definition',
  'cg_cohort_subset_definition',
  'cg_cohort_subset_operator',
  'cg_cohort_template_definition',
  'cm_analysis',
  'sccs_analysis',
])

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
      const info = map.get(key) ?? { key, module: moduleOf(rel), table: tableNameOf(rel), sites: 0, rows: 0, specification: SPECIFICATION_TABLES.has(tableNameOf(rel)) }
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
  /** Dataset-JSON text, or XPT bytes, per archive path (see datasetFiles). */
  datasets: Record<string, string | Uint8Array>
  tables: CombinedTable[]
  markdown: string
  html: string
  manifest: StudyPackManifest
  standards: Standards
  conformance: Conformance
  /** Draft Analysis Data Reviewer's Guide (not sealed in the package: it is meant to be completed). */
  reviewersGuide: { markdown: string; html: string }
  /** What the guide was built from, to rebuild it with the reports of validator runs on this package. */
  reviewersGuideInput: ReviewersGuideInput
}

export async function buildRegulatoryExport(params: {
  studyId: string
  studyTitle: string
  config?: StudyConfig
  cross: CrossSiteResult
  rows: SiteRow[]
  defineXmlVersion?: DefineXmlVersion
  /** CDISC/NCI ADaM CT package to declare in define.xml v2.1 (default DEFAULT_ADAM_CT_VERSION). */
  ctVersion?: string
  /** Agency whose validator profile rates the conformance issues; the output is the same for every agency. */
  agency?: Agency
  datasetJsonVersion?: DatasetJsonVersion
  /** Dataset-JSON (default) or SAS V5 transport files. */
  datasetFormat?: DatasetFormat
  /** "<Module>/<table>" keys to include; default all. */
  tables?: string[]
  now?: Date
  /** Define-XML stylesheet to archive next to define.xml; default the one bundled for the chosen version, if any. null = none. */
  stylesheet?: DefineStylesheet | null
  /** Disposition audit trail to ship with the package (R6.4). */
  disposition?: { entries: readonly DispositionEntry[]; jsonl: string; headHash: string; head: Uint8Array; headSignature?: DetachedJws }
}): Promise<RegulatoryExport> {
  // Authoritative gate (the Export Hub also disables the button): in a regulatory study the dispositions
  // must be decided for every site and locked before anything comparative is produced (R6.3).
  if (params.config?.assurance === 'regulatory') {
    const d = params.disposition
    if (!d?.entries.some((e) => e.action === 'lock')) throw new Error('Regulatory study: lock the site dispositions before generating the submission package')
    const undecided = params.rows.filter((r) => !r.decision).map((r) => r.site.siteId)
    if (undecided.length) throw new Error(`Regulatory study: no recorded decision for ${undecided.join(', ')}`)
  }
  const defineXmlVersion = params.defineXmlVersion ?? '2.1'
  const ctVersion = params.ctVersion?.trim() || DEFAULT_ADAM_CT_VERSION
  if (defineXmlVersion === '2.1' && !/^\d{4}-\d{2}-\d{2}$/.test(ctVersion)) throw new Error(`CT version "${ctVersion}" is not a CDISC package date (YYYY-MM-DD)`)
  const standards: Standards = {
    defineXml: defineXmlVersion,
    datasetJson: params.datasetJsonVersion ?? '1.1',
    ...(params.datasetFormat === 'xpt' ? { datasetFormat: 'xpt' as const } : {}),
    ...(defineXmlVersion === '2.1' ? { ctVersion } : {}),
    ...(params.agency ? { agency: params.agency } : {}),
  }
  const generatedAt = (params.now ?? new Date()).toISOString()
  // Sorted so the datasets do not depend on the order the packs were dropped in.
  const adopted = params.rows
    .filter((r) => r.adopted)
    .map((r) => r.site)
    .sort((a, b) => (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0))
  if (adopted.length === 0) throw new Error('No adopted sites')

  // Cohorts come from the reference analysis specification (a site whose spec matches the reference hash).
  const specPath = PROTOCOL_PATHS.analysisSpecifications
  const refHash = params.cross.references[specPath]?.hash
  const refSite = adopted.find((s) => s.fileHashes[specPath] === refHash) ?? adopted.find((s) => s.files[specPath])
  let cohorts: { cohortId: number; cohortName: string; roles: string[]; expression?: Record<string, unknown> }[] = []
  let spec: AnalysisSpecSummary | undefined
  if (refSite?.files[specPath]) {
    try {
      spec = parseAnalysisSpecification(dec.decode(refSite.files[specPath]))
      cohorts = spec.cohorts
    } catch {
      /* spec unreadable: fall back to the protocol's cohort list */
    }
  }
  if (!cohorts.length && params.config) cohorts = params.config.cohorts

  // Site ETL lineage, reported in the audit report (not in define.xml: these are not submitted datasets).
  const etl: SiteEtl[] = adopted.map((s) => {
    let scanTables: SourceTable[] | undefined
    const x = s.files['etl/ScanReport_sanitized.xlsx']
    if (x) {
      try {
        scanTables = parseScanReport(x)
      } catch {
        /* unreadable workbook: reported without it */
      }
    }
    const mappingRaw = firstJson<unknown>([s], 'etl/mapping_specification.json')
    return { siteId: s.siteId, scanTables, mapping: mappingRaw ? parseMappingSpec(mappingRaw) : undefined }
  })

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

  const datasets: Record<string, string | Uint8Array> = {}
  const files = datasetFiles(tables, params.datasetFormat)
  if (params.datasetFormat === 'xpt') {
    const tooLong = tables.flatMap((t) => xptLimitIssues(t).map((x) => `${t.sourceTable}.${x}`))
    if (tooLong.length) throw new Error(`XPT cannot hold text longer than 200 bytes: ${tooLong.join('; ')}. Leave these tables out or export Dataset-JSON.`)
    for (const t of tables)
      datasets[files.get(t.name)!.path] = writeXpt(t, {
        name: files.get(t.name)!.sasName,
        variables: columnSasNames(t),
        labels: t.columns.map((c) => c.name.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (m) => m.toUpperCase())),
        label: t.label,
        now: params.now,
      })
  } else for (const t of tables)
    datasets[files.get(t.name)!.path] = serializeDatasetJson(standards.datasetJson, t, {
      studyOID,
      metaDataVersionOID: mdvOID,
      originator: params.config?.sponsor || 'OHDSI Study Studio',
      sourceVersion: APP_VERSION,
      now: params.now,
    })
  const stylesheet = params.stylesheet === undefined ? bundledStylesheet(standards.defineXml) : (params.stylesheet ?? undefined)
  const defineXml = buildDefineXml({
    version: standards.defineXml,
    studyId: params.studyId,
    studyTitle: params.studyTitle,
    description: params.config?.description,
    originator: params.config?.sponsor,
    sourceSystemVersion: APP_VERSION,
    cohorts,
    resultTables: tables,
    auditReportHref: 'audit_report.html',
    ctVersion,
    datasetFormat: params.datasetFormat,
    stylesheetHref: stylesheet?.name,
    now: params.now,
  })

  const content: { path: string; bytes: Uint8Array; role: FileRole }[] = [
    { path: 'define.xml', bytes: enc.encode(defineXml), role: 'metadata' },
    ...(stylesheet ? [{ path: stylesheet.name, bytes: enc.encode(stylesheet.text), role: 'metadata' as FileRole }] : []),
    ...Object.entries(datasets).map(([path, d]) => ({ path, bytes: typeof d === 'string' ? enc.encode(d) : d, role: 'result' as FileRole })),
  ]
  for (const s of [...params.rows].sort((a, b) => (a.site.siteId < b.site.siteId ? -1 : a.site.siteId > b.site.siteId ? 1 : 0))) {
    for (const f of ['manifest.json', 'manifest.jws.json', 'audit_report.json']) {
      const b = s.site.files[f]
      if (b) content.push({ path: `sites/${safeId(s.site.siteId)}/${f}`, bytes: b, role: 'evidence' })
    }
  }
  const d = params.disposition
  if (d) {
    content.push({ path: 'disposition/disposition_log.jsonl', bytes: enc.encode(d.jsonl), role: 'evidence' })
    content.push({ path: 'disposition/disposition_head.json', bytes: d.head, role: 'evidence' })
    if (d.headSignature) content.push({ path: 'disposition/disposition_head.jws.json', bytes: enc.encode(JSON.stringify(d.headSignature, null, 2) + '\n'), role: 'evidence' })
  }
  const exportedFiles = await manifestEntries(content)
  // Conformance of define.xml and the datasets, recorded in the audit report and shown in the Export Hub.
  const conformance: Conformance = {
    issues: rateIssues([...checkDefineXml(defineXml), ...checkDatasetsAgainstDefine(defineXml, datasets)]),
    expected: expectedFindings(standards.defineXml),
  }
  const reportInput: ReportInput = { ...params, generatedAt, exportedFiles, standards, conformance, disposition: d?.entries, dispositionHead: d?.headHash, etl }
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
    assurance: params.config?.assurance ?? 'standard',
    tool: { name: 'OHDSI Study Studio', version: APP_VERSION },
    files: await manifestEntries(content),
  }
  const zip = new JSZip()
  const root = zip.folder(`${safeId(params.studyId)}-submission`)!
  for (const c of content) root.file(c.path, c.bytes)
  root.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
  const renvPath = PROTOCOL_PATHS.renvLock
  const renvSite = adopted.find((s) => s.fileHashes[renvPath] === params.cross.references[renvPath]?.hash) ?? adopted.find((s) => s.files[renvPath])
  const reviewersGuideInput: ReviewersGuideInput = {
    studyId: params.studyId,
    studyTitle: params.studyTitle,
    config: params.config,
    generatedAt,
    standards,
    conformance,
    datasets: tables.map((t) => ({ table: t, ...files.get(t.name)! })),
    rows: params.rows,
    cross: params.cross,
    spec,
    renv: renvSite?.files[renvPath] ? parseRenvLock(dec.decode(renvSite.files[renvPath])) : undefined,
    etl,
    disposition: d?.entries,
  }
  const reviewersGuide = reviewersGuideFor(reviewersGuideInput)
  return { zipBlob, zipName: `${safeId(params.studyId)}_regulatory_submission.zip`, defineXml, datasets, tables, markdown, html, manifest, standards, conformance, reviewersGuide, reviewersGuideInput }
}

/** The draft reviewer's guide as Markdown and HTML, optionally with the reports of validator runs. */
export function reviewersGuideFor(input: ReviewersGuideInput, validatorRuns?: ValidatorRun[]): { markdown: string; html: string } {
  const markdown = buildReviewersGuideMarkdown(validatorRuns?.length ? { ...input, validatorRuns } : input)
  return { markdown, html: buildReviewersGuideHtml(markdown, input.studyId) }
}
