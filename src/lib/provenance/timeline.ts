/**
 * Time evidence without a trusted clock (requirements R2).
 *
 * Offline, nothing can prove when a pack was sealed: the device clock is under the user's control and
 * signing the clock reading only proves what the signer claimed. What can be done is
 *   1. bound the seal between the protocol issue time and the coordinator's receipt time, and
 *   2. check that the times recorded by independent tools (CDM release, DQD, Strategus log, seal)
 *      are in a possible order. An impossible order reveals a wrong or altered clock.
 * Every time is labelled with its source so reports never overstate it.
 */
import type { SourcedTime } from '@/types/studypack'

export interface TimelineEvent {
  key: 'cdmRelease' | 'sourceRelease' | 'protocolIssued' | 'dqdStart' | 'dqdEnd' | 'logFirst' | 'logLast' | 'sealed' | 'received'
  label: string
  /** ISO-8601; date-only values are kept as dates. */
  at: string
  source: SourcedTime['source'] | 'site-tool'
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
  /** The only window the seal time can be trusted within. */
  trustedWindow?: { from?: string; to?: string }
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
  ['protocolIssued', 'sealed'],
  ['dqdEnd', 'sealed'],
]

// Times without a zone can be off by up to a day relative to UTC times.
const TOLERANCE_MS = 14 * 3600 * 1000

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
        const tol = a.zoneKnown && b.zoneKnown ? 0 : TOLERANCE_MS
        if (tb + tol < ta) {
          // A seal before the protocol existed, or a receipt before the seal, cannot happen with a correct clock.
          const hard = (chain[i] === 'protocolIssued' && chain[j] === 'sealed') || chain[j] === 'received'
          issues.push({ severity: hard && regulatory ? 'block' : 'warn', message: `${b.label} (${b.at}) is earlier than ${a.label} (${a.at})` })
        }
      }
    }
  }
  const from = byKey.get('protocolIssued')?.at
  const to = byKey.get('received')?.at
  return { events: sorted, issues, trustedWindow: from || to ? { from, to } : undefined }
}

export function event(key: TimelineEvent['key'], label: string, at: string | undefined, source: TimelineEvent['source']): TimelineEvent | undefined {
  return at ? { key, label, at, source, zoneKnown: zoned(at) } : undefined
}

/** Current time with the device's offset, labelled as a device-clock reading. */
export function deviceNow(now = new Date()): SourcedTime {
  return { utc: now.toISOString(), tzOffsetMinutes: -now.getTimezoneOffset(), source: 'device-clock' }
}
