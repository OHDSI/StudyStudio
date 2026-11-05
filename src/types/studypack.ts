/** Shared domain types for the StudyPack convention. */

export type RoleMode = 'site' | 'admin'

export type FileRole = 'etl' | 'evidence' | 'definition' | 'code' | 'result' | 'metadata'

export const PACK_VERSION = '1.0.0' as const

/** `standard`: everything optional, warnings only. `regulatory`: docs/regulatory/requirements.md rules block. */
export type AssuranceLevel = 'standard' | 'regulatory'

export interface ManifestFileEntry {
  path: string
  sha256: string
  sizeBytes: number
  role: FileRole
  /** Salted commitment to the file before it was masked/redacted (R5.3). The salt stays at the site. */
  originalCommitment?: string
}

/** A time together with where it came from (R2). */
export interface SourcedTime {
  /** ISO-8601 UTC. */
  utc: string
  /** Local offset from UTC in minutes at the time of recording (e.g. +540 for JST). */
  tzOffsetMinutes?: number
  source: 'coordinator-signed' | 'device-clock' | 'derived'
}

/** manifest.json */
export interface StudyPackManifest {
  packVersion: typeof PACK_VERSION
  studyId: string
  siteId: string
  roleMode: RoleMode
  generatedAt: string
  cdmVersion: string
  files: ManifestFileEntry[]
  assurance?: AssuranceLevel
  tool?: { name: string; version: string; buildId?: string }
  sealedAt?: SourcedTime
}

export interface CohortRef {
  cohortId: number
  cohortName: string
  /** e.g. ['target (CM)', 'exposure (SCCS)'] — derived from the Strategus analysis specification. */
  roles: string[]
}

/** A file section that must be identical across sites (the rest of the file is site-editable). */
export interface ProtectedSection {
  /** Line marker; everything after the line containing it is hashed. */
  marker: string
  sha256: string
}

/**
 * study_config.json — the protocol the coordinator issues and every site imports.
 * The analysis itself is defined by a Strategus analysis specification; this file pins it.
 */
export interface StudyConfig {
  configVersion: '1.0.0'
  studyId: string
  studyTitle: string
  description?: string
  principalInvestigator?: string
  sponsor?: string
  cdmVersion: string
  issuedAt: string
  /** Minimum reportable cell count. Values in 1..(minCellCount-1) are violations. */
  minCellCount: number
  framework: { name: 'Strategus'; modules: string[] }
  cohorts: CohortRef[]
  /** Expected SHA-256 of whole files, keyed by StudyPack path. */
  expectedHashes: Record<string, string>
  /** Expected SHA-256 of protected sections, keyed by StudyPack path (e.g. code/ExecuteAnalyses.R). */
  protectedSections: Record<string, ProtectedSection>
  /** Optional additional column-name regexes (strings) that hold counts, for tables without a results data model. */
  countColumnPatterns?: string[]
  // Regulatory controls (all optional; absent = standard assurance).
  assurance?: AssuranceLevel
  /** Pre-specified data-quality gate (R4.2). */
  dataQuality?: DqdGatePolicy
  /** Required CDM / vocabulary versions; exact match when given (R3.1). */
  cdmRequirements?: { cdmVersion?: string; vocabularyVersion?: string }
  /** Pre-specified reasons a site may be excluded (R6.1). */
  adoptionPolicy?: { reasonCodes: ReasonCode[] }
}

export type GateSeverity = 'block' | 'warn' | 'info'

export interface DqdRule {
  id: string
  severity: GateSeverity
  match: { checkName?: string[]; category?: string[]; studyTablesOnly?: boolean }
  rationale: string
}

export interface DqdGatePolicy {
  policyVersion: string
  /** DQD results must be present. */
  requireDqd: boolean
  /** Per-check results (CheckResults) must be present; an Overview alone cannot be scoped to study tables. */
  requireCheckResults: boolean
  /** Upper-case CDM tables used by the study (derived from the cohort definitions). */
  studyTables: string[]
  /** Severity when a check errored (did not run) on a study table. */
  errorSeverity: GateSeverity
  rules: DqdRule[]
  /** Severity of failures no rule matches. */
  defaultFailedSeverity: GateSeverity
}

export interface ReasonCode {
  code: string
  label: string
  /** Free-text justification required in addition to the code. */
  requiresText?: boolean
}
