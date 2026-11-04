/**
 * ATLAS / CIRCE cohort definition parsing.
 *
 * Accepted inputs:
 *  - WebAPI export:            { id, name, expression }  (expression may be a JSON string)
 *  - CohortGenerator style:    { cohortId, cohortName, json }
 *  - Bare CIRCE expression:    { ConceptSets, PrimaryCriteria, ... }  (id derived from file name)
 *  - Arrays of the above, or bundles { cohorts: [...] } / { cohortDefinitions: [...] }
 */
export interface ConceptSetSummary {
  id: number
  name: string
  itemCount: number
}

export interface ParsedCohort {
  cohortId: number
  cohortName: string
  expression: Record<string, unknown>
  conceptSets: ConceptSetSummary[]
  primaryDomains: string[]
  inclusionRules: string[]
  sourceFile: string
}

type Dict = Record<string, unknown>

export function isCirceExpression(v: unknown): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ('PrimaryCriteria' in v || 'ConceptSets' in v)
}

function asExpression(v: unknown): Dict | undefined {
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return undefined
    }
  }
  return isCirceExpression(v) ? (v as Dict) : undefined
}

export function summarizeExpression(expr: Dict) {
  const conceptSets = ((expr.ConceptSets as Dict[]) ?? []).map((cs) => ({
    id: Number(cs.id),
    name: String(cs.name ?? `ConceptSet ${cs.id}`),
    itemCount: (((cs.expression as Dict)?.items as unknown[]) ?? []).length,
  }))
  const criteria = (((expr.PrimaryCriteria as Dict)?.CriteriaList as Dict[]) ?? []).flatMap((c) => Object.keys(c))
  const inclusionRules = ((expr.InclusionRules as Dict[]) ?? []).map((r, i) => String(r.name ?? `Rule ${i + 1}`))
  return { conceptSets, primaryDomains: [...new Set(criteria)], inclusionRules }
}

function idFromFileName(name: string): number | undefined {
  const m = name.match(/(\d+)/)
  return m ? Number(m[1]) : undefined
}

function one(item: unknown, sourceFile: string, fallbackId: number): ParsedCohort | undefined {
  if (!item || typeof item !== 'object') return undefined
  const o = item as Dict
  let expr: Dict | undefined
  let id: number | undefined
  let name: string | undefined
  if (isCirceExpression(o)) {
    expr = o
    id = idFromFileName(sourceFile)
    name = sourceFile.replace(/\.json$/i, '')
  } else {
    expr = asExpression(o.expression ?? o.json ?? o.expressionJson)
    id = Number(o.cohortId ?? o.id)
    name = String(o.cohortName ?? o.name ?? '')
  }
  if (!expr) return undefined
  const cohortId = Number.isFinite(id) && id! > 0 ? id! : fallbackId
  return { cohortId, cohortName: name || `Cohort ${cohortId}`, expression: expr, sourceFile, ...summarizeExpression(expr) }
}

export function parseCirceText(text: string, sourceFile = 'cohort.json'): ParsedCohort[] {
  const data = JSON.parse(text) as unknown
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as Dict).cohorts)
      ? ((data as Dict).cohorts as unknown[])
      : data && typeof data === 'object' && Array.isArray((data as Dict).cohortDefinitions)
        ? ((data as Dict).cohortDefinitions as unknown[])
        : [data]
  const out = list.map((item, i) => one(item, sourceFile, i + 1)).filter((c): c is ParsedCohort => !!c)
  if (out.length === 0) throw new Error(`${sourceFile}: not a valid CIRCE cohort definition`)
  return out
}

/** Human readable one-line description of a cohort's entry criteria (used in Define-XML comments). */
export function describeCohort(expr: Dict): string {
  const s = summarizeExpression(expr)
  const parts = [
    s.primaryDomains.length ? `Entry events: ${s.primaryDomains.join(', ')}` : 'Entry events: (none)',
    s.conceptSets.length ? `Concept sets: ${s.conceptSets.map((c) => `${c.name} [${c.itemCount}]`).join('; ')}` : '',
    s.inclusionRules.length ? `Inclusion rules: ${s.inclusionRules.join('; ')}` : '',
  ]
  const obs = (expr.PrimaryCriteria as Dict)?.ObservationWindow as Dict | undefined
  if (obs) parts.push(`Observation window: ${obs.PriorDays ?? 0}d prior / ${obs.PostDays ?? 0}d post`)
  const limit = ((expr.PrimaryCriteria as Dict)?.PrimaryCriteriaLimit as Dict)?.Type
  if (limit) parts.push(`Event limit: ${limit}`)
  return parts.filter(Boolean).join('. ')
}
