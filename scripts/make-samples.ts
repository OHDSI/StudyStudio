/**
 * Generates demo artifacts under samples/ (run: npm run samples).
 *
 *   samples/study-repo/        a Strategus study repository (StrategusStudyRepoTemplate layout, synthetic)
 *   samples/study-repo.zip     the same, as GitHub "Download ZIP" would produce it
 *   samples/protocol/          study_config.json + <studyId>_protocol.zip issued by the coordinator
 *   samples/site/              Site Mode inputs: Strategus results as ZIP and as an expanded folder,
 *                              plus with_violations/ (uncensored export + executionSettings.json with minCellCount 0)
 *   samples/network/           four site StudyPacks for the Multi-Site Aggregator:
 *                              Site_A, Site_B clean (different INPUTS blocks — still a protocol match),
 *                              Site_C tampered after sealing, Site_D edited code below the protected marker
 *
 * All data is synthetic. The analysis specification mirrors the structure written by
 * ParallelLogger::saveSettingsToJson() for a Strategus study; result tables and their
 * resultsDataModelSpecification.csv follow the HADES results data model column names.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { parseCirceText } from '../src/lib/codegen/circe'
import { issueProtocol, locateStudyRepo, protocolZip } from '../src/lib/strategus/protocol'
import { auditResultFiles } from '../src/lib/strategus/results'
import { auditWorkbook } from '../src/lib/audit/cellAuditor'
import { buildStudyPack, type PackInputFile } from '../src/lib/studypack/builder'
import { SLOT_BY_ID, type SlotId } from '../src/lib/studypack/slots'

const root = path.resolve(import.meta.dirname, '..', 'samples')
const out = (p: string, data: string | Uint8Array) => {
  mkdirSync(path.dirname(path.join(root, p)), { recursive: true })
  writeFileSync(path.join(root, p), data)
}
const enc = new TextEncoder()
const now = new Date('2026-11-01T09:00:00Z')
const STUDY = 'ACEI_ANGIO_2026'
const MIN = 5

// ---------------------------------------------------------------------------
// Analysis specification (synthetic, Strategus/ParallelLogger JSON structure)
// ---------------------------------------------------------------------------
function analysisSpecification(): string {
  const cohorts = parseCirceText(readFileSync(path.join(root, 'atlas_cohorts.json'), 'utf8'))
  const nc = [
    { cohortId: 2001, outcomeConceptId: 4299544, cohortName: 'Acanthosis nigricans' },
    { cohortId: 2002, outcomeConceptId: 376707, cohortName: 'Acute conjunctivitis' },
    { cohortId: 2003, outcomeConceptId: 77644, cohortName: 'Adhesive capsulitis of shoulder' },
    { cohortId: 2004, outcomeConceptId: 4218106, cohortName: 'Alcoholism' },
    { cohortId: 2005, outcomeConceptId: 4344500, cohortName: 'Ingrowing nail' },
  ]
  const outcome = (id: number, ofInterest: boolean) => ({
    outcomeId: id,
    outcomeOfInterest: ofInterest,
    trueEffectSize: ofInterest ? null : 1,
    priorOutcomeLookback: 99999,
    riskWindowStart: null,
    startAnchor: null,
    riskWindowEnd: null,
    endAnchor: null,
  })
  const spec = {
    sharedResources: [
      {
        cohortDefinitions: cohorts.map((c) => ({ cohortId: String(c.cohortId), cohortName: c.cohortName, cohortDefinition: JSON.stringify(c.expression) })),
        attr_class: ['CohortDefinitionSharedResources', 'SharedResources'],
      },
      {
        negativeControlOutcomes: JSON.stringify({
          negativeControlOutcomeCohortSet: nc.map((n) => ({ cohortId: n.cohortId, cohortName: n.cohortName, outcomeConceptId: n.outcomeConceptId })),
          occurrenceType: 'first',
          detectOnDescendants: true,
        }),
        attr_class: ['NegativeControlOutcomeSharedResources', 'SharedResources'],
      },
    ],
    moduleSpecifications: [
      { module: 'CohortGeneratorModule', settings: { generateStats: true }, attr_class: ['ModuleSpecifications', 'CohortGeneratorModuleSpecifications'] },
      {
        module: 'CohortDiagnosticsModule',
        settings: { runInclusionStatistics: true, runIncidenceRate: true, runTimeSeries: false, minCharacterizationMean: 0.01 },
        attr_class: ['ModuleSpecifications', 'CohortDiagnosticsModuleSpecifications'],
      },
      {
        module: 'CohortMethodModule',
        settings: {
          cmAnalysesSpecifications: {
            cmAnalysisList: [{ analysisId: 1, description: 'Cohort method, on treatment, 1:1 PS matching' }],
            targetComparatorOutcomesList: [
              {
                targetId: 1781,
                comparatorId: 1782,
                outcomes: [outcome(1783, true), ...nc.map((n) => outcome(n.cohortId, false))],
                excludedCovariateConceptIds: [1308216, 974166],
                includedCovariateConceptIds: null,
                nestingCohortId: null,
              },
            ],
            cmDiagnosticThresholds: { mdrrThreshold: 10, easeThreshold: 0.25, sdmThreshold: 0.1, equipoiseThreshold: 0.2, generalizabilitySdmThreshold: 999 },
            refitPsForEveryOutcome: false,
            refitPsForEveryStudyPopulation: true,
          },
        },
        attr_class: ['ModuleSpecifications', 'CohortMethodModuleSpecifications'],
      },
      {
        module: 'SelfControlledCaseSeriesModule',
        settings: {
          sccsAnalysesSpecifications: {
            sccsAnalysisList: [{ analysisId: 1, description: 'SCCS, on treatment' }],
            exposuresOutcomeList: [1783, ...nc.map((n) => n.cohortId)].map((o) => ({
              outcomeId: o,
              nestingCohortId: null,
              exposures: [{ exposureId: 1781, exposureIdRef: 'exposureId', trueEffectSize: o === 1783 ? null : 1 }],
            })),
            sccsDiagnosticThresholds: { mdrrThreshold: 10, easeThreshold: 0.25, timeTrendPThreshold: 0.05, preExposurePThreshold: 0.05 },
            combineDataFetchAcrossOutcomes: false,
          },
        },
        attr_class: ['ModuleSpecifications', 'SelfControlledCaseSeriesModuleSpecifications'],
      },
    ],
    attr_class: 'AnalysisSpecifications',
  }
  return JSON.stringify(spec, null, 2) + '\n'
}

// ---------------------------------------------------------------------------
// Strategus results folder (synthetic)
// ---------------------------------------------------------------------------
type Row = (string | number)[]
const csv = (header: string[], rows: Row[]) => [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n'
const RDMS_HEADER = ['table_name', 'column_name', 'data_type', 'is_required', 'primary_key', 'min_cell_count', 'description']
const rdms = (rows: [string, string, string, 'Yes' | 'No', 'Yes' | 'No', 'Yes' | 'No', string][]) =>
  csv(RDMS_HEADER, rows.map((r) => r.map((v) => (/[,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v))))

/** Censor like HADES enforceMinCellValue: 0 < n < min → -min. min = 0 disables censoring. */
const censor = (n: number, min: number) => (min > 0 && n > 0 && n < min ? -min : n)

