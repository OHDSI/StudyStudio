/**
 * Execution log audit (requirements R5.1, R5.2).
 *
 * Strategus logs through ParallelLogger. The exact file name and layout depend on the Strategus
 * version, so parsing is tolerant: any line that starts with a date-time is a log entry, and the level
 * is the first ERROR/FATAL/WARN/INFO/DEBUG/TRACE token on the line.
 *
 * Logs can contain database hosts, schema owners, user names and home-directory paths. They are
 * redacted before packing; the pack carries the redacted copy plus a salted commitment to the original,
 * which stays at the site.
 */

export type LogLevel = 'FATAL' | 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE'

export interface LogMessage {
  line: number
  level: LogLevel
  text: string
}

export interface LogAudit {
  lines: number
  entries: number
  firstTimestamp?: string
  lastTimestamp?: string
  counts: Record<LogLevel, number>
  /** First errors (FATAL/ERROR), capped. */
  errors: LogMessage[]
  /** First warnings, capped. */
  warnings: LogMessage[]
  /** minCellCount values that appear in the log (e.g. from the execution settings). */
  minCellCounts: number[]
  /** Strategus modules the log mentions. */
  modulesMentioned: string[]
}

export interface Redaction {
  line: number
  kind: string
}

export interface RedactedLog {
  text: string
  redactions: Redaction[]
  /** Counts per kind, for the audit report. */
  summary: Record<string, number>
}

const TS = /^\s*\[?(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,]\d+)?\]?/
const LEVEL = /\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/
const CAP = 50

function normLevel(s: string): LogLevel {
  return (s === 'WARNING' ? 'WARN' : s) as LogLevel
}

export function auditLog(text: string): LogAudit {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const counts: Record<LogLevel, number> = { FATAL: 0, ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 }
  const errors: LogMessage[] = []
  const warnings: LogMessage[] = []
  const min = new Set<number>()
  const modules = new Set<string>()
  let entries = 0
  let first: string | undefined
  let last: string | undefined
  lines.forEach((l, i) => {
    const ts = TS.exec(l)
    if (ts) {
      entries++
      const t = `${ts[1]} ${ts[2]}`
      first ??= t
      last = t
    }
    for (const m of l.matchAll(/minCellCount\s*[=:]\s*(\d+)/gi)) min.add(Number(m[1]))
    for (const m of l.matchAll(/\b([A-Z][A-Za-z]+Module)\b/g)) modules.add(m[1])
    const lv = LEVEL.exec(l)
    if (!lv) return
    const level = normLevel(lv[1])
    counts[level]++
    const msg = { line: i + 1, level, text: l.trim().slice(0, 300) }
    if ((level === 'ERROR' || level === 'FATAL') && errors.length < CAP) errors.push(msg)
    if (level === 'WARN' && warnings.length < CAP) warnings.push(msg)
  })
  return {
    lines: lines.length,
    entries,
    firstTimestamp: first,
    lastTimestamp: last,
    counts,
    errors,
    warnings,
    minCellCounts: [...min].sort((a, b) => a - b),
    modulesMentioned: [...modules].sort(),
  }
}

/** [kind, pattern, replacement]. Replacements keep the key so the log stays interpretable. */
const RULES: [string, RegExp, string][] = [
  ['password', /\b(password|passwd|pwd)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[REDACTED]'],
  ['jdbc-url', /\bjdbc:[^\s"',)]+/gi, 'jdbc:[REDACTED]'],
  ['connection-string', /\b(server|host|hostname)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/gi, '$1$2[REDACTED]'],
  ['user', /\b(user|username|uid)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;)]+)/gi, '$1$2[REDACTED]'],
  ['home-path', /(\/(?:home|Users)\/)([^/\s"']+)/g, '$1[REDACTED]'],
  ['home-path', /([A-Za-z]:\\Users\\)([^\\\s"']+)/g, '$1[REDACTED]'],
  ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED-EMAIL]'],
  ['ip-address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED-IP]'],
]

export function redactLog(text: string): RedactedLog {
  const redactions: Redaction[] = []
  const summary: Record<string, number> = {}
  const out = text.split('\n').map((line, i) => {
    let l = line
    for (const [kind, re, rep] of RULES) {
      l = l.replace(re, (...m) => {
        redactions.push({ line: i + 1, kind })
        summary[kind] = (summary[kind] ?? 0) + 1
        // Re-run the single match through the replacement pattern.
        return m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), rep)
      })
    }
    return l
  })
  return { text: out.join('\n'), redactions, summary }
}
