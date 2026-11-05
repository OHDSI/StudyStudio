/**
 * Data-quality gate over OHDSI Data Quality Dashboard results (requirements R4).
 *
 * DQD has no notion of severity and some failures are normal for any real database, so "block on any
 * failure" is not workable. The gate applies a policy that is pre-specified in the protocol
 * (study_config.dataQuality) and scoped to the CDM tables the study actually uses.
 */
import type { DqdGatePolicy, GateSeverity } from '@/types/studypack'

export interface DqdCheck {
  checkId?: string
  checkName: string
  checkLevel: string
  category: string
  subcategory?: string
  cdmTableName?: string
  cdmFieldName?: string
  failed: boolean
  isError: boolean
  notApplicable: boolean
  numViolatedRows?: number
  pctViolatedRows?: number
  thresholdValue?: number
}

export interface DqdMetadata {
  cdmSourceName?: string
  cdmVersion?: string
  vocabularyVersion?: string
  dqdVersion?: string
  startTimestamp?: string
  endTimestamp?: string
}

export interface DqdFinding {
  severity: GateSeverity
  ruleId: string
  rationale: string
  check?: DqdCheck
}

export interface DqdGateResult {
  present: boolean
  policyVersion: string
  checksEvaluated: number
  counts: Record<GateSeverity, number>
  /** block and warn findings, plus info findings up to a cap (info can number in the hundreds). */
  findings: DqdFinding[]
  blocked: boolean
  metadata: DqdMetadata
}

/** Structural conformance checks: if these fail on a study table, cohort extraction is not well-defined (FDA-RWD §VI.A(6)). */
export const STRUCTURAL_CHECKS = ['cdmTable', 'cdmField', 'cdmDatatype', 'isRequired', 'isPrimaryKey', 'isForeignKey']

export const BASE_STUDY_TABLES = ['PERSON', 'OBSERVATION_PERIOD']

export function defaultDqdPolicy(studyTables: string[] = BASE_STUDY_TABLES): DqdGatePolicy {
  return {
    policyVersion: 'studypack-dq-1',
    requireDqd: true,
    requireCheckResults: true,
    studyTables: [...new Set([...BASE_STUDY_TABLES, ...studyTables].map((t) => t.toUpperCase()))].sort(),
    errorSeverity: 'block',
    rules: [
      {
        id: 'structural-conformance',
        severity: 'block',
        match: { checkName: STRUCTURAL_CHECKS, studyTablesOnly: true },
        rationale: 'Structural conformance failure on a table the study uses: cohort extraction is not well-defined.',
      },
      {
        id: 'study-table',
        severity: 'warn',
        match: { studyTablesOnly: true },
        rationale: 'Data-quality failure on a table the study uses; the coordinator reviews its impact.',
      },
    ],
    defaultFailedSeverity: 'info',
  }
}

// ---------------------------------------------------------------- study tables

/** CIRCE criteria types → OMOP CDM tables. */
const CRITERIA_TABLE: Record<string, string> = {
  ConditionOccurrence: 'CONDITION_OCCURRENCE',
  ConditionEra: 'CONDITION_ERA',
  DrugExposure: 'DRUG_EXPOSURE',
  DrugEra: 'DRUG_ERA',
  DoseEra: 'DOSE_ERA',
  ProcedureOccurrence: 'PROCEDURE_OCCURRENCE',
  Measurement: 'MEASUREMENT',
  Observation: 'OBSERVATION',
  VisitOccurrence: 'VISIT_OCCURRENCE',
  VisitDetail: 'VISIT_DETAIL',
  DeviceExposure: 'DEVICE_EXPOSURE',
  Death: 'DEATH',
  Specimen: 'SPECIMEN',
  ObservationPeriod: 'OBSERVATION_PERIOD',
  PayerPlanPeriod: 'PAYER_PLAN_PERIOD',
}

/** Tables FeatureExtraction's default covariates read (propensity models, characterization, prediction). */
const COVARIATE_TABLES = ['CONDITION_OCCURRENCE', 'CONDITION_ERA', 'DRUG_EXPOSURE', 'DRUG_ERA', 'PROCEDURE_OCCURRENCE', 'MEASUREMENT', 'OBSERVATION', 'DEVICE_EXPOSURE', 'VISIT_OCCURRENCE']
const COVARIATE_MODULES = /CohortMethod|PatientLevelPrediction|Characterization|CohortIncidence/

function walk(v: unknown, found: Set<string>) {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, found))
  if (!v || typeof v !== 'object') return
  for (const [k, child] of Object.entries(v)) {
    if (CRITERIA_TABLE[k]) found.add(CRITERIA_TABLE[k])
    walk(child, found)
  }
}

/** CDM tables a study depends on, from its CIRCE cohort expressions and Strategus modules. */
export function studyTablesFor(cohortExpressions: unknown[], modules: string[]): string[] {
  const found = new Set(BASE_STUDY_TABLES)
  for (const e of cohortExpressions) walk(e, found)
  if (modules.some((m) => COVARIATE_MODULES.test(m))) COVARIATE_TABLES.forEach((t) => found.add(t))
  return [...found].sort()
}

