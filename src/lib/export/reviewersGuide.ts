/**
 * Draft Analysis Data Reviewer's Guide (ADRG) for the submission package.
 *
 * The section structure follows the PHUSE ADRG template; check it against the template version the
 * sponsor uses. Everything the tool knows is filled in: standards and versions, the network and site
 * dispositions, cohorts and analyses from the Strategus specification, the datasets as described in
 * define.xml, the conformance results with the explanations of the findings expected by design, and
 * the pinned programs. What only the sponsor can write is left as a visible "[TO BE COMPLETED: …]".
 *
 * It is a draft to edit, so it is offered as a separate download and not sealed in the package.
 */
import type { CombinedTable } from '@/lib/cdisc/datasetJson'
import type { AnalysisSpecSummary } from '@/lib/strategus/spec'
import { PROTOCOL_PATHS } from '@/lib/strategus/protocol'
import { APP_VERSION } from '@/lib/studypack/builder'
import type { CrossSiteResult } from '@/lib/network/aggregator'
import type { DispositionEntry } from '@/lib/network/dispositionLog'
import type { StudyConfig } from '@/types/studypack'
import { AGENCY_LABELS } from '@/lib/cdisc/validatorProfiles'
import type { ValidatorRun } from '@/lib/cdisc/p21Report'
import { markdownToHtml } from './markdown'
import type { Conformance, SiteEtl, SiteRow, Standards } from './regulatory'

export interface RenvSummary {
  r?: string
  packages: { name: string; version: string }[]
}

export interface ReviewersGuideInput {
  studyId: string
  studyTitle: string
  config?: StudyConfig
  generatedAt: string
  standards: Standards
  conformance: Conformance
  /** Exported datasets with their SASDatasetName and archive path. */
  datasets: { table: CombinedTable; sasName: string; path: string }[]
  rows: SiteRow[]
  cross: CrossSiteResult
  spec?: AnalysisSpecSummary
  renv?: RenvSummary
  etl?: SiteEtl[]
  disposition?: readonly DispositionEntry[]
  /** Reports of the validator runs on this package (Pinnacle 21), loaded by the user after the export. */
  validatorRuns?: ValidatorRun[]
}

/** Sentence on the simplified ts.xpt shipped with the package (FDA TCG 8.1.2.2, Appendix G), with a trailing space. */
function simplifiedTsNote(i: ReviewersGuideInput): string {
  const ts = i.standards.simplifiedTs
  if (!ts) return ''
  return ts.example === 'A'
    ? `A simplified ts.xpt (Technical Conformance Guide, Appendix G, example A) gives the study ID and the study start date ${ts.studyStartDate} (TSPARMCD = SSTDTC) so that the datasets are identified as not requiring SDTM and ADaM. `
    : 'A simplified ts.xpt (Technical Conformance Guide 8.1.2.2 and Appendix G, example B) gives the study ID with TSPARMCD = SSTDTC and TSVALNF = "NA", identifying the datasets as data to which SDTM and ADaM do not apply. Its STUDYID must equal the study ID of the study tagging file. '
}

/** HADES / Strategus packages worth naming in the programs section, when the lock file has them. */
const KEY_PACKAGES = [
  'Strategus', 'CohortGenerator', 'CohortDiagnostics', 'CohortIncidence', 'Characterization', 'CohortMethod', 'SelfControlledCaseSeries',
  'PatientLevelPrediction', 'EvidenceSynthesis', 'FeatureExtraction', 'Cyclops', 'DatabaseConnector', 'SqlRender', 'CirceR', 'ResultModelManager',
]

