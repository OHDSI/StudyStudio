/** Site-mode guardrail: decides whether "Download StudyPack" may be enabled. */
import type { AuditResult } from '@/lib/audit/cellAuditor'
import { hashesEqual } from '@/lib/integrity/hasher'
import type { StudyConfig } from '@/types/studypack'
import { SLOTS, type SlotId } from './slots'

export interface SlotSnapshot {
  name: string
  sha256: string
  /** SHA-256 of the protected section, when the protocol pins one for this file. */
  protectedSha256?: string
  audit?: AuditResult
  error?: string
}

export interface Readiness {
  canPackage: boolean
  blockers: string[]
  warnings: string[]
  privacyViolations: number
}

export interface ReadinessInput {
  siteId: string
  config?: StudyConfig
  slots: Partial<Record<SlotId, SlotSnapshot>>
  /** Strategus result CSVs keyed by path relative to the results root. */
  results: Record<string, SlotSnapshot>
  /** minCellCount the site actually exported with (executionSettings.json or ExecuteAnalyses.R inputs). */
  exportedMinCellCount?: number
}

export function evaluateReadiness(p: ReadinessInput): Readiness {
  const blockers: string[] = []
  const warnings: string[] = []
  if (!p.config) blockers.push('No protocol (study_config.json) loaded')
  if (!p.siteId.trim()) blockers.push('Site ID is empty')
  let privacyViolations = 0

  const checkAudit = (path: string, s: SlotSnapshot) => {
    if (!s.audit) return blockers.push(`${path}: audit not completed`)
    if (!s.audit.passed) {
      privacyViolations += s.audit.findings.length
      blockers.push(`${path}: export violation — ${s.audit.smallCellCount} small cell(s) / ${s.audit.identifierCount} direct identifier column(s)`)
    }
  }

  for (const slot of SLOTS) {
    const s = p.slots[slot.id]
    if (!s) {
      if (slot.required) blockers.push(`Required file ${slot.path} is missing`)
      continue
    }
    if (s.error) blockers.push(`${slot.path}: ${s.error}`)
    if (slot.audited) checkAudit(slot.path, s)
    const expected = p.config?.expectedHashes?.[slot.path]
    if (expected && !hashesEqual(expected, s.sha256)) warnings.push(`${slot.path} does not match the protocol hash (the coordinator may exclude this site)`)
    const section = p.config?.protectedSections?.[slot.path]
    if (section) {
      if (!s.protectedSha256) warnings.push(`${slot.path}: the "${section.marker}" marker is missing, so the protected section cannot be verified`)
      else if (!hashesEqual(section.sha256, s.protectedSha256)) warnings.push(`${slot.path}: code below "${section.marker}" differs from the protocol (the coordinator may exclude this site)`)
    }
  }

  const results = Object.entries(p.results)
  if (results.length === 0) blockers.push('Strategus results are not loaded (drop the results ZIP or folder)')
  for (const [path, s] of results) {
    if (s.error) blockers.push(`results/${path}: ${s.error}`)
    else checkAudit(`results/${path}`, s)
  }

  const min = p.config?.minCellCount
  if (min !== undefined && p.exportedMinCellCount !== undefined && p.exportedMinCellCount < min)
    warnings.push(`Results were exported with minCellCount ${p.exportedMinCellCount}, below the protocol's ${min}. Small cells must be masked before packaging.`)

  return { canPackage: blockers.length === 0, blockers, warnings, privacyViolations }
}
