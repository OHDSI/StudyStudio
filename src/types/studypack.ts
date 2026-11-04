/** Shared domain types for the StudyPack convention. */

export type RoleMode = 'site' | 'admin'

export type FileRole = 'etl' | 'evidence' | 'definition' | 'code' | 'result' | 'metadata'

export const PACK_VERSION = '1.0.0' as const

export interface ManifestFileEntry {
  path: string
  sha256: string
  sizeBytes: number
  role: FileRole
}

/** manifest.json — see requirements §6. */
export interface StudyPackManifest {
  packVersion: typeof PACK_VERSION
  studyId: string
  siteId: string
  roleMode: RoleMode
  generatedAt: string
  cdmVersion: string
  files: ManifestFileEntry[]
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
}
