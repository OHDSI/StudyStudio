/**
 * Export Hub: network audit report (Markdown + printable HTML for PDF) and the
 * regulatory submission ZIP (define.xml, Dataset-JSON, reports, per-site manifests).
 */
import JSZip from 'jszip'
import { protocolChain, sealedIssues, type ChainEntry, type CrossSiteResult, type LoadedSitePack, type SiteVerdict } from '@/lib/network/aggregator'
import { sha256Hex } from '@/lib/integrity/hasher'
import type { SiteEvidence } from '@/lib/studypack/evidence'
import { kidFingerprint, type DetachedJws, type SignatureCheck } from '@/lib/security/signer'
import { unaccountedSites, type DispositionEntry } from '@/lib/network/dispositionLog'
import type { PlausibilityFinding } from '@/lib/network/plausibility'
import { buildDefineXml, columnSasNames, datasetFiles, DEFAULT_ADAM_CT_VERSION, xmlEscape, type DatasetFormat, type DefineXmlVersion } from '@/lib/cdisc/defineXml'
import { writeXpt, xptLimitIssues } from '@/lib/cdisc/xpt'
import { simplifiedTsFor, writeSimplifiedTs, type SimplifiedTs } from '@/lib/cdisc/simplifiedTs'
import { checkDatasetsAgainstDefine, checkDefineXml } from '@/lib/cdisc/defineRules'
import { AGENCY_LABELS, expectedFindings, rateIssues, type Agency, type ExpectedFinding, type RatedIssue } from '@/lib/cdisc/validatorProfiles'
import { bundledStylesheet, type DefineStylesheet } from '@/lib/cdisc/stylesheet'
import { combineSiteCsvs, serializeDatasetJson, type CombinedTable, type DatasetJsonVersion } from '@/lib/cdisc/datasetJson'
import { parseMappingSpec, parseScanReport, type MappingSpec, type SourceTable } from '@/lib/cdisc/sources'
import { APP_VERSION, manifestEntries, safeId, TOOL } from '@/lib/studypack/builder'
import { parseAnalysisSpecification, type AnalysisSpecSummary } from '@/lib/strategus/spec'
import { buildReviewersGuideHtml, buildReviewersGuideMarkdown, parseRenvLock, registrationText, type ReviewersGuideInput } from './reviewersGuide'
import type { ValidatorRun } from '@/lib/cdisc/p21Report'
import { buildDataDefinitionHtml } from './dataDefinition'
import { markdownToHtml } from './markdown'
import { PROFILE_NOTE, profileLabel, profileRequirements } from '@/lib/strategus/profiles'
import { crossSiteEvidence, HETEROGENEITY_COLUMNS, type CrossSiteEvidence } from '@/lib/network/crossSiteEvidence'
import { collectProtocolArtefacts, type ProtocolArtefacts, type ProtocolSource, type RosterSource } from './protocolArtefacts'
import { moduleOf, parseRdms, RDMS_FILE, tableNameOf, type Rdms } from '@/lib/strategus/results'
import { PROTOCOL_PATHS } from '@/lib/strategus/protocol'
import { RESULTS_DIR } from '@/lib/studypack/slots'
import { issueLabel, isRScriptStudy, PACK_VERSION, type FileRole, type StudyConfig, type StudyPackManifest } from '@/types/studypack'

export interface SiteRow {
  site: LoadedSitePack
  verdict: SiteVerdict
  adopted: boolean
  evidence?: SiteEvidence
  /** Signature checks with roster enrollment applied. */
  signatures?: SignatureCheck[]
  /** Plausibility findings for review (never exclude a site by themselves). */
  plausibility?: PlausibilityFinding[]
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
  /** Protocol artefacts shipped in the submission package (C1). */
  protocolArtefacts?: ProtocolArtefacts
  /** Amendment chain, newest first (P1). */
  chain?: ChainEntry[]
  /** Attrition, concept-set resolution and heterogeneity across the adopted sites (A2, E1, X1); report-only. */
  crossSite?: CrossSiteEvidence
}

/**
 * How the package presents the datasets.
 * - aggregated-results (default): non-standard data, not SDTM or ADaM. define.xml, the datasets and a
 *   human-readable data definition go under misc/ (PMDA's place for non-standard data); define.xml is a
 *   reference data definition and is not to be tagged as an ADaM analysis data definition. No regulator
 *   defines a format for aggregated network results, and validating them as ADaM reports a missing ADSL.
 * - adam-other: the datasets are declared as non-standard ("ADAM OTHER") datasets of an ADaM submission,
 *   at the package root, for when an agency asks for that.
 */
export const SUBMISSION_PROFILES = ['aggregated-results', 'adam-other'] as const
export type SubmissionProfile = (typeof SUBMISSION_PROFILES)[number]
export const PROFILE_LABELS: Record<SubmissionProfile, string> = {
  'aggregated-results': 'Aggregated results (non-standard data)',
  'adam-other': 'ADaM submission (non-standard ADAM OTHER datasets)',
}

