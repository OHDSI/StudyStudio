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
      if (e.seq !== i) throw new DispositionError(`Entry ${i + 1}: sequence gap (found ${e.seq})`)
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