export function parseRenvLock(text: string): RenvSummary | undefined {
  try {
    const j = JSON.parse(text) as { R?: { Version?: string }; Packages?: Record<string, { Package?: string; Version?: string }> }
    const packages = Object.values(j.Packages ?? {})
      .filter((p) => p.Package && p.Version && KEY_PACKAGES.includes(p.Package))
      .map((p) => ({ name: p.Package!, version: p.Version! }))
      .sort((a, b) => KEY_PACKAGES.indexOf(a.name) - KEY_PACKAGES.indexOf(b.name))
    return { r: j.R?.Version, packages }
  } catch {
    return undefined
  }
}

const TODO = (what: string) => `**[TO BE COMPLETED: ${what}]**`
const cell = (s: unknown) => String(s ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')
/** Reason a site was excluded: the recorded decision when there is one, otherwise the recommendation. */
function exclusionReason(r: SiteRow, log: readonly DispositionEntry[] | undefined): string {
  const d = [...(log ?? [])].reverse().find((e) => e.action === 'exclude' && e.packSha256 === r.site.zipSha256)
  const recorded = [d?.reasonCode, d?.reasonText].filter(Boolean).join(': ')
  return recorded || r.verdict.reasons.join('; ') || r.verdict.codes.join(', ') || 'excluded'
}

const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))]

