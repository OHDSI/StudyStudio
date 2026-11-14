/**
 * Coordinator's site-disposition audit trail (requirements R6).
 *
 * Append-only JSONL. Each entry carries the SHA-256 of the previous line, so a changed or removed
 * entry breaks the chain. The tool keeps no state, so the log lives in memory, is exported with every
 * submission package, and can be imported again (and verified) to continue in a later session.
 * Its head (last line hash + count) is what the coordinator signs and retains outside the tool.
 */
import { sha256Hex } from '@/lib/integrity/hasher'
import type { ReasonCode } from '@/types/studypack'

export type DispositionAction = 'received' | 'adopt' | 'exclude' | 'lock' | 'export' | 'note'

export interface Actor {
  name: string
  role: string
  organization: string
  /** Signing key ID when the actor unlocked a key in this session. */
  kid?: string
}

export interface DispositionEntry {
  seq: number
  prevHash: string
  /** ISO-8601 UTC from the coordinator's device clock. */
  at: string
  tzOffsetMinutes: number
  actor: Actor
  action: DispositionAction
  siteId?: string
  /** SHA-256 of the received StudyPack ZIP the entry refers to. */
  packSha256?: string
  /** Decision before → after (R6.2 old/new value). */
  from?: 'adopt' | 'exclude' | 'undecided'
  to?: 'adopt' | 'exclude'
  /** The automatic recommendation at the time of the decision. */
  recommended?: 'adopt' | 'exclude'
  reasonCode?: string
  reasonText?: string
  /** The decision departs from the automatic recommendation. */
  deviatesFromRecommendation?: boolean
  /** Free-form facts recorded with the entry (e.g. verification summary, exported file hashes). */
  details?: Record<string, unknown>
}

export const GENESIS = '0'.repeat(64)

/** Default pre-specified reasons (protocols may replace them). Codes follow ICH M14 §4.2 / E6 §3.16.2(d) categories. */
export const DEFAULT_REASON_CODES: ReasonCode[] = [
  { code: 'INTEGRITY', label: 'Pack integrity failure (hash mismatch, invalid manifest, invalid signature)' },
  { code: 'PROTOCOL_DEVIATION', label: 'Protocol deviation (analysis specification, protected code or renv.lock differs)' },
  { code: 'PRIVACY', label: 'Privacy violation (small cells or identifiers in results)' },
  { code: 'DATA_QUALITY', label: 'Data quality below the pre-specified gate' },
  { code: 'CDM_REQUIREMENT', label: 'CDM / vocabulary version does not meet the protocol' },
  { code: 'DUPLICATE', label: 'Duplicate submission for the same site (superseded)' },
  { code: 'WITHDRAWN', label: 'Site withdrew from the study' },
  { code: 'OTHER', label: 'Other (justification required)', requiresText: true },
]

export class DispositionError extends Error {}

const ACTIONS: readonly string[] = ['received', 'adopt', 'exclude', 'lock', 'export', 'note'] satisfies DispositionAction[]
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const HEX64 = /^[a-f0-9]{64}$/i

/**
 * Field-level check of an imported entry. The hash chain proves the lines were not changed after they
 * were written, not who wrote them: anyone can build a valid chain, so the values are checked too
 * before they reach the reports.
 */
function entryProblem(e: unknown): string | undefined {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'not an object'
  const o = e as Record<string, unknown>
  const optString = (k: string) => o[k] === undefined || typeof o[k] === 'string'
  const optOneOf = (k: string, values: readonly string[]) => o[k] === undefined || values.includes(o[k] as string)
  if (typeof o.prevHash !== 'string' || !HEX64.test(o.prevHash)) return 'prevHash is invalid'
  if (typeof o.at !== 'string' || !ISO_UTC.test(o.at) || Number.isNaN(Date.parse(o.at))) return 'at is not an ISO-8601 UTC time'
  if (!Number.isInteger(o.tzOffsetMinutes)) return 'tzOffsetMinutes is invalid'
  const a = o.actor as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || typeof a.role !== 'string' || typeof a.organization !== 'string' || (a.kid !== undefined && typeof a.kid !== 'string'))
    return 'actor is invalid'
  if (!ACTIONS.includes(o.action as string)) return 'action is invalid'
  if (o.packSha256 !== undefined && (typeof o.packSha256 !== 'string' || !HEX64.test(o.packSha256))) return 'packSha256 is invalid'
  if (!optOneOf('from', ['adopt', 'exclude', 'undecided']) || !optOneOf('to', ['adopt', 'exclude']) || !optOneOf('recommended', ['adopt', 'exclude'])) return 'decision values are invalid'
  if (!optString('siteId') || !optString('reasonCode') || !optString('reasonText')) return 'text fields are invalid'
  if (o.deviatesFromRecommendation !== undefined && typeof o.deviatesFromRecommendation !== 'boolean') return 'deviatesFromRecommendation is invalid'
  if (o.details !== undefined && (!o.details || typeof o.details !== 'object' || Array.isArray(o.details))) return 'details is invalid'
  return undefined
}

