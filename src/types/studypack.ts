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

export type FrameworkName = 'Strategus' | 'R script'

/** A study run by a single R script rather than Strategus (absent framework = Strategus). */
export const isRScriptStudy = (config?: { framework?: { name?: string } }) => config?.framework?.name === 'R script'

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
  /**
   * `Strategus`: an analysis specification run by Strategus::execute().
   * `R script`: a single R script (e.g. CodeToRun.R) that writes aggregated CSVs; standard assurance only.
   */
  framework: { name: FrameworkName; modules: string[] }
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
  /**
   * Participating sites and their data sources, pre-specified at issue (assessment C2). Required for regulatory
   * protocols; optional otherwise. Each pack is compared with its entry, and in a regulatory study every listed site
   * needs a decision or a `not-received` entry before the dispositions can be locked (A1).
   */
  sites?: ExpectedSite[]
  /** The issue this protocol replaces (assessment P1); covered by the coordinator signature like every other field. */
  amends?: ProtocolAmendment
  /** Plan documents (protocol, statistical analysis plan, …) shipped under docs/ and pinned by SHA-256 (P2). Never parsed. */
  documents?: ProtocolDocument[]
  /** Registration in a public registry, as declared by the coordinator; not verified by the tool (P3). */
  registration?: StudyRegistration
}

export interface ProtocolAmendment {
  /** SHA-256 of the previous study_config.json bytes. */
  previousSha256: string
  previousIssuedAt: string
  summary: string
}

export interface ProtocolDocument {
  /** Path inside the protocol ZIP and the StudyPack, under docs/. */
  path: string
  sha256: string
  title: string
}

export interface StudyRegistration {
  registry: string
  id: string
  registeredAt?: string
}

/** Wording shown next to a declared registration wherever it is displayed (P3). */
export const REGISTRATION_LABEL = 'as declared by the coordinator; not verified by the tool'

/** Whole-file pinned hashes: expectedHashes plus the plan documents (P2), keyed by StudyPack path. */
export function pinnedFileHashes(config?: Pick<StudyConfig, 'expectedHashes' | 'documents'>): Record<string, string> {
  return { ...(config?.expectedHashes ?? {}), ...Object.fromEntries((config?.documents ?? []).map((d) => [d.path, d.sha256])) }
}

export interface ExpectedSite {
  siteId: string
  /** Free text, e.g. "treated" or "external-comparator". */
  role?: string
  /** Expected cdm_source.cdm_source_name. */
  cdmSourceName?: string
  /** Expected cdm_source.source_release_date (YYYY-MM-DD). */
  sourceReleaseDate?: string
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
