/**
 * Strategus analysis specification (inst/analysisSpecifications.json) parsing.
 * The file is produced by ParallelLogger::saveSettingsToJson() in the study designer's R session
 * (see ohdsi-studies/StrategusStudyRepoTemplate). OHDSI Study Studio only reads and pins it.
 */
import { isCirceExpression } from '@/lib/codegen/circe'

type Dict = Record<string, unknown>

export interface SpecCohort {
  cohortId: number
  cohortName: string
  /** Parsed CIRCE expression, when the definition is a CIRCE cohort. */
  expression?: Record<string, unknown>
  /** Roles across all estimation modules, e.g. ['target (CM)', 'exposure (SCCS)']. Empty when only generated/characterized. */
  roles: string[]
  /** true for cohorts created by a subset definition (derived from another cohort). */
  subset: boolean
}

export interface CohortMethodSummary {
  analyses: { analysisId: number; description: string }[]
  targetComparatorOutcomes: {
    targetId: number
    comparatorId: number
    outcomesOfInterest: number[]
    negativeControlOutcomes: number
    excludedCovariateConcepts: number
  }[]
  diagnosticThresholds?: Record<string, unknown>
}

export interface SccsSummary {
  analyses: { analysisId: number; description: string }[]
  exposures: { exposureId: number; outcomesOfInterest: number[]; negativeControlOutcomes: number }[]
  diagnosticThresholds?: Record<string, unknown>
}

export interface AnalysisSpecSummary {
  modules: string[]
  cohorts: SpecCohort[]
  negativeControlOutcomes: number
  cohortMethod?: CohortMethodSummary
  sccs?: SccsSummary
}

const asList = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : v && typeof v === 'object' ? [v as Dict] : [])
const num = (v: unknown) => Number(typeof v === 'string' ? v.trim() : v)
const classes = (o: Dict | undefined) => (Array.isArray(o?.attr_class) ? (o!.attr_class as string[]) : o?.attr_class ? [String(o.attr_class)] : [])

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

function analyses(list: unknown) {
  return asList(list).map((a, i) => ({ analysisId: num(a.analysisId ?? i + 1), description: String(a.description ?? `Analysis ${i + 1}`) }))
}

