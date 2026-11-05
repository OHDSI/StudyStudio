import type { FileRole } from '@/types/studypack'

export type SlotId =
  | 'scanReport'
  | 'mappingSpec'
  | 'vocabularyVersion'
  | 'dqdResults'
  | 'analysisSpecifications'
  | 'executeAnalyses'
  | 'renvLock'
  | 'executionSettings'
  | 'executionLog'

export interface SlotDef {
  id: SlotId
  /** Path inside the StudyPack. */
  path: string
  role: FileRole
  label: string
  description: string
  accept: string[]
  required: boolean
  /** Whether the file is subject to the zero-PHI / small-cell audit. */
  audited: boolean
  /** Distributed by the coordinator in the protocol ZIP (never produced at the site). */
  fromProtocol: boolean
}

export const SLOTS: SlotDef[] = [
  { id: 'scanReport', path: 'etl/ScanReport_sanitized.xlsx', role: 'etl', label: 'ScanReport_sanitized.xlsx', description: 'WhiteRabbit source data profile (sanitized)', accept: ['.xlsx', '.xls'], required: false, audited: true, fromProtocol: false },
  { id: 'mappingSpec', path: 'etl/mapping_specification.json', role: 'etl', label: 'mapping_specification.json', description: 'Rabbit-In-A-Hat mapping specification', accept: ['.json'], required: false, audited: false, fromProtocol: false },
  { id: 'vocabularyVersion', path: 'etl/vocabulary_version.json', role: 'etl', label: 'vocabulary_version.json', description: 'Pinned OMOP vocabulary version', accept: ['.json'], required: false, audited: false, fromProtocol: false },
  { id: 'dqdResults', path: 'evidence/dqd_results.json', role: 'evidence', label: 'dqd_results.json', description: 'Data Quality Dashboard run summary', accept: ['.json'], required: true, audited: false, fromProtocol: false },
  { id: 'analysisSpecifications', path: 'definitions/analysisSpecifications.json', role: 'definition', label: 'analysisSpecifications.json', description: 'Strategus analysis specification', accept: ['.json'], required: true, audited: false, fromProtocol: true },
  { id: 'executeAnalyses', path: 'code/ExecuteAnalyses.R', role: 'code', label: 'ExecuteAnalyses.R', description: 'Strategus execution script (if it has the template marker, only the INPUTS block above it may be edited)', accept: ['.R', '.r'], required: true, audited: false, fromProtocol: true },
  { id: 'renvLock', path: 'code/renv.lock', role: 'code', label: 'renv.lock', description: 'Pinned R package dependencies', accept: ['.lock', '.json'], required: true, audited: false, fromProtocol: true },
  { id: 'executionSettings', path: 'code/executionSettings.json', role: 'code', label: 'executionSettings.json', description: 'Execution settings written by ExecuteAnalyses.R (records minCellCount)', accept: ['.json'], required: false, audited: false, fromProtocol: false },
  { id: 'executionLog', path: 'logs/execution.log', role: 'evidence', label: 'Strategus log', description: 'Strategus / ParallelLogger execution log. Credentials, hosts and user names are redacted; the original stays at the site (required for regulatory studies)', accept: ['.log', '.txt'], required: false, audited: false, fromProtocol: false },
]

export const SLOT_BY_ID: Record<SlotId, SlotDef> = Object.fromEntries(SLOTS.map((s) => [s.id, s])) as Record<SlotId, SlotDef>
export const SLOT_BY_PATH: Record<string, SlotDef> = Object.fromEntries(SLOTS.map((s) => [s.path, s]))

/** Strategus result CSVs live under results/<ModuleName>/<table>.csv inside the pack. */
export const RESULTS_DIR = 'results'

export const GENERATED_PATHS = {
  manifest: 'manifest.json',
  roCrate: 'ro-crate-metadata.json',
  auditReport: 'audit_report.json',
  /** Detached JWS over manifest.json. Not listed in the manifest it signs. */
  manifestSignature: 'manifest.jws.json',
  /** The protocol exactly as the site received it, and the coordinator's signature over it. */
  protocol: 'protocol/study_config.json',
  protocolSignature: 'protocol/study_config.jws.json',
} as const

/** Guess the slot for a dropped file by its name (used for bulk drop). */
export function guessSlot(fileName: string): SlotId | undefined {
  const n = fileName.split('/').pop()!.toLowerCase()
  if (n.endsWith('.xlsx') || n.endsWith('.xls')) return 'scanReport'
  if (n === 'executeanalyses.r' || n === 'codetorun.r') return 'executeAnalyses'
  if (n === 'renv.lock') return 'renvLock'
  if (n === 'executionsettings.json') return 'executionSettings'
  if (n.includes('analysisspecification')) return 'analysisSpecifications'
  if (n.includes('mapping')) return 'mappingSpec'
  if (n.includes('vocab')) return 'vocabularyVersion'
  if (n.includes('dqd') || n.includes('quality')) return 'dqdResults'
  if (n.endsWith('.log') || (n.endsWith('.txt') && n.includes('log'))) return 'executionLog'
  return undefined
}

/** Slots produced at the site (as opposed to protocol-distributed specification and code). */
export const SITE_PRODUCED_SLOTS: SlotId[] = SLOTS.filter((s) => !s.fromProtocol).map((s) => s.id)

export interface BulkIngestPlan {
  assign: { name: string; slotId: SlotId }[]
  /** Files whose slot already holds the protocol-distributed artifact (never overwritten by bulk drop). */
  protectedByProtocol: { name: string; slotId: SlotId }[]
  /** ZIP archives — treated as a Strategus results archive. */
  resultsArchives: string[]
  unknown: string[]
}

/**
 * Decide where each bulk-dropped file goes. Protocol-distributed artifacts loaded from the protocol
 * ZIP are never replaced this way, so a stray local copy cannot silently diverge from the protocol hash.
 */
export function planBulkIngest(fileNames: string[], protocolFilled: ReadonlySet<SlotId>): BulkIngestPlan {
  const plan: BulkIngestPlan = { assign: [], protectedByProtocol: [], resultsArchives: [], unknown: [] }
  for (const name of fileNames) {
    if (/\.zip$/i.test(name)) {
      plan.resultsArchives.push(name)
      continue
    }
    const slotId = guessSlot(name)
    if (!slotId) plan.unknown.push(name)
    else if (protocolFilled.has(slotId)) plan.protectedByProtocol.push({ name, slotId })
    else plan.assign.push({ name, slotId })
  }
  return plan
}
