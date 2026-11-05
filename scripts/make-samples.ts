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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { parseCirceText } from '../src/lib/codegen/circe'
import { issueProtocol, locateStudyRepo, protocolZip } from '../src/lib/strategus/protocol'
import { auditResultFiles } from '../src/lib/strategus/results'
import { auditWorkbook } from '../src/lib/audit/cellAuditor'
import { buildStudyPack, type PackInputFile } from '../src/lib/studypack/builder'
import { redactLog } from '../src/lib/audit/logAuditor'
import { evaluateEvidence } from '../src/lib/studypack/evidence'
import {
  addSignature,
  createKeyFile,
  enrollmentCard,
  parseKeyFile,
  rosterBytes,
  unlockKeyFile,
  type SignatureMeaning,
  type SignerInfo,
  type SignerRoster,
  type UnlockedSigner,
} from '../src/lib/security/signer'
import type { IssuedProtocol } from '../src/lib/strategus/protocol'
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
/** Passphrase of the demo keys in samples/regulatory/keys. Public on purpose — demo only. */
const DEMO_PASSPHRASE = 'demo-passphrase-not-secret'

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
    'CohortDiagnosticsModule/cd_cohort_count.csv': csv(
      ['database_id', 'cohort_id', 'cohort_entries', 'cohort_subjects'],
      [
        [db, 1, c(18342 * scale), c(15210 * scale)],
        [db, 2, c(25120 * scale), c(21877 * scale)],
      ],
    ),
    'CohortDiagnosticsModule/resultsDataModelSpecification.csv': rdms([
      ['cd_cohort_count', 'database_id', 'varchar', 'Yes', 'Yes', 'No', 'The database identifier'],
      ['cd_cohort_count', 'cohort_id', 'bigint', 'Yes', 'Yes', 'No', 'The cohort identifier'],
      ['cd_cohort_count', 'cohort_entries', 'bigint', 'Yes', 'No', 'Yes', 'The number of cohort entries'],
      ['cd_cohort_count', 'cohort_subjects', 'bigint', 'Yes', 'No', 'Yes', 'The number of unique subjects'],
    ]),
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

/** OHDSI DQD output (synthetic): metadata matching the site's cdm_source, plus per-check results. */
function dqdResults(siteId: string, opts: { structuralFailure?: boolean } = {}): string {
  const check = (checkName: string, category: string, table: string, field: string | null, failed: 0 | 1, pct = 0) => ({
    checkId: `${checkName}_${table}${field ? `_${field}` : ''}`.toLowerCase(),
    checkName,
    checkLevel: field ? 'FIELD' : 'TABLE',
    category,
    subcategory: category === 'Plausibility' ? 'Atemporal' : category === 'Conformance' ? 'Relational' : '',
    context: 'Verification',
    cdmTableName: table,
    cdmFieldName: field,
    numViolatedRows: failed ? Math.round(pct * 100000) : 0,
    pctViolatedRows: pct,
    thresholdValue: failed ? 0 : 5,
    failed,
    passed: failed ? 0 : 1,
    isError: 0,
    notApplicable: 0,
  })
  const checks = [
    check('cdmTable', 'Conformance', 'PERSON', null, 0),
    check('cdmTable', 'Conformance', 'DRUG_EXPOSURE', null, 0),
    check('isRequired', 'Conformance', 'DRUG_EXPOSURE', 'DRUG_CONCEPT_ID', 0),
    check('isForeignKey', 'Conformance', 'CONDITION_OCCURRENCE', 'CONDITION_CONCEPT_ID', 0),
    check('plausibleDuringLife', 'Plausibility', 'OBSERVATION_PERIOD', 'OBSERVATION_PERIOD_END_DATE', 0),
    // A known, tolerated failure on a table the study does not use.
    check('measureValueCompleteness', 'Completeness', 'NOTE', 'NOTE_TEXT', 1, 0.31),
    // A required field missing on a table the study uses: blocks a regulatory study.
    ...(opts.structuralFailure ? [check('isRequired', 'Conformance', 'DRUG_EXPOSURE', 'DRUG_EXPOSURE_START_DATE', 1, 0.042)] : []),
  ]
  const failed = checks.filter((c) => c.failed).length
  return JSON.stringify(
    {
      startTimestamp: '2026-10-28 09:12:03',
      endTimestamp: '2026-10-28 10:41:55',
      executionTime: '89.9 mins',
      Metadata: [{ CDM_SOURCE_NAME: `${siteId} hospital EHR (demo)`, CDM_VERSION: '5.4', DQD_VERSION: '2.6.1', VOCABULARY_VERSION: 'v5.0 30-AUG-26' }],
      Overview: { countTotal: checks.length, countThresholdFailed: failed, countErrorFailed: 0, countOverallFailed: failed, countPassed: checks.length - failed, percentPassed: ((checks.length - failed) / checks.length) * 100 },
      CheckResults: checks,
    },
    null,
    2,
  ) + '\n'
}

