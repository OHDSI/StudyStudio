/**
 * Everything the site seals and the coordinator re-checks beyond hashes and small cells:
 * data-quality gate (R4), CDM/vocabulary/software provenance (R3), execution log (R5.1) and the
 * time evidence (R2). One pure function so both sides evaluate a pack the same way.
 */
import { defaultDqdPolicy, evaluateDqdGate, studyTablesFor, type DqdGateResult } from '@/lib/audit/dqdAuditor'
import { auditLog, type LogAudit } from '@/lib/audit/logAuditor'
import { evaluateProvenance, type ProvenanceReport } from '@/lib/provenance/cdmSource'
import { buildTimeline, event, type Timeline, type TimelineEvent } from '@/lib/provenance/timeline'
import { parseAnalysisSpecification } from '@/lib/strategus/spec'
import { PROTOCOL_PATHS } from '@/lib/strategus/protocol'
import type { AssuranceLevel, DqdGatePolicy, StudyConfig } from '@/types/studypack'
import { SLOT_BY_ID } from './slots'

export interface SiteEvidence {
  assurance: AssuranceLevel
  dqdPolicy: DqdGatePolicy
  /** Where the policy came from: pinned by the protocol, or derived here from the analysis specification. */
  dqdPolicySource: 'protocol' | 'derived'
  dqdGate: DqdGateResult
  provenance: ProvenanceReport
  log?: LogAudit
  timeline: Timeline
}

const dec = new TextDecoder()

function parseJson(b?: Uint8Array): unknown {
  if (!b) return undefined
  try {
    return JSON.parse(dec.decode(b))
  } catch {
    return undefined
  }
}

/** The protocol's policy, or the default scoped to the tables the analysis specification's cohorts use. */
export function dqdPolicyFor(config: StudyConfig | undefined, specText?: string): { policy: DqdGatePolicy; source: 'protocol' | 'derived' } {
  if (config?.dataQuality) return { policy: config.dataQuality, source: 'protocol' }
  let tables: string[] = []
  if (specText) {
    try {
      const spec = parseAnalysisSpecification(specText)
      tables = studyTablesFor(spec.cohorts.map((c) => c.expression).filter(Boolean), spec.modules)
    } catch {
      /* unparseable spec: fall back to the base tables */
    }
  }
  const policy = defaultDqdPolicy(tables)
  return { policy: config?.assurance === 'regulatory' ? policy : { ...policy, requireDqd: false, requireCheckResults: false }, source: 'derived' }
}

export interface EvidenceInput {
  config?: StudyConfig
  /** Files keyed by StudyPack path. */
  files: Record<string, Uint8Array>
  /** Seal time (site) — omitted for a live preview. */
  sealedAt?: string
  /** Receipt time (coordinator). */
  receivedAt?: string
}

export function evaluateEvidence({ config, files, sealedAt, receivedAt }: EvidenceInput): SiteEvidence {
  const assurance: AssuranceLevel = config?.assurance ?? 'standard'
  const regulatory = assurance === 'regulatory'
  const spec = files[PROTOCOL_PATHS.analysisSpecifications]
  const { policy, source } = dqdPolicyFor(config, spec ? dec.decode(spec) : undefined)
  const dqdJson = parseJson(files[SLOT_BY_ID.dqdResults.path])
  const dqdGate = evaluateDqdGate(dqdJson, policy)
  const provenance = evaluateProvenance({ config, files, dqd: dqdGate.metadata })
  const logBytes = files[SLOT_BY_ID.executionLog.path]
  const log = logBytes ? auditLog(dec.decode(logBytes)) : undefined

  const events = [
    event('sourceRelease', 'Source data release', provenance.cdmSource?.sourceReleaseDate, 'site-tool'),
    event('cdmRelease', 'CDM release', provenance.cdmSource?.cdmReleaseDate, 'site-tool'),
    event('protocolIssued', 'Protocol issued', config?.issuedAt, 'coordinator-signed'),
    event('dqdStart', 'DQD started', dqdGate.metadata.startTimestamp, 'site-tool'),
    event('dqdEnd', 'DQD finished', dqdGate.metadata.endTimestamp, 'site-tool'),
    event('logFirst', 'Strategus log start', log?.firstTimestamp, 'site-tool'),
    event('logLast', 'Strategus log end', log?.lastTimestamp, 'site-tool'),
    event('sealed', 'StudyPack sealed', sealedAt, 'device-clock'),
    event('received', 'Received by coordinator', receivedAt, 'device-clock'),
  ].filter((e): e is TimelineEvent => !!e)

  return { assurance, dqdPolicy: policy, dqdPolicySource: source, dqdGate, provenance, log, timeline: buildTimeline(events, regulatory) }
}

export interface EvidenceVerdict {
  blockers: string[]
  warnings: string[]
}

/**
 * Turn evidence into blockers/warnings. In standard assurance nothing here blocks;
 * in regulatory assurance the requirement levels of docs/regulatory/requirements.md apply.
 */
export function judgeEvidence(e: SiteEvidence): EvidenceVerdict {
  const regulatory = e.assurance === 'regulatory'
  const blockers: string[] = []
  const warnings: string[] = []
  const put = (block: boolean, msg: string) => (block && regulatory ? blockers : warnings).push(msg)

  for (const f of e.dqdGate.findings.filter((x) => x.severity !== 'info')) {
    const what = f.check ? `${f.check.checkName}${f.check.cdmTableName ? ` on ${f.check.cdmTableName}${f.check.cdmFieldName ? `.${f.check.cdmFieldName}` : ''}` : ''}` : f.rationale
    put(f.severity === 'block', `Data quality (${f.ruleId}): ${what}`)
  }
  for (const i of e.provenance.issues) put(i.severity === 'block', `Provenance: ${i.message}`)
  // The log is required evidence only in regulatory studies; in standard studies it is optional, so no warning.
  if (!e.log) {
    if (regulatory) blockers.push('Strategus execution log is missing (logs/execution.log)')
  } else {
    const errs = e.log.counts.ERROR + e.log.counts.FATAL
    if (errs) warnings.push(`Strategus log contains ${errs} error line(s) — first at line ${e.log.errors[0]?.line}`)
  }
  for (const i of e.timeline.issues) put(i.severity === 'block', `Time: ${i.message}`)
  return { blockers, warnings }
}
