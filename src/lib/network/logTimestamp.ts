/**
 * RFC 3161 time-stamps over the disposition log (requirements R2, R6).
 *
 * Each log line's SHA-256 is the head of the chain at that point, so a token whose message imprint is that
 * hash shows that every entry up to it — including each 'received' entry, which names the pack by its
 * SHA-256 — existed by the TSA's time. That time is a trusted upper bound for when those packs were sealed.
 * The token is kept in the log itself, as a note after the entry it covers.
 */
import { b64url, b64urlDecode } from '@/lib/security/base64url'
import { verifyTimestamp, type TimestampCheck } from '@/lib/integrity/timestamp'
import type { DispositionLog, NewEntry } from './dispositionLog'

export const LOG_TIMESTAMP_FORMAT = 'rfc3161-log-head/1'

export interface LogTimestampDetails {
  format: typeof LOG_TIMESTAMP_FORMAT
  /** The entry whose line hash the token covers. */
  coversSeq: number
  coversHash: string
  /** The TSA reply (.tsr), base64url. */
  token: string
  genTime?: string
  tsa?: string
  tsaCertSha256?: string
}

export interface LogTimestamp {
  /** Sequence number of the note that carries the token. */
  seq: number
  coversSeq: number
  check: TimestampCheck
}

/** The note to append for a verified reply over the current head. */
export function logTimestampNote(log: DispositionLog, tsr: Uint8Array, check: TimestampCheck, actor: NewEntry['actor']): NewEntry {
  const coversSeq = log.size - 1
  const details: LogTimestampDetails = {
    format: LOG_TIMESTAMP_FORMAT,
    coversSeq,
    coversHash: log.headHash,
    token: b64url(tsr),
    genTime: check.genTime,
    tsa: check.tsa,
    tsaCertSha256: check.tsaCertSha256,
  }
  return { actor, action: 'note', reasonText: `RFC 3161 time-stamp over the log up to entry ${coversSeq} (${check.tsa ?? 'TSA'}, ${check.genTime})`, details: { timestamp: details } }
}

/** Every time-stamp note in the log, re-checked: the covered hash must be the log's own line hash. */
export async function verifyLogTimestamps(log: DispositionLog): Promise<LogTimestamp[]> {
  const out: LogTimestamp[] = []
  for (const e of log.entries) {
    const d = (e.details as { timestamp?: Partial<LogTimestampDetails> } | undefined)?.timestamp
    if (e.action !== 'note' || d?.format !== LOG_TIMESTAMP_FORMAT) continue
    const coversSeq = Number(d.coversSeq)
    const actual = Number.isInteger(coversSeq) && coversSeq < e.seq ? log.hashAt(coversSeq) : undefined
    let check: TimestampCheck
    if (!actual || actual !== d.coversHash) check = { valid: false, error: `The token does not cover entry ${d.coversSeq} of this log` }
    else {
      try {
        check = await verifyTimestamp(b64urlDecode(String(d.token)), actual)
      } catch {
        check = { valid: false, error: 'The token is not valid base64url' }
      }
    }
    out.push({ seq: e.seq, coversSeq, check })
  }
  return out
}

/**
 * The earliest verified time-stamp covering the first receipt of a pack: a trusted upper bound for its seal.
 */
export function receiptTimestamp(log: DispositionLog, stamps: readonly LogTimestamp[], packSha256: string): TimestampCheck | undefined {
  const received = log.entries.find((e) => e.action === 'received' && e.packSha256 === packSha256)
  if (!received) return undefined
  return stamps
    .filter((s) => s.check.valid && s.coversSeq >= received.seq)
    .map((s) => s.check)
    .sort((a, b) => Date.parse(a.genTime!) - Date.parse(b.genTime!))[0]
}