// ---------------------------------------------------------------- parsing

type Dict = Record<string, unknown>
const flag = (v: unknown) => v === true || Number(v) === 1
const num = (v: unknown) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v))
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)

export function parseDqd(json: unknown): { checks?: DqdCheck[]; metadata: DqdMetadata } {
  const d = (json && typeof json === 'object' ? json : {}) as Dict
  const raw = (d.CheckResults ?? d.checkResults) as Dict[] | undefined
  const meta = (Array.isArray(d.Metadata) ? d.Metadata[0] : d.Metadata) as Dict | undefined
  const metadata: DqdMetadata = {
    cdmSourceName: str(meta?.CDM_SOURCE_NAME ?? meta?.cdmSourceName),
    cdmVersion: str(meta?.CDM_VERSION ?? meta?.cdmVersion),
    vocabularyVersion: str(meta?.VOCABULARY_VERSION ?? meta?.vocabularyVersion),
    dqdVersion: str(meta?.DQD_VERSION ?? meta?.dqdVersion),
    startTimestamp: str(d.startTimestamp),
    endTimestamp: str(d.endTimestamp),
  }
  if (!Array.isArray(raw) || raw.length === 0) return { metadata }
  return {
    metadata,
    checks: raw.map((c) => ({
      checkId: str(c.checkId),
      checkName: String(c.checkName ?? ''),
      checkLevel: String(c.checkLevel ?? ''),
      category: String(c.category ?? ''),
      subcategory: str(c.subcategory),
      cdmTableName: str(c.cdmTableName)?.toUpperCase(),
      cdmFieldName: str(c.cdmFieldName)?.toUpperCase(),
      failed: flag(c.failed),
      isError: flag(c.isError),
      notApplicable: flag(c.notApplicable),
      numViolatedRows: num(c.numViolatedRows),
      pctViolatedRows: num(c.pctViolatedRows),
      thresholdValue: num(c.thresholdValue),
    })),
  }
}

// ---------------------------------------------------------------- evaluation

const INFO_CAP = 50

export function evaluateDqdGate(json: unknown | undefined, policy: DqdGatePolicy = defaultDqdPolicy()): DqdGateResult {
  const counts: Record<GateSeverity, number> = { block: 0, warn: 0, info: 0 }
  const findings: DqdFinding[] = []
  const push = (f: DqdFinding) => {
    counts[f.severity]++
    if (f.severity !== 'info' || counts.info <= INFO_CAP) findings.push(f)
  }
  const result = (present: boolean, metadata: DqdMetadata, checksEvaluated = 0): DqdGateResult => ({
    present,
    policyVersion: policy.policyVersion,
    checksEvaluated,
    counts,
    findings,
    blocked: counts.block > 0,
    metadata,
  })

  if (json === undefined) {
    push({ severity: policy.requireDqd ? 'block' : 'warn', ruleId: 'dqd-missing', rationale: 'No Data Quality Dashboard results were provided.' })
    return result(false, {})
  }
  const { checks, metadata } = parseDqd(json)
  if (!checks) {
    push({
      severity: policy.requireCheckResults ? 'block' : 'warn',
      ruleId: 'check-results-missing',
      rationale: 'The DQD file has no per-check results (CheckResults), so failures cannot be scoped to the tables this study uses.',
    })
    return result(true, metadata)
  }

  const studyTables = new Set(policy.studyTables.map((t) => t.toUpperCase()))
  const onStudyTable = (c: DqdCheck) => !!c.cdmTableName && studyTables.has(c.cdmTableName)
  let evaluated = 0
  for (const c of checks) {
    if (c.notApplicable) continue
    evaluated++
    if (c.isError) {
      push({ severity: onStudyTable(c) ? policy.errorSeverity : 'warn', ruleId: 'check-error', rationale: 'The DQD check did not execute (SQL error).', check: c })
      continue
    }
    if (!c.failed) continue
    const rule = policy.rules.find(
      (r) =>
        (!r.match.checkName || r.match.checkName.includes(c.checkName)) &&
        (!r.match.category || r.match.category.some((x) => x.toLowerCase() === c.category.toLowerCase())) &&
        (!r.match.studyTablesOnly || onStudyTable(c)),
    )
    push(
      rule
        ? { severity: rule.severity, ruleId: rule.id, rationale: rule.rationale, check: c }
        : { severity: policy.defaultFailedSeverity, ruleId: 'default', rationale: 'Failure outside the tables this study uses.', check: c },
    )
  }
  return result(true, metadata, evaluated)
}

export function describeCheck(c: DqdCheck): string {
  const where = [c.cdmTableName, c.cdmFieldName].filter(Boolean).join('.')
  const pct = c.pctViolatedRows !== undefined ? ` — ${(c.pctViolatedRows * (c.pctViolatedRows <= 1 ? 100 : 1)).toFixed(2)}% rows violated` : ''
  return `${c.category}${c.subcategory ? `/${c.subcategory}` : ''} ${c.checkName}${where ? ` on ${where}` : ''}${pct}`
}