export type NewEntry = Omit<DispositionEntry, 'seq' | 'prevHash' | 'at' | 'tzOffsetMinutes'>

const enc = new TextEncoder()

export class DispositionLog {
  private lines: string[] = []
  private head = GENESIS
  private cache: DispositionEntry[] = []

  get entries(): readonly DispositionEntry[] {
    return this.cache
  }
  get headHash(): string {
    return this.head
  }
  get size(): number {
    return this.lines.length
  }
  get locked(): boolean {
    return this.cache.some((e) => e.action === 'lock')
  }

  /** Current decision per pack (undefined = no decision yet). */
  decisions(): Map<string, 'adopt' | 'exclude'> {
    const m = new Map<string, 'adopt' | 'exclude'>()
    for (const e of this.cache) if ((e.action === 'adopt' || e.action === 'exclude') && e.packSha256) m.set(e.packSha256, e.action)
    return m
  }

  async append(e: NewEntry, reasonCodes: readonly ReasonCode[] = DEFAULT_REASON_CODES, now = new Date()): Promise<DispositionEntry> {
    if (!e.actor?.name?.trim()) throw new DispositionError('The person making the entry must be identified')
    const decision = e.action === 'adopt' || e.action === 'exclude'
    if (decision && this.locked) throw new DispositionError('Dispositions are locked; record a note explaining any later change instead')
    if (decision && !e.packSha256) throw new DispositionError('A decision must name the pack it applies to')
    const needsReason = e.action === 'exclude' || (decision && e.deviatesFromRecommendation)
    if (needsReason && !e.reasonCode) throw new DispositionError('Exclusions and decisions against the recommendation need a pre-specified reason code')
    const code = e.reasonCode ? reasonCodes.find((r) => r.code === e.reasonCode) : undefined
    if (e.reasonCode && !code) throw new DispositionError(`Reason code ${e.reasonCode} is not pre-specified in the protocol`)
    if ((code?.requiresText || (decision && e.deviatesFromRecommendation)) && !e.reasonText?.trim())
      throw new DispositionError('A written justification is required for this decision')
    const entry: DispositionEntry = {
      seq: this.lines.length,
      prevHash: this.head,
      at: now.toISOString(),
      tzOffsetMinutes: -now.getTimezoneOffset(),
      ...e,
    }
    const line = JSON.stringify(entry)
    this.lines.push(line)
    this.cache = [...this.cache, entry]
    this.head = await sha256Hex(enc.encode(line))
    return entry
  }

  toJsonl(): string {
    return this.lines.length ? this.lines.join('\n') + '\n' : ''
  }

  /** The bytes a coordinator signs: binds the log's content (head hash) and length. */
  headBytes(studyId: string): Uint8Array {
    return enc.encode(JSON.stringify({ format: 'studypack-disposition-head/1', studyId, entries: this.lines.length, headHash: this.head }) + '\n')
  }

  /** Verify an exported log and restore it. Throws on any break in the chain. */
  static async fromJsonl(text: string, expected?: { headHash: string; entries: number }): Promise<DispositionLog> {
    const log = new DispositionLog()
    let prev = GENESIS
    const lines = text.split('\n').filter((l) => l.trim())
    const entries: DispositionEntry[] = []
    for (const [i, line] of lines.entries()) {
      let e: DispositionEntry
      try {
        e = JSON.parse(line)
      } catch {
        throw new DispositionError(`Entry ${i + 1} is not valid JSON`)
      }
      if (e?.seq !== i) throw new DispositionError(`Entry ${i + 1}: sequence gap (found ${String(e?.seq).slice(0, 20)})`)
      const problem = entryProblem(e)
      if (problem) throw new DispositionError(`Entry ${i + 1}: ${problem}`)
      if (e.prevHash !== prev) throw new DispositionError(`Entry ${i + 1}: the chain is broken (an earlier entry was changed or removed)`)
      prev = await sha256Hex(enc.encode(line))
      entries.push(e)
    }
    if (expected && (expected.headHash !== prev || expected.entries !== lines.length))
      throw new DispositionError('The log does not match its signed head (truncated or replaced)')
    log.lines = lines
    log.head = prev
    log.cache = entries
    return log
  }
}