export interface Standards {
  /** Absent in exports made before profiles existed (= adam-other). */
  profile?: SubmissionProfile
  defineXml: DefineXmlVersion
  /** Archive format of the datasets; absent = Dataset-JSON. */
  datasetFormat?: DatasetFormat
  /** Dataset-JSON version (when the datasets are Dataset-JSON). */
  datasetJson: DatasetJsonVersion
  /** CDISC/NCI ADaM CT package declared in define.xml (v2.1). */
  ctVersion?: string
  /** Agency whose validator profile rates the conformance issues (does not change the output). */
  agency?: Agency
  /** FDA simplified ts.xpt shipped at the package root (TCG 8.1.2.2, Appendix G). */
  simplifiedTs?: SimplifiedTs
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
        .map((t) => `<tr><td>${xmlEscape(t.name)}</td><td>${xmlEscape(String(t.rows ?? '—'))}</td><td>${xmlEscape(t.fields.map((f) => (f.type ? `${f.name} (${f.type})` : f.name)).join(', '))}</td></tr>`)
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
  const packs = i.rows.map((r) => {
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
  // A1: sites from the protocol's site list recorded as not received (no pack).
  const received = new Set(i.rows.map((r) => r.site.siteId))
  const notReceived = (i.disposition ?? [])
    .filter((e) => e.action === 'not-received' && e.siteId && !received.has(e.siteId))
    .map((e) => ({
      siteId: e.siteId!,
      pack: undefined as string | undefined,
      recommended: '—',
      decision: 'not received',
      code: e.reasonCode ?? '—',
      text: e.reasonText ?? '—',
      by: `${e.actor.name} (${e.actor.role}${e.actor.organization ? `, ${e.actor.organization}` : ''})`,
      at: e.at,
      deviates: false,
    }))
  return [...packs, ...notReceived]
}

/** "Sites in the protocol's site list" line of the disposition section (C2/A1); undefined without a list. */
export function siteListLine(i: Pick<ReportInput, 'config' | 'rows' | 'disposition'>): string | undefined {
  const list = i.config?.sites
  if (!list?.length) return undefined
  const received = new Set(i.rows.map((r) => r.site.siteId))
  const without = list.filter((s) => !received.has(s.siteId)).map((s) => s.siteId)
  const recorded = new Set((i.disposition ?? []).filter((e) => e.action === 'not-received').map((e) => e.siteId))
  const unaccounted = unaccountedSites(list, i.rows.map((r) => r.site), i.disposition ?? [])
  const parts = [`${list.length} listed`, `${without.length} without a pack${without.length ? ` (${without.map((s) => `${s}${recorded.has(s) ? ': recorded as not received' : ''}`).join(', ')})` : ''}`]
  if (unaccounted.length) parts.push(`not yet accounted for: ${unaccounted.join(', ')}`)
  return parts.join('; ')
}

const LIMITATIONS = [
  'Seal, signature and decision times come from device clocks, which the study’s SOPs require to be synchronised to an external standard and not changeable by users (EMA computerised systems guideline §5.5; FDA Q&A 2024 Q14); the tool cannot verify this, but warns when a loaded file is dated in the device’s future. Seal times are bounded by the protocol issue time and the coordinator receipt time.',
  'Masked results and redacted logs are represented by salted commitments; the originals and their salts are retained at each site.',
  'Data-quality evaluation checks the CDM’s internal consistency (OHDSI DQD); source-to-CDM reconciliation is documented by each data holder.',
  'Exported datasets contain aggregate Strategus results, not patient-level SDTM/ADaM data.',
  'Run records are written by R on each site’s machine. They show that the sealed results are the ones the recorded run wrote from the protocol’s inputs; they cannot rule out a record produced some other way. Plausibility checks across sites look for traces of copied or edited results; they cannot rule it out either. Masked results are compared with the record at the site only.',
]

/** "Dataset-JSON v1.1" or "SAS V5 transport (XPT)". */
export const datasetFormatLabel = (s: Pick<Standards, 'datasetFormat' | 'datasetJson'>) => (s.datasetFormat === 'xpt' ? 'SAS V5 transport (XPT)' : `Dataset-JSON v${s.datasetJson}`)

const standardsLine = (i: ReportInput) =>
  i.standards
    ? `${PROFILE_LABELS[i.standards.profile ?? 'adam-other']}: CDISC Define-XML v${i.standards.defineXml} / ${datasetFormatLabel(i.standards)}` +
      `${i.standards.defineXml === '2.1' && i.standards.ctVersion ? ` / CDISC/NCI ADaM CT ${i.standards.ctVersion}` : ''}` +
      `${i.standards.agency ? ` / validator profile: ${AGENCY_LABELS[i.standards.agency]}` : ''}` +
      `${i.standards.simplifiedTs ? ` / simplified ts.xpt (example ${i.standards.simplifiedTs.example})` : ''}`
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

/** Provenance, run-record and time issues, then the plausibility findings to review. */
function siteIssues(r: SiteRow): string[] {
  const e = r.evidence
  return [
    ...(e ? [...e.provenance.issues.map((x) => x.message), ...(e.runRecord?.issues ?? []).map((x) => `Run record: ${x.message}`), ...e.timeline.issues.map((x) => x.message)] : []),
    ...(r.verdict.warnings ?? []).map((w) => `Site list: ${w}`),
    ...(r.plausibility ?? []).map((f) => `Review: ${f.message}`),
  ]
}

/** "after T (protocol issue) and before T (coordinator receipt)", on the coordinator's device clock. */
function sealWindow(r: SiteRow): string | undefined {
  const w = r.evidence?.timeline.trustedWindow
  if (!w) return undefined
  return [w.from && `after ${w.from} (protocol issue)`, w.to && `before ${w.to} (coordinator receipt)`].filter(Boolean).join(' and ')
}

const PLAUSIBILITY_NOTE =
  'Findings marked “Review” come from plausibility checks (counts shared with another site, the same database or DQD run, counts that cannot occur together). They are for the coordinator’s review and never exclude a site by themselves.'

const short = (h?: string) => (h ? `${h.slice(0, 12)}…` : '—')
const pct = (n?: number) => (n === undefined ? '—' : `${n.toFixed(1)}%`)
const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

function siteFacts(r: SiteRow, cross: CrossSiteResult) {
  const s = r.site
  const checks = cross.perSite[s.key] ?? {}
  // A path the study does not compare (e.g. renv.lock in an R script study without one) is not a mismatch.
  const st = (p: string) => (!checks[p] ? '—' : checks[p].status === 'match' ? '✅ Match' : checks[p].status === 'missing' ? '⚠️ Missing' : '❌ Mismatch')
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

type SiteFacts = ReturnType<typeof siteFacts>

/** Columns of the site verification summary. An R script study has no specification or DQD to show. */
function summaryColumns(i: ReportInput): { label: string; value: (f: SiteFacts) => string; escape?: boolean }[] {
  const rScript = isRScriptStudy(i.config ?? i.rows.find((r) => r.site.sealedProtocol)?.site.sealedProtocol)
  return [
    { label: 'Site', value: (f) => f.siteId, escape: true },
    { label: 'Manifest integrity', value: (f) => f.integrity },
    ...(rScript ? [] : [{ label: 'analysisSpecifications.json', value: (f: SiteFacts) => f.spec }]),
    { label: rScript ? 'R script' : 'ExecuteAnalyses.R', value: (f) => f.code },
    { label: 'renv.lock', value: (f) => f.renv },
    ...(rScript ? [] : [{ label: 'DQD pass rate', value: (f: SiteFacts) => f.dqd }]),
    { label: 'Small-cell audit', value: (f) => f.cells },
    { label: 'Decision', value: (f) => f.decision },
    { label: 'Reasons', value: (f) => f.reasons, escape: true },
  ]
}

/** Shorter headers for the printable report. */
const HTML_HEADERS: Record<string, string> = { 'Manifest integrity': 'Manifest', 'analysisSpecifications.json': 'Analysis spec', 'DQD pass rate': 'DQD', 'Small-cell audit': 'Small cells' }

export function buildMarkdownReport(i: ReportInput): string {
  const adopted = i.rows.filter((r) => r.adopted)
  const L: string[] = []
  L.push(`# Network Integrity & Privacy Audit Report — ${i.studyId}`, '')
  L.push(`- **Study:** ${i.studyTitle}`)
  if (i.config?.principalInvestigator) L.push(`- **Principal Investigator:** ${i.config.principalInvestigator}`)
  if (i.config?.sponsor) L.push(`- **Sponsor:** ${i.config.sponsor}`)
  L.push(`- **Generated:** ${i.generatedAt} by OHDSI Study Studio ${APP_VERSION} (offline, in-browser)`)
  L.push(`- **Protocol issued:** ${i.config ? issueLabel(i.config) : '— (no study_config.json loaded; majority hashes used as reference)'}`)
  L.push(...planLines(i).map((l) => `- ${l.md}`))
  L.push(`- **Minimum cell count:** ${i.config?.minCellCount ?? 5} (values 0 < n < ${i.config?.minCellCount ?? 5} must be suppressed)`)
  if (i.standards) L.push(`- **Submission standards:** ${standardsLine(i)}`)
  L.push(`- **Sites received:** ${i.rows.length} / **adopted:** ${adopted.length} / **excluded:** ${i.rows.length - adopted.length}`, '')

  L.push('## 1. Protocol reference hashes (SHA-256)', '')
  L.push('| Artifact | Reference | Source |', '|---|---|---|')
  for (const [p, r] of Object.entries(i.cross.references)) L.push(`| \`${p}\`${r.kind === 'section' ? ' (protected section)' : ''} | \`${r.hash ?? '—'}\` | ${r.source} |`)
  L.push('')
  L.push(...protocolArtefactsSection(i.protocolArtefacts).md)

  L.push('## 2. Site verification summary', '')
  const cols = summaryColumns(i)
  L.push(`| ${cols.map((c) => c.label).join(' | ')} |`)
  L.push(`|${cols.map(() => '---').join('|')}|`)
  for (const r of i.rows) {
    const f = siteFacts(r, i.cross)
    L.push(`| ${cols.map((c) => (c.label === 'Decision' ? `**${c.value(f)}**` : c.escape ? mdCell(c.value(f)) : c.value(f))).join(' | ')} |`)
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
    const w = sealWindow(r)
    if (w) L.push(`- Seal-time window: ${w}`)
    if (s.reAudit) {
      L.push(`- Coordinator re-audit of ${s.reAudit.files} ${isRScriptStudy(i.config ?? s.sealedProtocol) ? '' : 'Strategus '}result file(s): ${s.reAudit.scannedCells} cells scanned, ${s.reAudit.smallCellCount} small cells, ${s.reAudit.identifierCount} identifier columns`)
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
  const sitesLine = siteListLine(i)
  if (sitesLine) L.push(`- **Sites in the protocol's site list:** ${sitesLine}`)
  L.push(`- **Dispositions locked:** ${lock ? `yes — by ${lock.actor.name} at ${lock.at}. Attestation: “${lock.reasonText ?? ''}”` : 'no'}`, '')
  L.push('| Site | Pack SHA-256 | Recommended | Decision | Reason code | Justification / reasons | Decided by | When (UTC) |', '|---|---|---|---|---|---|---|---|')
  for (const d of dispositionRows(i))
    L.push(`| ${mdCell(d.siteId)} | \`${short(d.pack)}\` | ${d.recommended} | **${d.decision}**${d.deviates ? ' ⚠️ against recommendation' : ''} | ${d.code} | ${mdCell(d.text)} | ${mdCell(d.by)} | ${d.at} |`)
  L.push('')

  L.push('## 5. Signatures, data quality and provenance', '')
  if (i.rows.some((r) => r.plausibility?.length)) L.push(PLAUSIBILITY_NOTE, '')
  L.push('| Site | Signatures | DQD gate (block/warn) | CDM / vocabulary | Source release | Data cut-off | Log errors | Run record | Provenance, run & time issues |', '|---|---|---|---|---|---|---|---|---|')
  for (const r of i.rows) {
    const e = r.evidence
    const cs = e?.provenance.cdmSource
    const issues = siteIssues(r)
    L.push(
      `| ${mdCell(r.site.siteId)} | ${mdCell(signatureLine(r.signatures))} | ${e ? `${e.dqdGate.counts.block}/${e.dqdGate.counts.warn} (${e.dqdGate.checksEvaluated} checks, policy ${e.dqdPolicy.policyVersion})` : '—'} | ${cs ? mdCell(`${cs.cdmSourceName ?? '?'} · CDM ${cs.cdmVersion ?? '?'} · ${cs.vocabularyVersion ?? '?'}`) : '—'} | ${mdCell(cs?.sourceReleaseDate ?? '—')} | ${mdCell(cs?.maxObservationPeriodEndDate ?? '—')} | ${e?.log ? e.log.counts.ERROR + e.log.counts.FATAL : 'no log'} | ${mdCell(runRecordCell(e))} | ${mdCell(issues.join('; ') || '—')} |`,
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

  L.push(...crossSiteSection(i.crossSite).md)
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
  const cols = summaryColumns(i)
  const rows = i.rows
    .map((r) => {
      const f = siteFacts(r, i.cross)
      return `<tr class="${r.adopted ? '' : 'excluded'}">${cols.map((c) => `<td>${c.label === 'Decision' ? `<b>${xmlEscape(c.value(f))}</b>` : xmlEscape(c.value(f))}</td>`).join('')}</tr>`
    })
    .join('\n')
  const refs = Object.entries(i.cross.references)
    .map(([p, r]) => `<tr><td><code>${xmlEscape(p)}</code>${r.kind === 'section' ? ' (protected section)' : ''}</td><td><code>${xmlEscape(r.hash ?? '—')}</code></td><td>${xmlEscape(r.source)}</td></tr>`)
    .join('\n')
  const files = (i.exportedFiles ?? []).map((f) => `<tr><td><code>${xmlEscape(f.path)}</code></td><td><code>${xmlEscape(f.sha256)}</code></td><td>${xmlEscape(String(f.sizeBytes))}</td></tr>`).join('\n')
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
Generated ${xmlEscape(i.generatedAt)} · OHDSI Study Studio ${APP_VERSION} · min cell count ${xmlEscape(String(i.config?.minCellCount ?? 5))}<br>
Sites received ${i.rows.length} · adopted ${adopted} · excluded ${i.rows.length - adopted}${i.standards ? `<br>${xmlEscape(standardsLine(i) ?? '')}` : ''}${planLines(i).map((l) => `<br>${xmlEscape(l.text)}`).join('')}</div>
<h2>1. Protocol reference hashes (SHA-256)</h2>
<table><tr><th>Artifact</th><th>Reference</th><th>Source</th></tr>${refs}</table>
${protocolArtefactsSection(i.protocolArtefacts).html}
<h2>2. Site verification summary</h2>
<table><tr>${cols.map((c) => `<th>${HTML_HEADERS[c.label] ?? c.label}</th>`).join('')}</tr>
${rows}</table>
${htmlDisposition(i)}
${crossSiteSection(i.crossSite).html}
${etlSection(i.etl).html}
${conformanceSection(i.conformance, i.standards?.agency).html}
${files ? `<h2>7. Submission package contents</h2><table><tr><th>File</th><th>SHA-256</th><th>Bytes</th></tr>${files}</table>` : ''}
<p class="foot">All processing was performed client-side; no data was transmitted to any server.</p>
</body></html>
`
}

const CAP = { groups: 10, rules: 50, concepts: 100, dqd: 50 }
const more = (n: number, cap: number, what: string) => (n > cap ? [`_… and ${n - cap} more ${what} (in the exported datasets)._`, ''] : [])

/** Cross-site evidence for review (A2, E1, X1). Nothing in it excludes a site or blocks an export. */
function crossSiteSection(ev: CrossSiteEvidence | undefined): { md: string[]; html: string } {
  if (!ev || !ev.heterogeneity.rows.length) return { md: [], html: '' }
  const md: string[] = ['## Cross-site evidence (for review)', '', CROSS_SITE_NOTE, '']
  const h = ev.heterogeneity
  md.push('### Site heterogeneity', '', 'Cells marked ⚠ differ from the majority of the adopted sites.', '')
  md.push(`| Site | ${HETEROGENEITY_COLUMNS.join(' | ')} |`, `|---|${HETEROGENEITY_COLUMNS.map(() => '---').join('|')}|`)
  for (const r of h.rows) md.push(`| ${mdCell(r.siteId)} | ${HETEROGENEITY_COLUMNS.map((c) => `${r.differing.includes(c) ? '⚠ ' : ''}${mdCell(r.values[c] ?? '—')}`).join(' | ')} |`)
  md.push('')
  for (const f of h.findings) md.push(`- Review: ${mdCell(f)}`)
  if (h.findings.length) md.push('')
  if (h.dqdDifferences.length) {
    md.push('DQD checks that fail at some adopted sites but not at others:', '', '| Check | Table | Field | Fails at | Passes at |', '|---|---|---|---|---|')
    for (const d of h.dqdDifferences.slice(0, CAP.dqd)) md.push(`| ${mdCell(d.check)} | ${mdCell(d.table ?? '—')} | ${mdCell(d.field ?? '—')} | ${mdCell(d.failingAt.join(', '))} | ${mdCell(d.passingAt.join(', '))} |`)
    md.push('', ...more(h.dqdDifferences.length, CAP.dqd, 'checks'))
  }
  const attr = ev.attrition.filter((a) => a.cohortMethod?.length || a.inclusionRules?.length)
  if (attr.length || ev.missingAttrition.length) {
    md.push('### Attrition', '', 'Counts as each site reported them; censored counts are shown as <k.', '')
    for (const site of ev.missingAttrition) md.push(`- Review: ${mdCell(site)} has no CohortMethod attrition table although CohortMethod is in the analysis specification.`)
    if (ev.missingAttrition.length) md.push('')
    for (const a of attr) {
      md.push(`#### ${mdCell(a.siteId)}`, '')
      for (const g of (a.cohortMethod ?? []).slice(0, CAP.groups)) {
        md.push(`CohortMethod attrition (${mdCell(Object.entries(g.key).map(([k, v]) => `${k} ${v}`).join(', ') || 'all')}):`, '', '| Step | Description | Subjects |', '|---|---|---|')
        for (const s of g.steps) md.push(`| ${s.sequence} | ${mdCell(s.description)} | ${s.subjects} |`)
        md.push('')
      }
      md.push(...more(a.cohortMethod?.length ?? 0, CAP.groups, 'attrition groups'))
      if (a.inclusionRules?.length) {
        md.push('CohortGenerator inclusion rules:', '', '| Cohort | Rule | Name | Persons | Gain | Total | Mode |', '|---|---|---|---|---|---|---|')
        for (const r of a.inclusionRules.slice(0, CAP.rules)) md.push(`| ${mdCell(r.cohortId)} | ${mdCell(r.rule)} | ${mdCell(r.name ?? '—')} | ${r.personCount} | ${r.gainCount ?? '—'} | ${r.personTotal ?? '—'} | ${mdCell(r.modeId ?? '—')} |`)
        md.push('', ...more(a.inclusionRules.length, CAP.rules, 'rule rows'))
      }
    }
  }
  if (ev.concepts.length) {
    const sites = h.rows.map((r) => r.siteId)
    md.push('### Concept-set resolution', '', 'Per concept set, the first 12 characters of the SHA-256 of the sorted standard concept IDs resolved at each site (CohortDiagnostics), the number of concepts, and the number of distinct source codes mapped. Cells marked ⚠ differ from the majority.', '')
    md.push(`| Cohort | Concept set | ${sites.map(mdCell).join(' | ')} |`, `|---|---|${sites.map(() => '---').join('|')}|`)
    for (const c of ev.concepts.slice(0, CAP.concepts))
      md.push(`| ${mdCell(c.cohortId)} | ${mdCell(`${c.conceptSetId}${c.name ? ` ${c.name}` : ''}`)} | ${sites.map((s) => { const v = c.sites[s]; return v ? `${c.differing.includes(s) ? '⚠ ' : ''}\`${v.sha256.slice(0, 12)}\` (${v.concepts} concepts${v.sourceCodes !== undefined ? `, ${v.sourceCodes} source codes` : ''}${v.from === 'included' ? ', observed only' : ''})` : '—' }).join(' | ')} |`)
    md.push('', ...more(ev.concepts.length, CAP.concepts, 'concept sets'))
  }
  return { md, html: markdownToHtml(md.join('\n')) }
}

const CROSS_SITE_NOTE = 'Report-only: shown so that differences between sites can be reviewed. Nothing in this section excludes a site, blocks a seal or refuses an export, and it does not judge whether the sites are comparable.'

/** Amendment, plan documents and registration lines of the report header (P1–P3); none without those fields. */
function planLines(i: Pick<ReportInput, 'config' | 'chain'>): { md: string; text: string }[] {
  const c = i.config
  const out: { md: string; text: string }[] = []
  if (c?.amends) {
    const chain: ChainEntry[] = i.chain?.length ? i.chain : [{ issuedAt: c.issuedAt, issueNumber: c.issueNumber, summary: c.amends.summary }, { issuedAt: c.amends.previousIssuedAt, sha256: c.amends.previousSha256 }]
    const text = chain.map((e, n) => `${n === 0 ? 'current' : `N−${n}`}: ${issueLabel(e)}${e.sha256 ? ` (${e.sha256.slice(0, 12)}…)` : ''}${e.summary ? ` — ${e.summary}` : ''}`).join('; ')
    out.push({ md: `**Amendment chain:** ${mdCell(text)}`, text: `Amendment chain: ${text}` })
  }
  for (const d of c?.documents ?? []) out.push({ md: `**Plan document:** ${mdCell(d.title)} (\`protocol/${d.path}\`, SHA-256 \`${short(d.sha256)}\`)`, text: `Plan document: ${d.title} (protocol/${d.path})` })
  if (c?.registration) out.push({ md: `**Registration:** ${mdCell(registrationText(c.registration))}`, text: `Registration: ${registrationText(c.registration)}` })
  // Stage 5: the profile and the gates it put in force (only when the protocol records one).
  if (c?.profile) {
    const req = profileRequirements(c.profile).join('; ')
    out.push({ md: `**Protocol profile:** ${mdCell(profileLabel(c.profile))}. Requirements in force: ${mdCell(req)}. ${PROFILE_NOTE}`, text: `Protocol profile: ${profileLabel(c.profile)}. Requirements in force: ${req}. ${PROFILE_NOTE}` })
  }
  return out
}

/** The protocol files shipped in the package, how each was checked, and any that could not be shipped (C1). */
function protocolArtefactsSection(a: ProtocolArtefacts | undefined): { md: string[]; html: string } {
  if (!a || (!a.included.length && !a.mismatched.length && !a.unavailable.length)) return { md: [], html: '' }
  const intro = 'The protocol files the site manifests refer to are in this package under protocol/ (and the signer roster under roster/), each checked against the protocol before it was included.'
  const md = ['### Protocol artefacts in this package', '', intro, '', '| File | SHA-256 | Check |', '|---|---|---|']
  for (const f of a.included) md.push(`| \`${f.path}\` | \`${f.sha256}\` | ${mdCell(f.check)} |`)
  for (const m of a.mismatched) md.push(`| \`${m.path}\` | — | ❌ not included: ${mdCell(m.reason)} |`)
  for (const u of a.unavailable) md.push(`| \`${u}\` | — | not included: not loaded by the coordinator (load the protocol ZIP as the reference) |`)
  md.push('')
  const rows = [
    ...a.included.map((f) => `<tr><td><code>${xmlEscape(f.path)}</code></td><td><code>${xmlEscape(f.sha256)}</code></td><td>${xmlEscape(f.check)}</td></tr>`),
    ...a.mismatched.map((m) => `<tr><td><code>${xmlEscape(m.path)}</code></td><td>—</td><td>❌ not included: ${xmlEscape(m.reason)}</td></tr>`),
    ...a.unavailable.map((u) => `<tr><td><code>${xmlEscape(u)}</code></td><td>—</td><td>not included: not loaded by the coordinator</td></tr>`),
  ].join('')
  return { md, html: `<h3>Protocol artefacts in this package</h3><p>${xmlEscape(intro)}</p><table><tr><th>File</th><th>SHA-256</th><th>Check</th></tr>${rows}</table>` }
}

function htmlDisposition(i: ReportInput): string {
  const lock = i.disposition?.find((e) => e.action === 'lock')
  const disp = dispositionRows(i)
    .map((d) => `<tr><td>${xmlEscape(d.siteId)}</td><td><code>${xmlEscape(short(d.pack))}</code></td><td>${xmlEscape(d.recommended)}</td><td><b>${xmlEscape(d.decision)}</b>${d.deviates ? ' ⚠️' : ''}</td><td>${xmlEscape(d.code)}</td><td>${xmlEscape(d.text)}</td><td>${xmlEscape(d.by)}</td><td>${xmlEscape(d.at)}</td></tr>`)
    .join('\n')
  const ev = i.rows
    .map((r) => {
      const e = r.evidence
      const cs = e?.provenance.cdmSource
      const issues = siteIssues(r)
      return `<tr><td>${xmlEscape(r.site.siteId)}</td><td>${xmlEscape(signatureLine(r.signatures))}</td><td>${e ? `${e.dqdGate.counts.block}/${e.dqdGate.counts.warn}` : '—'}</td><td>${cs ? xmlEscape(`${cs.cdmSourceName ?? '?'} · CDM ${cs.cdmVersion ?? '?'} · ${cs.vocabularyVersion ?? '?'}`) : '—'}</td><td>${xmlEscape(cs?.sourceReleaseDate ?? '—')}</td><td>${xmlEscape(cs?.maxObservationPeriodEndDate ?? '—')}</td><td>${e?.log ? e.log.counts.ERROR + e.log.counts.FATAL : 'no log'}</td><td>${xmlEscape(runRecordCell(e))}</td><td>${xmlEscape(issues.join('; ') || '—')}</td></tr>`
    })
    .join('\n')
  const trail = (i.disposition ?? [])
    .map((e) => `<tr><td>${xmlEscape(String(e.seq))}</td><td>${xmlEscape(e.at)}</td><td>${xmlEscape(`${e.actor.name} (${e.actor.role})`)}</td><td>${xmlEscape(e.action)}</td><td>${xmlEscape(e.siteId ?? '—')}</td><td>${e.to ? xmlEscape(`${e.from ?? '—'} → ${e.to}`) : '—'}</td><td>${xmlEscape([e.reasonCode, e.reasonText].filter(Boolean).join(': ') || '—')}</td></tr>`)
    .join('\n')
  return `<h2>4. Site disposition</h2>
<p>Assurance: ${xmlEscape(i.config?.assurance ?? 'standard')}${siteListLine(i) ? ` · Sites in the protocol's site list: ${xmlEscape(siteListLine(i)!)}` : ''} · Dispositions locked: ${lock ? `yes — ${xmlEscape(lock.actor.name)} at ${xmlEscape(lock.at)}` : 'no'}</p>
<table><tr><th>Site</th><th>Pack</th><th>Recommended</th><th>Decision</th><th>Code</th><th>Justification / reasons</th><th>Decided by</th><th>When (UTC)</th></tr>${disp}</table>
<h2>5. Signatures, data quality and provenance</h2>
${i.rows.some((r) => r.plausibility?.length) ? `<p>${xmlEscape(PLAUSIBILITY_NOTE)}</p>` : ''}
<table><tr><th>Site</th><th>Signatures</th><th>DQD block/warn</th><th>CDM / vocabulary</th><th>Source release</th><th>Data cut-off</th><th>Log errors</th><th>Run record</th><th>Issues</th></tr>${ev}</table>
${trail ? `<h2>6. Disposition audit trail</h2><p>Head <code>${xmlEscape(i.dispositionHead ?? '—')}</code></p><table><tr><th>#</th><th>When (UTC)</th><th>Who</th><th>Action</th><th>Site</th><th>Change</th><th>Reason</th></tr>${trail}</table>` : ''}
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
  /** Dataset-JSON text, or XPT bytes, per path relative to define.xml (its def:leaf href; see datasetFiles). */
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
  /** Folder of define.xml and the datasets inside the package: "misc/" for aggregated results, "" for ADaM. */
  dataFolder: string
  /** Human-readable data definition (aggregated results). */
  dataDefinitionHtml?: string
  /** Protocol files shipped, and those not included with the reason (C1). */
  protocolArtefacts: ProtocolArtefacts
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
  /** How the datasets are presented (default aggregated-results). */
  profile?: SubmissionProfile
  /**
   * Ship the FDA simplified ts.xpt (STUDYID = studyId, which must match the study tagging file). The start
   * date is written only for a study that started on or before 2016-12-17; otherwise TSVALNF = "NA".
   */
  simplifiedTs?: { studyStartDate?: string }
  /** "<Module>/<table>" keys to include; default all. */
  tables?: string[]
  now?: Date
  /** Define-XML stylesheet to archive next to define.xml; default the one bundled for the chosen version, if any. null = none. */
  stylesheet?: DefineStylesheet | null
  /** Disposition audit trail to ship with the package (R6.4). */
  disposition?: { entries: readonly DispositionEntry[]; jsonl: string; headHash: string; head: Uint8Array; headSignature?: DetachedJws }
  /** The protocol the coordinator loaded as the reference; its pinned files are shipped under protocol/ (C1). */
  protocol?: ProtocolSource
  /** The signer roster and its signature, shipped under roster/ when loaded. */
  roster?: RosterSource
  /** Earlier issues the coordinator loaded (P1), by SHA-256; the packs' sealed issues are used automatically. */
  earlierIssues?: readonly { sha256: string; config: StudyConfig }[]
}): Promise<RegulatoryExport> {
  // Authoritative gate (the Export Hub also disables the button): in a regulatory study the dispositions
  // must be decided for every site and locked before anything comparative is produced (R6.3).
  if (params.config?.assurance === 'regulatory') {
    const d = params.disposition
    if (!d?.entries.some((e) => e.action === 'lock')) throw new Error('Regulatory study: lock the site dispositions before generating the submission package')
    const undecided = params.rows.filter((r) => !r.decision).map((r) => r.site.siteId)
    if (undecided.length) throw new Error(`Regulatory study: no recorded decision for ${undecided.join(', ')}`)
    // A1: every site in the protocol's site list has a decision or a not-received entry.
    const missing = unaccountedSites(params.config.sites, params.rows.map((r) => r.site), d.entries)
    if (missing.length) throw new Error(`Regulatory study: no pack decision or not-received entry for ${missing.join(', ')} (protocol site list)`)
  }
  const defineXmlVersion = params.defineXmlVersion ?? '2.1'
  const ctVersion = params.ctVersion?.trim() || DEFAULT_ADAM_CT_VERSION
  if (defineXmlVersion === '2.1' && !/^\d{4}-\d{2}-\d{2}$/.test(ctVersion)) throw new Error(`CT version "${ctVersion}" is not a CDISC package date (YYYY-MM-DD)`)
  const profile: SubmissionProfile = params.profile ?? 'aggregated-results'
  const dataFolder = profile === 'aggregated-results' ? 'misc/' : ''
  const standards: Standards = {
    profile,
    defineXml: defineXmlVersion,
    datasetJson: params.datasetJsonVersion ?? '1.1',
    ...(params.datasetFormat === 'xpt' ? { datasetFormat: 'xpt' as const } : {}),
    ...(defineXmlVersion === '2.1' ? { ctVersion } : {}),
    ...(params.agency ? { agency: params.agency } : {}),
    ...(params.simplifiedTs ? { simplifiedTs: simplifiedTsFor(params.simplifiedTs.studyStartDate) } : {}),
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
    auditReportHref: `${dataFolder ? '../' : ''}audit_report.html`,
    ctVersion,
    datasetFormat: params.datasetFormat,
    stylesheetHref: stylesheet?.name,
    now: params.now,
  })

  // Dataset paths are relative to define.xml (its def:leaf hrefs); both live in dataFolder.
  const dataDefinitionHtml =
    profile === 'aggregated-results'
      ? buildDataDefinitionHtml({ studyId: params.studyId, studyTitle: params.studyTitle, generatedAt, tables, datasetFormat: params.datasetFormat, formatLabel: datasetFormatLabel(standards) })
      : undefined
  // P1: the amendment chain, from the coordinator's issue through the issues the packs sealed or the coordinator loaded.
  const chain = params.config?.amends
    ? protocolChain(params.config, params.protocol?.configBytes ? await sha256Hex(params.protocol.configBytes) : undefined, sealedIssues(params.rows.map((r) => r.site), (params.earlierIssues ?? []).map((e) => [e.sha256, e.config] as const)))
    : []
  // C1: ship what the site manifests' protocol hashes refer to, each file re-hashed against the protocol first.
  const protocolArtefacts = await collectProtocolArtefacts({ config: params.config, protocol: params.protocol, roster: params.roster, adopted })
  if (params.config?.assurance === 'regulatory' && protocolArtefacts.mismatched.length)
    throw new Error(`Regulatory study: protocol artefacts do not match the protocol: ${protocolArtefacts.mismatched.map((m) => m.reason).join('; ')}`)
  const content: { path: string; bytes: Uint8Array; role: FileRole }[] = [
    ...protocolArtefacts.files.map((f) => ({ ...f, role: 'definition' as FileRole })),
    { path: `${dataFolder}define.xml`, bytes: enc.encode(defineXml), role: 'metadata' },
    ...(dataDefinitionHtml ? [{ path: `${dataFolder}data_definition.html`, bytes: enc.encode(dataDefinitionHtml), role: 'metadata' as FileRole }] : []),
    ...(stylesheet ? [{ path: `${dataFolder}${stylesheet.name}`, bytes: enc.encode(stylesheet.text), role: 'metadata' as FileRole }] : []),
    ...Object.entries(datasets).map(([path, d]) => ({ path: `${dataFolder}${path}`, bytes: typeof d === 'string' ? enc.encode(d) : d, role: 'result' as FileRole })),
    ...(standards.simplifiedTs ? [{ path: 'ts.xpt', bytes: writeSimplifiedTs(params.studyId, standards.simplifiedTs, params.now), role: 'metadata' as FileRole }] : []),
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
  const reportInput: ReportInput = { ...params, generatedAt, exportedFiles, standards, conformance, disposition: d?.entries, dispositionHead: d?.headHash, etl, protocolArtefacts, ...(chain.length ? { chain } : {}), crossSite: await crossSiteEvidence(adopted, params.config) }
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
    tool: TOOL,
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
    ...(chain.length ? { chain } : {}),
  }
  const reviewersGuide = reviewersGuideFor(reviewersGuideInput)
  return { zipBlob, zipName: `${safeId(params.studyId)}_submission_package.zip`, defineXml, datasets, tables, markdown, html, manifest, standards, conformance, reviewersGuide, reviewersGuideInput, dataFolder, dataDefinitionHtml, protocolArtefacts }
}

/** The draft reviewer's guide as Markdown and HTML, optionally with the reports of validator runs. */
export function reviewersGuideFor(input: ReviewersGuideInput, validatorRuns?: ValidatorRun[]): { markdown: string; html: string } {
  const markdown = buildReviewersGuideMarkdown(validatorRuns?.length ? { ...input, validatorRuns } : input)
  return { markdown, html: buildReviewersGuideHtml(markdown, input.studyId) }
}