export function buildReviewersGuideMarkdown(i: ReviewersGuideInput): string {
  const adopted = i.rows.filter((r) => r.adopted)
  const excluded = i.rows.filter((r) => !r.adopted)
  const minCell = i.config?.minCellCount ?? 5
  const lock = i.disposition?.find((e) => e.action === 'lock')
  const cdmSources = adopted.map((r) => r.evidence?.provenance.cdmSource)
  const cdmVersions = uniq([i.config?.cdmVersion, ...adopted.map((r) => r.site.manifest?.cdmVersion), ...cdmSources.map((c) => c?.cdmVersion)])
  const vocabularies = uniq(cdmSources.map((c) => c?.vocabularyVersion))
  const dqdVersions = uniq(adopted.map((r) => r.site.dqd?.dqdVersion))
  const ref = (p: string) => i.cross.references[p]?.hash
  const L: string[] = []

  // Aggregated results are not ADaM: the guide says so and where the package belongs (see Standards.profile).
  const aggregated = i.standards.profile === 'aggregated-results'
  const strategus = i.renv?.packages.find((p) => p.name === 'Strategus')?.version
  L.push(aggregated ? `# Reviewer's Guide for Aggregated Results — ${i.studyId}` : `# Analysis Data Reviewer's Guide — ${i.studyId}`, '')
  L.push(
    `_Draft generated by OHDSI Study Studio ${APP_VERSION} on ${i.generatedAt}. The structure follows the PHUSE ADRG template${aggregated ? ', adapted to aggregated results that are not SDTM or ADaM data' : ''}. Sections marked "TO BE COMPLETED" need the sponsor's input; review every generated statement before submission._`,
    '',
  )

  L.push('## 1. Introduction', '')
  L.push('### 1.1 Purpose', '')
  L.push(
    `This document provides context for the analysis datasets and terminology submitted for study ${i.studyId} ("${i.studyTitle}"). It describes a network study run on the OMOP Common Data Model with the OHDSI Strategus framework: each participating site executed the same pinned analysis on its own data and returned aggregated results only. No subject-level data were collected or submitted.`,
    '',
  )
  if (aggregated)
    L.push(
      `This package contains aggregated (summary-level) results of a distributed network study conducted on databases mapped to the OMOP Common Data Model and executed with OHDSI Strategus${strategus ? ` ${strategus}` : ''}. No subject-level data were transferred from participating sites; counts between 1 and ${minCell - 1} were suppressed at source. The datasets are not SDTM or ADaM datasets and are therefore provided as non-standard data in the misc folder; no ADSL exists because no subject-level analysis data were created outside the sites. Dataset structures are documented in the accompanying data definition (data_definition.html) and, for machines, in define.xml, which uses the Define-XML vocabulary of a non-standard ADaM dataset (class "ADAM OTHER") only because the format requires a declared standard; that does not make the datasets ADaM data.`,
      '',
    )
  L.push('### 1.2 Study Data Standards and Dictionary Inventory', '')
  L.push('| Standard or dictionary | Version(s) | Used for |', '|---|---|---|')
  L.push(`| CDISC Define-XML | ${i.standards.defineXml} | ${aggregated ? 'Machine-readable data definition (define.xml); a human-readable version is data_definition.html' : 'Metadata (define.xml)'} |`)
  L.push(i.standards.datasetFormat === 'xpt' ? '| SAS Version 5 transport format (XPT) | 5 | Analysis datasets |' : `| CDISC Dataset-JSON | ${i.standards.datasetJson} | Analysis datasets |`)
  L.push(aggregated ? '| CDISC ADaMIG | 1.3 | Named in define.xml only, as the format requires a standard; the datasets are not ADaM data (see 1.1) |' : '| CDISC ADaMIG | 1.3 | Declared standard; every dataset is non-standard (see 5.2) |')
  if (i.standards.defineXml === '2.1' && i.standards.ctVersion) L.push(`| CDISC/NCI ADaM controlled terminology | ${i.standards.ctVersion} | Declared in define.xml; no CDISC code list is used |`)
  L.push(`| OMOP Common Data Model | ${cell(cdmVersions.join(', ') || TODO('CDM version'))} | Site data model |`)
  L.push(`| OMOP Standardized Vocabularies | ${cell(vocabularies.join(', ') || TODO('vocabulary version(s)'))} | Concept sets and cohort definitions |`)
  if (dqdVersions.length) L.push(`| OHDSI Data Quality Dashboard | ${cell(dqdVersions.join(', '))} | Site data-quality checks |`)
  L.push('')
  L.push('### 1.3 Source Data Used for Analysis Dataset Creation', '')
  L.push(
    `Each site holds its data in the OMOP CDM and ran the study locally. The aggregated results were sealed at the site into a StudyPack whose files are listed by SHA-256, and verified by the coordinator before adoption. ${adopted.length} of ${i.rows.length} site(s) were adopted${lock ? `; the dispositions were locked by ${lock.actor.name} on ${lock.at}` : ''}. Source data never left the sites; how each site populated its CDM is summarized in the audit report (section "Data lineage").`,
    '',
  )
  L.push('| Site | Disposition | CDM source | CDM version | Vocabulary version | Reason |', '|---|---|---|---|---|---|')
  for (const r of i.rows) {
    const cs = r.evidence?.provenance.cdmSource
    const reasons = r.adopted ? '—' : exclusionReason(r, i.disposition)
    L.push(`| ${cell(r.site.siteId)} | ${r.adopted ? 'adopted' : 'excluded'} | ${cell(cs?.cdmSourceName)} | ${cell(cs?.cdmVersion ?? r.site.manifest?.cdmVersion)} | ${cell(cs?.vocabularyVersion)} | ${cell(reasons)} |`)
  }
  L.push('')
  if (aggregated) {
    L.push('### 1.4 Placement in the Submission', '')
    L.push(
      'The datasets, define.xml and the data definition are provided as non-standard data (folder misc). They are not to be tagged as SDTM or ADaM datasets or as an analysis data definition: validators then check them against rules for subject-level data (for example, a missing ADSL).',
      '',
    )
    L.push(`- **FDA:** as the data of a non-interventional database study report, eCTD 5.3.5.4 (5.3.5.3 for an integrated analysis across studies; 5.3.6 for postmarketing safety). The Study Data Technical Conformance Guide lists these sections among those where the study data technical rejection criteria do not apply. ${simplifiedTsNote(i)}${TODO('confirm the eCTD section and file tagging with the review division')}`)
    L.push(`- **PMDA:** non-CDISC datasets in the misc folder. Post-marketing database study (GPSP) data are not subject to the electronic study data requirement; for other uses the scope is decided in a pre-submission consultation. ${TODO('confirm the handling with PMDA (事前面談)')}`)
    L.push('')
  }

  L.push('## 2. Protocol Description', '')
  L.push('### 2.1 Protocol Number and Title', '')
  L.push(`- **Protocol number:** ${i.studyId}`)
  L.push(`- **Protocol title:** ${i.studyTitle}`)
  if (i.config?.sponsor) L.push(`- **Sponsor:** ${i.config.sponsor}`)
  if (i.config?.principalInvestigator) L.push(`- **Principal investigator:** ${i.config.principalInvestigator}`)
  if (i.config?.issuedAt) L.push(`- **Protocol issued:** ${i.config.issuedAt}`)
  L.push(`- **Protocol versions:** ${TODO('protocol version(s) and dates')}`, '')
  L.push('### 2.2 Protocol Design in Relation to ADaM Concepts', '')
  L.push(
    `${TODO('study design, objectives and endpoints, and how they map to the datasets below')} The study does not collect subject-level data, so there is no ADSL and no subject-level traceability; each dataset holds results aggregated per site, analysis and cohort.`,
    '',
  )
  const cohorts = i.spec?.cohorts ?? i.config?.cohorts ?? []
  if (cohorts.length) {
    L.push('Cohorts (from the Strategus analysis specification):', '')
    L.push('| Cohort ID | Name | Role(s) |', '|---|---|---|')
    for (const c of cohorts) L.push(`| ${c.cohortId} | ${cell(c.cohortName)} | ${cell(c.roles.join(', ') || 'generated / characterized')} |`)
    L.push('')
  }
  const modules = i.spec?.modules ?? i.config?.framework.modules ?? []
  if (modules.length) L.push(`Strategus modules: ${modules.map((m) => `\`${m}\``).join(', ')}.`, '')
  const cm = i.spec?.cohortMethod
  if (cm) {
    L.push('Comparative cohort analyses (CohortMethod):', '')
    for (const a of cm.analyses) L.push(`- Analysis ${a.analysisId}: ${a.description}`)
    for (const t of cm.targetComparatorOutcomes)
      L.push(`- Target ${t.targetId} vs comparator ${t.comparatorId}: outcome(s) ${t.outcomesOfInterest.join(', ')}; ${t.negativeControlOutcomes} negative control outcome(s)`)
    L.push('')
  }
  const sccs = i.spec?.sccs
  if (sccs) {
    L.push('Self-controlled case series analyses (SelfControlledCaseSeries):', '')
    for (const a of sccs.analyses) L.push(`- Analysis ${a.analysisId}: ${a.description}`)
    for (const e of sccs.exposures) L.push(`- Exposure ${e.exposureId}: outcome(s) ${e.outcomesOfInterest.join(', ')}; ${e.negativeControlOutcomes} negative control outcome(s)`)
    L.push('')
  }

  L.push('## 3. Analysis Considerations Related to Multiple Analysis Datasets', '')
  L.push('### 3.1 Core Variables', '')
  L.push('`SITE_ID` (assigned from the StudyPack of each adopted site) identifies the site in every dataset; `DATABASE_ID` identifies the CDM instance. Analysis and cohort identifiers (`ANALYSIS_ID`, `TARGET_ID`, `COMPARATOR_ID`, `OUTCOME_ID`, `COHORT_ID`, …) refer to the analysis specification. The key variables of each dataset are given in define.xml.', '')
  L.push('### 3.2 Treatment Variables', '')
  L.push(`Exposures are defined as cohorts (see 2.2) and referenced by cohort identifier, e.g. \`TARGET_ID\` and \`COMPARATOR_ID\`. ${TODO('relation to planned / actual treatment, if applicable')}`, '')
  L.push('### 3.3 Subject Issues Requiring Special Analysis Rules', '')
  L.push('Not applicable: no subject-level data are submitted. Inclusion and exclusion are defined by the cohort definitions.', '')
  L.push('### 3.4 Use of Visit Windowing, Unscheduled Visits, and Record Selection', '')
  L.push(`Not applicable to the submitted aggregated data. Time-at-risk windows are part of the analysis settings in the specification. ${TODO('describe time-at-risk choices if relevant to review')}`, '')
  L.push('### 3.5 Imputation/Derivation Methods', '')
  L.push(
    `No imputation is applied. Counts between 1 and ${minCell - 1} were censored at each site before export and are reported as -${minCell} (minimum cell count ${minCell}); the coordinator re-checked every result file. Rows from adopted sites are concatenated, with \`SITE_ID\` added; no cross-site pooling is performed in these datasets. ${TODO('meta-analysis or evidence synthesis performed outside these datasets, if any')}`,
    '',
  )

  L.push('## 4. Analysis Data Creation and Processing Issues', '')
  L.push('### 4.1 Split Datasets', '')
  L.push('None.', '')
  L.push('### 4.2 Data Dependencies', '')
  L.push('All datasets were produced by the same Strategus execution at each site. Cohort counts (CohortGenerator) underlie the estimation and diagnostics results of the other modules; datasets can otherwise be reviewed independently.', '')

  L.push('## 5. Analysis Dataset Descriptions', '')
  L.push('### 5.1 Overview', '')
  L.push(
    `The datasets are the Strategus result tables of the adopted sites, one dataset per table, in ${i.standards.datasetFormat === 'xpt' ? 'SAS Version 5 transport files (XPT), with the 8-character SAS names as dataset and variable names (the Strategus names are given in the dataset labels and variable descriptions)' : `CDISC Dataset-JSON ${i.standards.datasetJson}`}. ${aggregated ? 'They are not ADaM datasets (see 1.1 and 1.4). Variable definitions, origins and derivations (including value-level metadata per cohort) are in data_definition.html and define.xml.' : 'They follow none of the ADaM data structures and are declared in define.xml as non-standard datasets of class "ADAM OTHER". Variable definitions, origins and derivations (including value-level metadata per cohort) are in define.xml.'}`,
    '',
  )
  L.push('### 5.2 Analysis Datasets', '')
  L.push('| Dataset | Label | Class | Structure | Records | File | Primary objective |', '|---|---|---|---|---|---|---|')
  for (const d of i.datasets) {
    const keys = d.table.columns.filter((c) => c.primaryKey).map((c) => c.name)
    L.push(`| ${d.sasName} | ${cell(d.table.label)} | ADAM OTHER | ${cell(keys.length ? `One record per ${keys.join(', ')}` : 'One record per site result row')} | ${d.table.rows.length} | \`${d.path}\` | ${TODO('yes / no')} |`)
  }
  L.push('')

  L.push('## 6. Data Conformance Summary', '')
  L.push('### 6.1 Conformance Inputs', '')
  const runs = i.validatorRuns ?? []
  L.push(`- **Built-in checks:** OHDSI Study Studio ${APP_VERSION} define.xml and dataset checks, run at export.`)
  if (!runs.length) {
    L.push(`- **Datasets validated:** ${TODO('whether the validator was run on define.xml alone or on the datasets with define.xml')}`)
    if (i.standards.agency && i.standards.agency !== 'OTHER') L.push(`- **Ratings:** ${AGENCY_LABELS[i.standards.agency]} validator profile.`)
    L.push(`- **Validator:** ${TODO('validator, version, engine and configuration used, date run')}`)
  }
  if (i.standards.defineXml === '2.1' && i.standards.ctVersion) L.push(`- **Controlled terminology:** CDISC/NCI ADaM ${i.standards.ctVersion}`)
  L.push('')
  if (runs.length) {
    L.push('Validator runs on this package:', '')
    L.push('| Run | Validator | Engine | Configuration | Validated | CT version | Run on |', '|---|---|---|---|---|---|---|')
    runs.forEach((r, n) =>
      L.push(
        `| V${n + 1} | ${r.validator}${r.softwareVersion ? ` (software ${cell(r.softwareVersion)})` : ''} | ${cell(r.engine ?? '—')} | ${cell(r.configuration ?? '—')} | ${r.datasets.length ? `${r.datasets.length} dataset(s) with ${cell(r.define ?? 'define.xml')}` : cell(r.define ?? 'define.xml')} | ${cell(r.ctVersion ?? '—')} | ${cell(r.generated ?? '—')} |`,
      ),
    )
    L.push('')
    const problems = [...new Set(runs.flatMap((r) => r.installationProblems))]
    if (problems.length) L.push(`Installation notes reported by the validator: ${problems.join('; ')}. ${TODO('state whether they affect these datasets')}`, '')
  }
  L.push('### 6.2 Issues Summary', '')
  const agency = i.standards.agency && i.standards.agency !== 'OTHER' ? i.standards.agency : undefined
  const rate = (s: Partial<Record<'FDA' | 'PMDA', string>>) => (agency ? (s[agency] ?? '—') : `FDA ${s.FDA ?? '—'} / PMDA ${s.PMDA ?? '—'}`)
  const builtIn = i.conformance.issues.map((x) => ({ rule: x.p21.join(', ') || x.rule, scope: x.rule.startsWith('SS-DSJ') || x.rule.startsWith('SS-XPT') ? 'datasets' : 'define.xml', message: `${x.target}: ${x.message}`, severity: rate(x.severity), explanation: TODO('explanation') }))
  if (runs.length) {
    // What the validator actually reported, run by run, with the explanation of each finding expected by design.
    const explain = (id: string) => i.conformance.expected.find((e) => e.p21 === id)?.explanation ?? TODO('explanation')
    L.push(
      `The issues below were reported by the validator runs listed in 6.1, with the severity each run assigned. The findings expected by design follow from ${aggregated ? 'validating aggregated datasets, which are not ADaM data, against ADaM rules' : 'submitting aggregated, non-standard datasets without subject-level data'}; in particular, validating the datasets as ADaM data reports AD0001 (missing ADSL) with severity Reject.`,
      '',
    )
    L.push('| Rule ID | Run | Message | Severity | Found | Explanation |', '|---|---|---|---|---|---|')
    runs.forEach((r, n) => {
      for (const x of r.issues) {
        const where = x.sources.filter((s) => s !== 'GLOBAL')
        const message = where.length > 1 ? `${x.message.replace(new RegExp(`\\b${where[0]}\\b`), 'dataset')} (${where.length} datasets)` : x.message
        L.push(`| ${x.id} | V${n + 1} | ${cell(message)} | ${cell(x.severity)} | ${x.count} | ${cell(explain(x.id))} |`)
      }
      if (!r.issues.length) L.push(`| — | V${n + 1} | No issues reported | — | 0 | — |`)
    })
    if (builtIn.length) {
      L.push('', 'Issues found by the built-in checks:', '', '| Rule ID | Checked | Message | Severity | Explanation |', '|---|---|---|---|---|')
      for (const r of builtIn) L.push(`| ${cell(r.rule)} | ${r.scope} | ${cell(r.message)} | ${cell(r.severity)} | ${cell(r.explanation)} |`)
    }
    L.push('')
  } else {
    const issueRows = [
      ...i.conformance.expected.map((e) => ({ rule: e.p21, scope: e.scope === 'define' ? 'define.xml' : 'datasets', message: e.message, severity: rate(e.severity), explanation: e.explanation })),
      ...builtIn,
    ]
    L.push(
      aggregated
        ? 'The findings below are reported when a validator checks these datasets against ADaM rules, which do not apply to them: they follow from the datasets being aggregated results without subject-level data. In particular, validating them as ADaM data reports AD0001 (missing ADSL) with severity Reject. Provided as non-standard data (1.4), they are not expected to be validated as ADaM.'
        : 'The findings below are expected for every package produced this way: they follow from submitting aggregated, non-standard datasets without subject-level data. In particular, validating the datasets as ADaM data reports AD0001 (missing ADSL) with severity Reject.',
      '',
    )
    if (issueRows.length) {
      L.push('| Rule ID | Checked | Message | Severity | Explanation |', '|---|---|---|---|---|')
      for (const r of issueRows) L.push(`| ${cell(r.rule)} | ${r.scope} | ${cell(r.message)} | ${cell(r.severity)} | ${cell(r.explanation)} |`)
    } else L.push('No issues were found by the built-in checks.')
    L.push('', `${TODO('add every issue reported by the validator run above that is not listed here, with its explanation')}`, '')
  }

  L.push('## 7. Submission of Programs', '')
  L.push('### 7.1 Description', '')
  L.push(
    'The analysis was specified as a Strategus analysis specification and executed at each site by a pinned R script with a pinned R package environment (renv). Sites could only edit the connection settings above the protected marker of the script; the code below it, the specification and the lock file are verified by SHA-256 in every StudyPack.',
    '',
  )
  if (i.renv?.r || i.renv?.packages.length) {
    L.push('| Software | Version |', '|---|---|')
    if (i.renv.r) L.push(`| R | ${i.renv.r} |`)
    for (const p of i.renv.packages) L.push(`| ${p.name} | ${p.version} |`)
    L.push('')
  }
  L.push('### 7.2 Analysis Datasets Programs', '')
  L.push('| Program | SHA-256 (reference) |', '|---|---|')
  L.push(`| \`${PROTOCOL_PATHS.analysisSpecifications}\` | \`${ref(PROTOCOL_PATHS.analysisSpecifications) ?? '—'}\` |`)
  L.push(`| \`${PROTOCOL_PATHS.executeAnalyses}\` (protected section) | \`${ref(PROTOCOL_PATHS.executeAnalyses) ?? '—'}\` |`)
  L.push(`| \`${PROTOCOL_PATHS.renvLock}\` | \`${ref(PROTOCOL_PATHS.renvLock) ?? '—'}\` |`)
  L.push('')
  L.push('### 7.3 Analysis Output Programs', '')
  L.push(`${TODO('programs producing the tables and figures of the study report from these datasets')}`, '')
  L.push('### 7.4 Macro Programs', '')
  L.push('Not applicable: the analysis uses the released OHDSI HADES packages listed in 7.1.', '')

  if (excluded.length) {
    L.push('## Appendix: Excluded Sites', '')
    L.push('Sites excluded from the datasets, with the reason recorded in the disposition audit trail, or the recommended reason when no decision was recorded (full trail in the audit report):', '')
    for (const r of excluded) L.push(`- ${r.site.siteId}: ${exclusionReason(r, i.disposition)}`)
    L.push('')
  }
  return L.join('\n')
}

export function buildReviewersGuideHtml(markdown: string, studyId: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Analysis Data Reviewer's Guide — ${studyId.replace(/[<&]/g, '')}</title>
<style>
 body{font:12.5px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:32px;max-width:960px}
 h1{font-size:20px} h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ccc;padding-bottom:4px} h3{font-size:13.5px;margin-top:18px}
 table{border-collapse:collapse;width:100%;font-size:11.5px;margin:6px 0} th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f2f2f2}
 code{font-size:10.5px;word-break:break-all} strong.todo{color:#8a1c00;background:#fff4e5}
 @media print{body{margin:14mm} .noprint{display:none}}
</style></head><body>
<button class="noprint" onclick="window.print()" style="float:right">Print / Save as PDF</button>
${markdownToHtml(markdown).replace(/<strong>\[TO BE COMPLETED/g, '<strong class="todo">[TO BE COMPLETED')}
</body></html>
`
}
