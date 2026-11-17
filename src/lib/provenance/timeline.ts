/**
 * Time evidence without a trusted clock (requirements R2).
 *
 * Offline, nothing can prove when a pack was sealed: the device clock is under the user's control and
 * signing the clock reading only proves what the signer claimed. What can be done is
 *   1. bound the seal between the protocol issue time and the coordinator's receipt time — on a
 *      time-stamp authority's clock when the coordinator obtained RFC 3161 tokens for both (see
 *      integrity/timestamp.ts), otherwise on the coordinator's device clock — and
 *   2. check that the times recorded by independent tools (CDM release, DQD, Strategus log, seal)
 *      are in a possible order. An impossible order reveals a wrong or altered clock.
 * Every time is labelled with its source so reports never overstate it.
 */
import type { SourcedTime } from '@/types/studypack'

export interface TimelineEvent {
  key: 'cdmRelease' | 'sourceRelease' | 'protocolIssued' | 'protocolTimestamped' | 'dqdStart' | 'dqdEnd' | 'logFirst' | 'logLast' | 'runStart' | 'runEnd' | 'sealed' | 'received' | 'receiptTimestamped'
  label: string
  /** ISO-8601; date-only values are kept as dates. */
  at: string
  /** 'tsa': an RFC 3161 time-stamp authority's time, from a token whose signature was verified. */
  source: SourcedTime['source'] | 'site-tool' | 'tsa'
  /** Times written by R/DQD without a zone are local site times. */
  zoneKnown: boolean
}

export interface TimelineIssue {
  severity: 'block' | 'warn'
  message: string
}

export interface Timeline {
  events: TimelineEvent[]
  issues: TimelineIssue[]
  /** The only window the seal time can be trusted within, and whose clock each bound is on. */
  trustedWindow?: { from?: string; to?: string; fromSource?: TimelineEvent['source']; toSource?: TimelineEvent['source'] }
}

/** Parse "2026-10-28 09:12:03", "2026-10-28T09:12:03Z", "2026-10-28" or "20261028". */
export function parseTime(s?: string): number | undefined {
  if (!s) return undefined
  const t = s.trim()
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(t)
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : t.replace(' ', 'T')
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

const zoned = (s: string) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(s.trim())

/** Expected order. A later event earlier than a previous one is an inconsistency. */
const ORDER: TimelineEvent['key'][][] = [
  ['sourceRelease', 'cdmRelease', 'dqdStart', 'dqdEnd'],
  ['cdmRelease', 'logFirst', 'logLast', 'sealed', 'received'],
  ['protocolIssued', 'logFirst'],
  ['cdmRelease', 'runStart', 'runEnd', 'sealed', 'received'],
  ['protocolIssued', 'runStart'],
  ['protocolIssued', 'sealed'],
  ['dqdEnd', 'sealed'],
  // The pack contains the protocol's token, so it was sealed after the token's time.
  ['protocolIssued', 'protocolTimestamped'],
  ['protocolTimestamped', 'sealed'],
  ['protocolTimestamped', 'runStart'],
  // The receipt token covers the log entry that recorded the receipt.
  ['sealed', 'receiptTimestamped'],
  ['received', 'receiptTimestamped'],
]

// Times without a zone can be off by up to a day relative to UTC times.
const TOLERANCE_MS = 14 * 3600 * 1000
// A device clock compared with a time-stamp authority's clock: allow for ordinary drift.
const TSA_TOLERANCE_MS = 5 * 60 * 1000

export function buildTimeline(events: TimelineEvent[], regulatory = false): Timeline {
  const sorted = events.filter((e) => parseTime(e.at) !== undefined).sort((a, b) => parseTime(a.at)! - parseTime(b.at)!)
  const byKey = new Map(events.map((e) => [e.key, e]))
  const issues: TimelineIssue[] = []
  for (const chain of ORDER) {
    for (let i = 0; i < chain.length; i++) {
      for (let j = i + 1; j < chain.length; j++) {
        const a = byKey.get(chain[i])
        const b = byKey.get(chain[j])
        if (!a || !b) continue
        const ta = parseTime(a.at)!
        const tb = parseTime(b.at)!
        const tsa = a.source === 'tsa' || b.source === 'tsa'
        const tol = !(a.zoneKnown && b.zoneKnown) ? TOLERANCE_MS : tsa && a.source !== b.source ? TSA_TOLERANCE_MS : 0
        if (tb + tol < ta) {
          // A seal before the protocol existed, or a receipt before the seal, cannot happen with a correct clock.
          const hard =
            (chain[i] === 'protocolIssued' && chain[j] === 'sealed') ||
            (chain[i] === 'protocolTimestamped' && chain[j] === 'sealed') ||
            chain[j] === 'received' ||
            // The coordinator's own clock running ahead of the TSA is not the site's problem.
            (chain[j] === 'receiptTimestamped' && chain[i] !== 'received')
          issues.push({ severity: hard && regulatory ? 'block' : 'warn', message: `${b.label} (${b.at}) is earlier than ${a.label} (${a.at})` })
        }
      }
    }
  }
  // A time-stamp authority's time replaces the coordinator's device clock for either bound.
  const fromEvent = byKey.get('protocolTimestamped') ?? byKey.get('protocolIssued')
  const toEvent = byKey.get('receiptTimestamped') ?? byKey.get('received')
  return {
    events: sorted,
    issues,
    trustedWindow: fromEvent || toEvent ? { from: fromEvent?.at, to: toEvent?.at, fromSource: fromEvent?.source, toSource: toEvent?.source } : undefined,
  }
}

export function event(key: TimelineEvent['key'], label: string, at: string | undefined, source: TimelineEvent['source']): TimelineEvent | undefined {
  return at ? { key, label, at, source, zoneKnown: zoned(at) } : undefined
}

/** Current time with the device's offset, labelled as a device-clock reading. */
export function deviceNow(now = new Date()): SourcedTime {
  return { utc: now.toISOString(), tzOffsetMinutes: -now.getTimezoneOffset(), source: 'device-clock' }
}