/** Strategus / ParallelLogger log (synthetic). Contains a connection line with credentials to show redaction. */
function strategusLog(siteId: string): string {
  const t = (h: string) => `2026-11-02 ${h}`
  return [
    `${t('01:00:00')}\t[Main thread]\tINFO\tStrategus\texecute\tStrategus 1.2.0 — executing analysis specification`,
    `Connecting using PostgreSQL driver: server = "db01.${siteId.toLowerCase()}.local/cdm", user = "omop_admin", password = "demo-only"`,
    `${t('01:00:02')}\t[Main thread]\tINFO\tStrategus\texecute\tminCellCount = ${MIN}`,
    `${t('01:00:05')}\t[Main thread]\tINFO\tStrategus\texecute\tRunning CohortGeneratorModule`,
    `${t('01:20:44')}\t[Main thread]\tINFO\tStrategus\texecute\tRunning CohortDiagnosticsModule`,
    `${t('01:41:10')}\t[Main thread]\tINFO\tStrategus\texecute\tRunning CohortMethodModule`,
    `${t('02:55:31')}\t[Main thread]\tWARN\tCohortMethod\tfitOutcomeModel\tHigh correlation between a covariate and treatment; covariate excluded`,
    `${t('03:02:09')}\t[Main thread]\tINFO\tStrategus\texecute\tRunning SelfControlledCaseSeriesModule`,
    `${t('03:40:57')}\t[Main thread]\tINFO\tStrategus\texecute\tResults written to /home/analyst/${STUDY.toLowerCase()}/results/${siteId}`,
    `${t('03:41:02')}\t[Main thread]\tINFO\tStrategus\texecute\tFinished`,
    '',
  ].join('\n')
}

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
    'README.md': `# ${STUDY}\n\nSynthetic demo study repository for OHDSI Study Studio (StrategusStudyRepoTemplate layout).\n`,
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
  out('protocol/study_config.json', protocol.configBytes)
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
  out('site/dqd_results.json', dqdResults('Site_A'))
  out('site/strategus-log.txt', strategusLog('Site_A'))
  await writeResults('site', 'strategus_results_Site_A', strategusResults('Site_A', 1, MIN))
  // Exported with minCellCount = 0 (no censoring) → small cells that OHDSI Study Studio must block. The matching
  // executionSettings.json records 0, so the "exported below the protocol's minCellCount" warning fires too.
  out('site/with_violations/executionSettings.json', executionSettings(0))
  await writeResults('site/with_violations', 'strategus_results_Site_A_with_violations', strategusResults('Site_A', 1, 0))

  // ---- Network demo packs -----------------------------------------------------
  const siteFile = (p: string) => new Uint8Array(readFileSync(path.join(root, 'site', p)))
  const inputsFor = (siteId: string) =>
    executeText.replace('databaseName       <- "MY_DATABASE"', `databaseName       <- "${siteId}"`).replace('cdmDatabaseSchema  <- "cdm"', `cdmDatabaseSchema  <- "${siteId.toLowerCase()}_cdm"`)
  interface PackOptions {
    protocol?: IssuedProtocol
    signers?: { signer: UnlockedSigner; meaning: SignatureMeaning }[]
    structuralFailure?: boolean
  }
  const makePack = async (siteId: string, scale: number, execute = inputsFor(siteId), opts: PackOptions = {}) => {
    const proto = opts.protocol ?? protocol
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
      slot('dqdResults', enc.encode(dqdResults(siteId, { structuralFailure: opts.structuralFailure }))),
      slot('analysisSpecifications', proto.files['definitions/analysisSpecifications.json']),
      slot('executeAnalyses', enc.encode(execute)),
      slot('renvLock', proto.files['code/renv.lock']),
      slot('executionSettings', enc.encode(executionSettings(MIN))),
      ...results.map((r) => ({ path: `results/${r.path}`, role: 'result' as const, originalName: r.path, bytes: r.bytes, audit: audits.get(r.path) })),
    ]
    // The ScanReport was masked at the site: pack only a salted commitment to the original.
    files[0] = { ...files[0], original: scan, modification: { kind: 'small-cell-masking', rule: `Counts with 0 < n < ${MIN} replaced by -${MIN}`, counts: { maskedCells: 1, droppedIdentifierColumns: 0 }, reason: `Small-cell suppression required by the protocol (minCellCount ${MIN})` } }
    const rawLog = enc.encode(strategusLog(siteId))
    const red = redactLog(strategusLog(siteId))
    files.push({
      ...slot('executionLog', enc.encode(red.text), 'strategus-log.txt'),
      original: rawLog,
      modification: { kind: 'log-redaction', rule: 'Credentials, hosts, user names and home-directory names replaced by [REDACTED]', counts: red.summary, reason: 'Remove credentials and identifying infrastructure details before the log leaves the site' },
    })
    // Sealed after the run (the protocol was issued at `now`).
    const sealed = new Date(now.getTime() + 2 * 24 * 3600 * 1000)
    const pack = await buildStudyPack({
      studyId: STUDY,
      studyTitle: proto.config.studyTitle,
      siteId,
      cdmVersion: '5.4',
      minCellCount: MIN,
      exportedMinCellCount: MIN,
      files,
      now: sealed,
      assurance: proto.config.assurance ?? 'standard',
      protocolBytes: proto.configBytes,
      protocolSignatureBytes: proto.signature ? enc.encode(JSON.stringify(proto.signature, null, 2) + '\n') : undefined,
      signers: opts.signers,
      evidence: evaluateEvidence({ config: proto.config, files: Object.fromEntries(files.map((f) => [f.path, f.bytes])), sealedAt: sealed.toISOString() }),
    })
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

  // ---- Regulatory demo set ---------------------------------------------------
  // Keys are created once and reused, so re-running the generator keeps the same identities.
  // DEMO ONLY: the passphrase is public. Never reuse these keys.
  for (const d of ['regulatory/protocol', 'regulatory/network']) rmSync(path.join(root, d), { recursive: true, force: true })
  const demoKey = async (file: string, signer: SignerInfo): Promise<UnlockedSigner> => {
    const keyPath = path.join(root, 'regulatory/keys', `${file}.key.json`)
    let kf = existsSync(keyPath) ? parseKeyFile(JSON.parse(readFileSync(keyPath, 'utf8'))) : undefined
    if (!kf) {
      kf = await createKeyFile(signer, DEMO_PASSPHRASE, { now: new Date('2026-10-20T00:00:00Z') })
      out(`regulatory/keys/${file}.key.json`, JSON.stringify(kf, null, 2) + '\n')
      out(`regulatory/keys/${file}.enrollment.json`, JSON.stringify(enrollmentCard(kf), null, 2) + '\n')
    }
    return unlockKeyFile(kf, DEMO_PASSPHRASE)
  }
  const coord = await demoKey('coordinator', { name: 'Carol Coordinator', organization: 'OHDSI Demo Network', role: 'coordinator' })
  const opA = await demoKey('site_a_operator', { name: 'Olivia Operator', organization: 'Site A Hospital', role: 'operator' })
  const piA = await demoKey('site_a_pi', { name: 'Paul Investigator', organization: 'Site A Hospital', role: 'site-pi' })
  const opB = await demoKey('site_b_operator', { name: 'Bea Operator', organization: 'Site B Hospital', role: 'operator' })
  const opC = await demoKey('site_c_operator', { name: 'Cal Operator', organization: 'Site C Hospital', role: 'operator' })
  const opD = await demoKey('site_d_operator', { name: 'Dana Operator', organization: 'Site D Hospital', role: 'operator' })

  const regProtocol = await issueProtocol(repo, {
    studyId: STUDY,
    studyTitle: 'ACE inhibitors vs thiazides and angioedema (regulatory demo)',
    description: 'Multi-site OMOP network study with regulatory assurance (demo).',
    principalInvestigator: 'Demo PI',
    sponsor: 'Demo Sponsor',
    cdmVersion: '5.4',
    minCellCount: MIN,
    now,
    assurance: 'regulatory',
    vocabularyVersion: 'v5.0 30-AUG-26',
    signer: coord,
  })
  out('regulatory/protocol/study_config.json', regProtocol.configBytes)
  out('regulatory/protocol/study_config.jws.json', JSON.stringify(regProtocol.signature, null, 2) + '\n')
  out(`regulatory/protocol/${STUDY}_protocol.zip`, new Uint8Array(await (await protocolZip(regProtocol)).arrayBuffer()))

  // Site C's operator is deliberately not enrolled.
  const enrolled = (u: UnlockedSigner, siteId?: string) => ({
    kid: u.kid,
    name: u.signer.name,
    organization: u.signer.organization,
    role: u.signer.role,
    siteId,
    enrolledAt: '2026-10-25T00:00:00.000Z',
    verifiedBy: 'Carol Coordinator',
    verificationMethod: 'Video call with government ID; key fingerprint read back by the signer',
  })
  const roster: SignerRoster = { format: 'studypack-signer-roster/1', studyId: STUDY, signers: [enrolled(coord), enrolled(opA, 'Site_A'), enrolled(piA, 'Site_A'), enrolled(opB, 'Site_B'), enrolled(opD, 'Site_D')] }
  const rb = rosterBytes(roster)
  out('regulatory/signer_roster.json', rb)
  out('regulatory/signer_roster.jws.json', JSON.stringify(await addSignature(undefined, rb, coord, 'roster-approved', new Date('2026-10-26T00:00:00Z')), null, 2) + '\n')

  const sealedBy = (...s: UnlockedSigner[]) => s.map((signer) => ({ signer, meaning: (signer.signer.role === 'site-pi' ? 'approved-for-release' : 'sealed') as SignatureMeaning }))
  const regPacks = [
    await makePack('Site_A', 1, undefined, { protocol: regProtocol, signers: sealedBy(opA, piA) }),
    await makePack('Site_B', 0.7, undefined, { protocol: regProtocol, signers: sealedBy(opB) }),
    await makePack('Site_C', 1.3, undefined, { protocol: regProtocol, signers: sealedBy(opC) }),
    await makePack('Site_D', 0.9, undefined, { protocol: regProtocol, signers: sealedBy(opD), structuralFailure: true }),
  ]
  for (const p of regPacks) out(`regulatory/network/${p.name}`, p.bytes)

  console.log(`samples written to ${root}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