export function parseAnalysisSpecification(text: string): AnalysisSpecSummary {
  let d: Dict
  try {
    d = JSON.parse(text) as Dict
  } catch {
    throw new Error('analysisSpecifications.json is not valid JSON')
  }
  if (!classes(d).includes('AnalysisSpecifications') || !Array.isArray(d.moduleSpecifications)) {
    throw new Error('Not a Strategus analysis specification (expected attr_class "AnalysisSpecifications" and moduleSpecifications)')
  }
  const shared = asList(d.sharedResources)
  const cohortRes = shared.find((r) => classes(r).includes('CohortDefinitionSharedResources'))
  const ncRes = shared.find((r) => classes(r).includes('NegativeControlOutcomeSharedResources'))
  const subsetIds = new Set(asList(cohortRes?.cohortSubsets).map((s) => num(s.cohortId)))
  const ncSet = parseMaybeJson(ncRes?.negativeControlOutcomes) as Dict | undefined
  const ncList = asList(ncSet?.negativeControlOutcomeCohortSet)
  const ncIds = new Set(ncList.map((n) => num(n.cohortId)))

  const modules = (d.moduleSpecifications as Dict[]).map((m) => String(m.module))
  const settingsOf = (name: string) => (d.moduleSpecifications as Dict[]).find((m) => m.module === name)?.settings as Dict | undefined

  let cohortMethod: CohortMethodSummary | undefined
  const cmSettings = settingsOf('CohortMethodModule')
  if (cmSettings) {
    const cm = (cmSettings.cmAnalysesSpecifications ?? cmSettings) as Dict
    cohortMethod = {
      analyses: analyses(cm.cmAnalysisList),
      targetComparatorOutcomes: asList(cm.targetComparatorOutcomesList).map((t) => {
        const outcomes = asList(t.outcomes)
        return {
          targetId: num(t.targetId),
          comparatorId: num(t.comparatorId),
          outcomesOfInterest: outcomes.filter((o) => o.outcomeOfInterest !== false && !ncIds.has(num(o.outcomeId))).map((o) => num(o.outcomeId)),
          negativeControlOutcomes: outcomes.filter((o) => o.outcomeOfInterest === false || ncIds.has(num(o.outcomeId))).length,
          excludedCovariateConcepts: Array.isArray(t.excludedCovariateConceptIds) ? t.excludedCovariateConceptIds.length : 0,
        }
      }),
      diagnosticThresholds: cm.cmDiagnosticThresholds as Dict | undefined,
    }
  }

  let sccs: SccsSummary | undefined
  const sccsSettings = settingsOf('SelfControlledCaseSeriesModule')
  if (sccsSettings) {
    const sc = (sccsSettings.sccsAnalysesSpecifications ?? sccsSettings) as Dict
    const byExposure = new Map<number, { outcomesOfInterest: number[]; negativeControlOutcomes: number }>()
    for (const eo of asList(sc.exposuresOutcomeList)) {
      const outcomeId = num(eo.outcomeId)
      for (const e of asList(eo.exposures)) {
        const id = num(e.exposureId)
        const entry = byExposure.get(id) ?? { outcomesOfInterest: [], negativeControlOutcomes: 0 }
        if (ncIds.has(outcomeId)) entry.negativeControlOutcomes++
        else if (!entry.outcomesOfInterest.includes(outcomeId)) entry.outcomesOfInterest.push(outcomeId)
        byExposure.set(id, entry)
      }
    }
    sccs = {
      analyses: analyses(sc.sccsAnalysisList),
      exposures: [...byExposure.entries()].map(([exposureId, v]) => ({ exposureId, ...v })),
      diagnosticThresholds: sc.sccsDiagnosticThresholds as Dict | undefined,
    }
  }

  const roles = new Map<number, Set<string>>()
  const add = (id: number, role: string) => roles.set(id, (roles.get(id) ?? new Set()).add(role))
  cohortMethod?.targetComparatorOutcomes.forEach((t) => {
    add(t.targetId, 'target (CM)')
    add(t.comparatorId, 'comparator (CM)')
    t.outcomesOfInterest.forEach((o) => add(o, 'outcome (CM)'))
  })
  sccs?.exposures.forEach((e) => {
    add(e.exposureId, 'exposure (SCCS)')
    e.outcomesOfInterest.forEach((o) => add(o, 'outcome (SCCS)'))
  })
  const rolesOf = (id: number) => [...(roles.get(id) ?? [])]

  const cohorts: SpecCohort[] = asList(cohortRes?.cohortDefinitions).map((c) => {
    const id = num(c.cohortId)
    const parsed = parseMaybeJson(c.cohortDefinition)
    return {
      cohortId: id,
      cohortName: String(c.cohortName ?? `Cohort ${id}`),
      expression: isCirceExpression(parsed) ? (parsed as Record<string, unknown>) : undefined,
      roles: rolesOf(id),
      subset: false,
    }
  })
  // Subset cohorts are generated at run time; list them so their roles are visible too.
  for (const s of asList(cohortRes?.cohortSubsets)) {
    const id = num(s.cohortId)
    if (cohorts.some((c) => c.cohortId === id)) continue
    const parent = cohorts.find((c) => c.cohortId === num(s.targetCohortId))
    cohorts.push({
      cohortId: id,
      cohortName: `${parent?.cohortName ?? `Cohort ${s.targetCohortId}`} (subset ${s.subsetId})`,
      expression: undefined,
      roles: rolesOf(id),
      subset: subsetIds.has(id),
    })
  }

  const negativeControlOutcomes = ncList.length

  return { modules, cohorts: cohorts.sort((a, b) => a.cohortId - b.cohortId), negativeControlOutcomes, cohortMethod, sccs }
}