function strategusResults(siteId: string, scale: number, min: number): Record<string, string> {
  const db = `${siteId.toUpperCase()}_EHR`
  const c = (n: number) => censor(Math.round(n), min)
  // Small counts that must be suppressed (they stay small at every scale).
  const angioedemaSubjects = 3
  const targetOutcomes = 2
  const sccsOutcomeSubjects = 4
  return {
    'DatabaseMetaData/database_meta_data.csv': csv(
      ['database_id', 'cdm_source_name', 'cdm_source_abbreviation', 'cdm_holder', 'source_release_date', 'cdm_version', 'vocabulary_version', 'max_obs_period_end_date'],
      [[db, `${siteId} hospital EHR (demo)`, siteId, 'Demo holder', '2026-09-30', '5.4', 'v5.0 30-AUG-26', '2026-09-30']],
    ),
    'DatabaseMetaData/resultsDataModelSpecification.csv': rdms([
      ['database_meta_data', 'database_id', 'varchar', 'Yes', 'Yes', 'No', 'Unique identifier of the database'],
      ['database_meta_data', 'cdm_source_name', 'varchar', 'Yes', 'No', 'No', 'The name of the CDM instance.'],
      ['database_meta_data', 'cdm_source_abbreviation', 'varchar', 'Yes', 'No', 'No', 'The abbreviation of the CDM instance.'],
      ['database_meta_data', 'cdm_holder', 'varchar', 'Yes', 'No', 'No', 'The holder of the CDM instance.'],
      ['database_meta_data', 'source_release_date', 'date', 'Yes', 'No', 'No', 'The release date of the source data.'],
      ['database_meta_data', 'cdm_version', 'varchar', 'Yes', 'No', 'No', 'The CDM version.'],
      ['database_meta_data', 'vocabulary_version', 'varchar', 'Yes', 'No', 'No', 'The vocabulary version.'],
      ['database_meta_data', 'max_obs_period_end_date', 'date', 'Yes', 'No', 'No', 'The latest observation period end date.'],
    ]),
    'CohortGeneratorModule/cg_cohort_count.csv': csv(
      ['database_id', 'cohort_id', 'cohort_entries', 'cohort_subjects'],
      [
        [db, 1781, c(12450 * scale), c(12450 * scale)],
        [db, 1782, c(9871 * scale), c(9871 * scale)],
        [db, 1783, c(angioedemaSubjects + 1), c(angioedemaSubjects)],
      ],
    ),
    'CohortGeneratorModule/resultsDataModelSpecification.csv': rdms([
      ['cg_cohort_count', 'database_id', 'varchar', 'Yes', 'Yes', 'No', 'The database identifier for this information'],
      ['cg_cohort_count', 'cohort_id', 'bigint', 'Yes', 'Yes', 'No', 'The unique identifier for the cohort definition'],
      ['cg_cohort_count', 'cohort_entries', 'bigint', 'Yes', 'No', 'Yes', 'The number of cohort entries'],
      ['cg_cohort_count', 'cohort_subjects', 'bigint', 'Yes', 'No', 'Yes', 'The number of unique subjects'],
    ]),
    'CohortMethodModule/cm_result.csv': csv(
      ['analysis_id', 'target_id', 'comparator_id', 'outcome_id', 'rr', 'ci_95_lb', 'ci_95_ub', 'p', 'target_subjects', 'comparator_subjects', 'target_days', 'comparator_days', 'target_outcomes', 'comparator_outcomes', 'log_rr', 'se_log_rr', 'database_id'],
      [
        [1, 1781, 1782, 1783, 3.12, 0.84, 11.6, 0.09, c(8120 * scale), c(8120 * scale), Math.round(1.9e6 * scale), Math.round(1.8e6 * scale), c(targetOutcomes), c(0), 1.138, 0.67, db],
        [1, 1781, 1782, 2001, 1.04, 0.71, 1.52, 0.84, c(8120 * scale), c(8120 * scale), Math.round(1.9e6 * scale), Math.round(1.8e6 * scale), c(41 * scale), c(39 * scale), 0.039, 0.19, db],
      ],
    ),
    'CohortMethodModule/cm_diagnostics_summary.csv': csv(
      ['analysis_id', 'target_id', 'comparator_id', 'outcome_id', 'database_id', 'max_sdm', 'shared_max_sdm', 'equipoise', 'mdrr', 'ease', 'balance_diagnostic', 'shared_balance_diagnostic', 'equipoise_diagnostic', 'mdrr_diagnostic', 'ease_diagnostic', 'unblind'],
      [[1, 1781, 1782, 1783, db, 0.04, 0.03, 0.61, 3.9, 0.08, 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 1]],
    ),
    'CohortMethodModule/resultsDataModelSpecification.csv': rdms([
      ['cm_result', 'analysis_id', 'int', 'Yes', 'Yes', 'No', 'A foreign key referencing the cm_analysis table.'],
      ['cm_result', 'target_id', 'int', 'Yes', 'Yes', 'No', 'The identifier for the target cohort.'],
      ['cm_result', 'comparator_id', 'int', 'Yes', 'Yes', 'No', 'The identifier for the comparator cohort.'],
      ['cm_result', 'outcome_id', 'int', 'Yes', 'Yes', 'No', 'The identifier for the outcome cohort.'],
      ['cm_result', 'rr', 'float', 'No', 'No', 'No', 'The estimated relative risk (e.g. the hazard ratio).'],
      ['cm_result', 'ci_95_lb', 'float', 'No', 'No', 'No', 'The lower bound of the 95% confidence internval of the relative risk.'],
      ['cm_result', 'ci_95_ub', 'float', 'No', 'No', 'No', 'The upper bound of the 95% confidence internval of the relative risk.'],
      ['cm_result', 'p', 'float', 'No', 'No', 'No', 'The two-sided p-value considering the null hypothesis of no effect.'],
      ['cm_result', 'target_subjects', 'int', 'Yes', 'No', 'Yes', 'The number of subject in the target cohort.'],
      ['cm_result', 'comparator_subjects', 'int', 'Yes', 'No', 'Yes', 'The number of subject in the comparator cohort.'],
      ['cm_result', 'target_days', 'int', 'Yes', 'No', 'No', 'The number of days observed in the target cohort.'],
      ['cm_result', 'comparator_days', 'int', 'Yes', 'No', 'No', 'The number of days observed in the comparator cohort.'],
      ['cm_result', 'target_outcomes', 'int', 'Yes', 'No', 'Yes', 'The number of outcomes observed in the target cohort.'],
      ['cm_result', 'comparator_outcomes', 'int', 'Yes', 'No', 'Yes', 'The number of outcomes observed in the comparator cohort.'],
      ['cm_result', 'log_rr', 'float', 'No', 'No', 'No', 'The log of the relative risk.'],
      ['cm_result', 'se_log_rr', 'float', 'No', 'No', 'No', 'The standard error of the log of the relative risk.'],
      ['cm_result', 'database_id', 'varchar', 'Yes', 'Yes', 'No', 'A foreign key referencing the database.'],
      ['cm_diagnostics_summary', 'analysis_id', 'int', 'Yes', 'Yes', 'No', 'A foreign key referencing the cm_analysis table.'],
      ['cm_diagnostics_summary', 'target_id', 'int', 'Yes', 'Yes', 'No', 'The identifier for the target cohort.'],
      ['cm_diagnostics_summary', 'comparator_id', 'int', 'Yes', 'Yes', 'No', 'The identifier for the comparator cohort.'],
      ['cm_diagnostics_summary', 'outcome_id', 'int', 'Yes', 'Yes', 'No', 'The identifier for the outcome cohort.'],
      ['cm_diagnostics_summary', 'database_id', 'varchar', 'Yes', 'Yes', 'No', 'A foreign key referencing the database.'],
      ['cm_diagnostics_summary', 'max_sdm', 'float', 'No', 'No', 'No', 'The maximum absolute standardized difference of mean.'],
      ['cm_diagnostics_summary', 'shared_max_sdm', 'float', 'No', 'No', 'No', 'The maximum absolute standardized difference of mean of the shared balance.'],
      ['cm_diagnostics_summary', 'equipoise', 'float', 'No', 'No', 'No', 'The fraction of the study population with a preference score between 0.3 and 0.7.'],
      ['cm_diagnostics_summary', 'mdrr', 'float', 'No', 'No', 'No', 'The minimum detectable relative risk.'],
      ['cm_diagnostics_summary', 'ease', 'float', 'No', 'No', 'No', 'The expected absolute systematic error.'],
      ['cm_diagnostics_summary', 'balance_diagnostic', 'varchar(20)', 'Yes', 'No', 'No', 'Pass / warning / fail classification of the balance diagnostic.'],
      ['cm_diagnostics_summary', 'shared_balance_diagnostic', 'varchar(20)', 'Yes', 'No', 'No', 'Pass / warning / fail classification of the shared balance diagnostic.'],
      ['cm_diagnostics_summary', 'equipoise_diagnostic', 'varchar(20)', 'Yes', 'No', 'No', 'Pass / warning / fail classification of the equipoise diagnostic.'],
      ['cm_diagnostics_summary', 'mdrr_diagnostic', 'varchar(20)', 'Yes', 'No', 'No', 'Pass / warning / fail classification of the MDRR diagnostic.'],
      ['cm_diagnostics_summary', 'ease_diagnostic', 'varchar(20)', 'Yes', 'No', 'No', 'Pass / warning / fail classification of the EASE diagnostic.'],
      ['cm_diagnostics_summary', 'unblind', 'int', 'Yes', 'No', 'No', 'Is unblinding the result recommended? (1 = yes, 0 = no)'],
    ]),
    'SelfControlledCaseSeriesModule/sccs_result.csv': csv(
      ['analysis_id', 'exposures_outcome_set_id', 'covariate_id', 'rr', 'ci_95_lb', 'ci_95_ub', 'p', 'outcome_subjects', 'outcome_events', 'outcome_observation_periods', 'covariate_subjects', 'covariate_days', 'covariate_eras', 'covariate_outcomes', 'observed_days', 'log_rr', 'se_log_rr', 'database_id'],
      [[1, 1, 1000, 2.41, 0.62, 9.3, 0.2, c(sccsOutcomeSubjects), c(sccsOutcomeSubjects + 1), c(sccsOutcomeSubjects), c(sccsOutcomeSubjects), Math.round(920 * scale), c(sccsOutcomeSubjects), c(2), Math.round(5400 * scale), 0.88, 0.69, db]],
    ),
    'SelfControlledCaseSeriesModule/resultsDataModelSpecification.csv': rdms([
      ['sccs_result', 'analysis_id', 'int', 'Yes', 'Yes', 'No', 'A foreign key referencing the sccs_analysis table.'],
      ['sccs_result', 'exposures_outcome_set_id', 'int', 'Yes', 'Yes', 'No', 'A foreign key referencing the sccs_exposures_outcome_set table.'],
      ['sccs_result', 'covariate_id', 'int', 'Yes', 'Yes', 'No', 'A foreign key referencing the sccs_covariate table.'],
      ['sccs_result', 'rr', 'float', 'No', 'No', 'No', 'The estimated relative risk (i.e. the incidence rate ratio).'],
      ['sccs_result', 'ci_95_lb', 'float', 'No', 'No', 'No', 'The lower bound of the 95% confidence interval of the relative risk.'],
      ['sccs_result', 'ci_95_ub', 'float', 'No', 'No', 'No', 'The upper bound of the 95% confidence interval of the relative risk.'],
      ['sccs_result', 'p', 'float', 'No', 'No', 'No', 'The two-sided p-value considering the null hypothesis of no effect.'],
      ['sccs_result', 'outcome_subjects', 'int', 'Yes', 'No', 'Yes', 'The number of subjects with at least one outcome.'],
      ['sccs_result', 'outcome_events', 'int', 'Yes', 'No', 'Yes', 'The number of outcome events.'],
      ['sccs_result', 'outcome_observation_periods', 'int', 'Yes', 'No', 'Yes', 'The number of observation periods containing at least one outcome.'],
      ['sccs_result', 'covariate_subjects', 'int', 'Yes', 'No', 'Yes', 'The number of subjects having the covariate.'],
      ['sccs_result', 'covariate_days', 'int', 'Yes', 'No', 'Yes', 'The total covariate time in days.'],
      ['sccs_result', 'covariate_eras', 'int', 'Yes', 'No', 'Yes', 'The number of continuous eras of the covariate.'],
      ['sccs_result', 'covariate_outcomes', 'int', 'Yes', 'No', 'Yes', 'The number of outcomes observed during the covariate time.'],
      ['sccs_result', 'observed_days', 'bigint', 'Yes', 'No', 'Yes', 'The number of days subjects were observed.'],
      ['sccs_result', 'log_rr', 'float', 'No', 'No', 'No', 'The log of the relative risk.'],
      ['sccs_result', 'se_log_rr', 'float', 'No', 'No', 'No', 'The standard error of the log of the relative risk.'],
      ['sccs_result', 'database_id', 'varchar', 'Yes', 'Yes', 'No', 'A foreign key referencing the database.'],
    ]),
  }
}

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [p, d] of Object.entries(files)) zip.file(p, d, { date: now })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const executionSettings = (min: number) =>
  JSON.stringify(
    {
      workDatabaseSchema: 'scratch',
      cdmDatabaseSchema: 'cdm',
      cohortTableNames: { cohortTable: 'acei_angio_2026', attr_class: 'CohortTableNames' },
      workFolder: '~/acei_angio_2026/strategusInternals/MY_DATABASE',
      resultsFolder: '~/acei_angio_2026/results/MY_DATABASE',
      minCellCount: min,
      attr_class: ['CdmExecutionSettings', 'ExecutionSettings'],
    },
    null,
    2,
  ) + '\n'

async function main() {
  for (const d of ['study-repo', 'protocol', 'network']) rmSync(path.join(root, d), { recursive: true, force: true })

  // ---- ScanReport --------------------------------------------------------
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Table', 'Field', 'Description', 'Type', 'Max length', 'N rows', 'N rows checked', 'Fraction empty'],
      ['patients', 'patient_key', '', 'varchar', 16, 152340, 100000, 0],
      ['patients', 'sex', '', 'char', 1, 152340, 100000, 0],
      ['patients', 'birth_year', '', 'int', 4, 152340, 100000, 0.01],
      ['diagnoses', 'icd10', 'ICD-10 code', 'varchar', 7, 2203911, 100000, 0],
      ['diagnoses', 'dx_date', '', 'date', 10, 2203911, 100000, 0],
    ]),
    'Field Overview',
  )
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['sex', 'Frequency', 'birth_year', 'Frequency'],
      ['M', 75012, '1950', 2210],
      ['F', 77325, '1951', 2302],
      ['U', 3, '1952', 2398],
    ]),
    'patients',
  )
  const scan = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
  out('site/ScanReport_sanitized.xlsx', scan)

  // ---- Study repository (coordinator) -------------------------------------
  const specText = analysisSpecification()
  const executeText = readFileSync(path.join(root, 'templates/ExecuteAnalyses.R'), 'utf8')
  const renvText = readFileSync(path.join(root, 'templates/renv.lock'), 'utf8')
  const configYml = readFileSync(path.join(root, 'templates/config.yml'), 'utf8')
  const repoFiles: Record<string, string> = {
    'inst/analysisSpecifications.json': specText,
    'ExecuteAnalyses.R': executeText,
    'renv.lock': renvText,
    'config.yml': configYml,
    'README.md': `# ${STUDY}\n\nSynthetic demo study repository for Study Studio (StrategusStudyRepoTemplate layout).\n`,
  }
  for (const [p, t] of Object.entries(repoFiles)) out(`study-repo/${p}`, t)
  out('study-repo.zip', await zipOf(Object.fromEntries(Object.entries(repoFiles).map(([p, t]) => [`${STUDY}-main/${p}`, t]))))

  // ---- Protocol ---------------------------------------------------------
  const repo = locateStudyRepo(Object.entries(repoFiles).map(([p, t]) => ({ path: p, bytes: enc.encode(t) })))
  const protocol = await issueProtocol(repo, {
    studyId: STUDY,
    studyTitle: 'ACE inhibitors vs thiazides and angioedema',
    description: 'Multi-site OMOP network study (demo).',
    principalInvestigator: 'Demo PI',
    sponsor: 'Demo Sponsor',
    cdmVersion: '5.4',
    minCellCount: MIN,
    now,
  })
  out('protocol/study_config.json', JSON.stringify(protocol.config, null, 2) + '\n')
  out(`protocol/${STUDY}_protocol.zip`, new Uint8Array(await (await protocolZip(protocol)).arrayBuffer()))

  // ---- Site Mode inputs -----------------------------------------------------
  // Each results set is written twice: as the Strategus::zipResults() ZIP and as the expanded
  // results/<databaseName> folder written by Strategus::execute() (for "Choose results folder…").
  const writeResults = async (dir: string, name: string, files: Record<string, string>) => {
    rmSync(path.join(root, dir, name), { recursive: true, force: true })
    for (const [p, t] of Object.entries(files)) out(`${dir}/${name}/${p}`, t)
    out(`${dir}/${name}.zip`, await zipOf(files))
  }
  rmSync(path.join(root, 'site/strategus_results_Site_A_with_violations.zip'), { force: true }) // old location
  out('site/executionSettings.json', executionSettings(MIN))
  await writeResults('site', 'strategus_results_Site_A', strategusResults('Site_A', 1, MIN))
  // Exported with minCellCount = 0 (no censoring) → small cells that Study Studio must block. The matching
  // executionSettings.json records 0, so the "exported below the protocol's minCellCount" warning fires too.
  out('site/with_violations/executionSettings.json', executionSettings(0))
  await writeResults('site/with_violations', 'strategus_results_Site_A_with_violations', strategusResults('Site_A', 1, 0))

  // ---- Network demo packs -----------------------------------------------------
  const siteFile = (p: string) => new Uint8Array(readFileSync(path.join(root, 'site', p)))
  const inputsFor = (siteId: string) =>
    executeText.replace('databaseName       <- "MY_DATABASE"', `databaseName       <- "${siteId}"`).replace('cdmDatabaseSchema  <- "cdm"', `cdmDatabaseSchema  <- "${siteId.toLowerCase()}_cdm"`)
  const makePack = async (siteId: string, scale: number, execute = inputsFor(siteId)) => {
    const results = Object.entries(strategusResults(siteId, scale, MIN)).map(([p, t]) => ({ path: p, bytes: enc.encode(t) }))
    const audits = auditResultFiles(results, { minCellCount: MIN })
    const slot = (id: SlotId, bytes: Uint8Array, originalName = SLOT_BY_ID[id].label): PackInputFile => ({
      path: SLOT_BY_ID[id].path,
      role: SLOT_BY_ID[id].role,
      originalName,
      bytes,
      audit: id === 'scanReport' ? auditWorkbook(bytes, originalName, { minCellCount: MIN }) : undefined,
    })
    const scanMasked = new Uint8Array(XLSX.write((() => {
      const w = XLSX.read(scan, { type: 'array' })
      w.Sheets.patients.B4 = { t: 'n', v: -MIN }
      return w
    })(), { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
    const files: PackInputFile[] = [
      { ...slot('scanReport', scanMasked), remediated: true },
      slot('mappingSpec', siteFile('mapping_specification.json')),
      slot('vocabularyVersion', siteFile('vocabulary_version.json')),
      slot('dqdResults', siteFile('dqd_results.json')),
      slot('analysisSpecifications', protocol.files['definitions/analysisSpecifications.json']),
      slot('executeAnalyses', enc.encode(execute)),
      slot('renvLock', protocol.files['code/renv.lock']),
      slot('executionSettings', enc.encode(executionSettings(MIN))),
      ...results.map((r) => ({ path: `results/${r.path}`, role: 'result' as const, originalName: r.path, bytes: r.bytes, audit: audits.get(r.path) })),
    ]
    const pack = await buildStudyPack({ studyId: STUDY, studyTitle: protocol.config.studyTitle, siteId, cdmVersion: '5.4', minCellCount: MIN, exportedMinCellCount: MIN, files, now })
    return { name: pack.zipName, bytes: new Uint8Array(await pack.zipBlob.arrayBuffer()) }
  }

  for (const [site, scale] of [['Site_A', 1], ['Site_B', 0.7]] as const) {
    const p = await makePack(site, scale)
    out(`network/${p.name}`, p.bytes)
  }
  // Tampered: a result edited after the manifest was sealed.
  const tampered = await makePack('Site_C', 1.3)
  const zip = await JSZip.loadAsync(tampered.bytes)
  const target = Object.keys(zip.files).find((p) => p.endsWith('results/CohortMethodModule/cm_result.csv'))!
  zip.file(target, (await zip.file(target)!.async('string')).replace(',3.12,', ',1.12,'))
  out(`network/${tampered.name}`, await zip.generateAsync({ type: 'uint8array' }))
  // Divergent: code below the protected marker edited (runs only some modules).
  const divergent = await makePack(
    'Site_D',
    0.9,
    inputsFor('Site_D').replace('  minCellCount = minCellCount\n)', '  minCellCount = minCellCount,\n  modulesToExecute = c("CohortGeneratorModule", "CohortMethodModule")\n)'),
  )
  out(`network/${divergent.name}`, divergent.bytes)

  console.log(`samples written to ${root}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
