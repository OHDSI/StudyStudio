/**
 * SAS Version 5 transport files (XPT), the dataset format most regulatory agencies expect, written and
 * read without SAS. Layout per SAS Technical Support TS-140: 80-byte header records, one 140-byte NAMESTR
 * per variable, then the observations; numbers are IBM System/370 doubles, text is fixed-width and
 * blank-padded.
 *
 * Version 5 limits: dataset and variable names of 8 characters, labels of 40, text values of 200 bytes.
 * Names come from define.xml (SASDatasetName / SASFieldName), so they always fit; a text value over 200
 * bytes cannot be written and the table must be left out (xptLimitIssues lists them). Text is written as
 * UTF-8; a byte length is what Length means for XPT.
 */
import type { CombinedTable } from './datasetJson'

export const XPT_MAX_TEXT = 200
const NAME = 8
const LABEL = 40

const enc = new TextEncoder()
const dec = new TextDecoder()

export const byteLength = (s: string) => enc.encode(s).byteLength

/** Text values longer than XPT allows, as "<column>: <bytes> bytes" (empty when the table can be written). */
export function xptLimitIssues(table: CombinedTable): string[] {
  return table.columns.flatMap((c, i) => {
    if (c.dataType !== 'string') return []
    const longest = Math.max(0, ...table.rows.map((r) => (typeof r[i] === 'string' ? byteLength(r[i] as string) : 0)))
    return longest > XPT_MAX_TEXT ? [`${c.name}: ${longest} bytes`] : []
  })
}

/** Byte length of the longest text value (at least 1), the XPT and define.xml Length of a text column. */
export function textLength(table: CombinedTable, column: number): number {
  return Math.max(1, ...table.rows.map((r) => (typeof r[column] === 'string' ? byteLength(r[column] as string) : 0)))
}

/** IEEE 754 double → IBM System/370 double (8 bytes, big-endian). SAS missing "." for null / non-finite. */
export function ibmDouble(x: number | null): Uint8Array {
  const out = new Uint8Array(8)
  if (x === null || !Number.isFinite(x)) {
    out[0] = 0x2e
    return out
  }
  if (x === 0) return out
  const v = new DataView(new ArrayBuffer(8))
  v.setFloat64(0, x)
  const bits = v.getBigUint64(0)
  const sign = Number(bits >> 63n)
  const exp = Number((bits >> 52n) & 0x7ffn)
  if (exp === 0) return out // subnormal: below the IBM range
  const m = (bits & 0xfffffffffffffn) | (1n << 52n) // 53-bit mantissa, x = m · 2^p
  const p = exp - 1075
  // x = M · 16^(c - 64) / 2^56 with M in [2^52, 2^56): M = m · 2^s, 4c = p + 312 - s.
  const s = (((p + 312) % 4) + 4) % 4
  const c = (p + 312 - s) / 4
  if (c > 127) throw new Error(`${x} is too large for an XPT number`)
  if (c < 0) return out
  const M = m << BigInt(s)
  out[0] = (sign << 7) | c
  for (let i = 7; i >= 1; i--) out[i] = Number((M >> BigInt(8 * (7 - i))) & 0xffn)
  return out
}

/** IBM System/370 double → number; null for SAS missing values. */
export function fromIbmDouble(b: Uint8Array): number | null {
  const rest = b.subarray(1).every((x) => x === 0)
  if (rest && (b[0] === 0x2e || b[0] === 0x5f || (b[0] >= 0x41 && b[0] <= 0x5a))) return null
  if (rest && (b[0] & 0x7f) === 0) return 0
  let M = 0n
  for (let i = 1; i < 8; i++) M = (M << 8n) | BigInt(b[i])
  const c = b[0] & 0x7f
  const value = Number(M) * 2 ** (4 * (c - 64) - 56)
  return b[0] & 0x80 ? -value : value
}

const pad = (s: string, n: number) => {
  const b = enc.encode(s)
  if (b.byteLength > n) throw new Error(`"${s}" is longer than ${n} bytes`)
  const out = new Uint8Array(n).fill(0x20)
  out.set(b)
  return out
}
/** Cut to at most n bytes without splitting a UTF-8 character. */
const cut = (s: string, n: number) => {
  let out = ''
  for (const ch of s) {
    if (byteLength(out + ch) > n) break
    out += ch
  }
  return out
}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const sasDate = (d: Date) => {
  const t = (n: number) => String(n).padStart(2, '0')
  return `${t(d.getUTCDate())}${MONTHS[d.getUTCMonth()]}${t(d.getUTCFullYear() % 100)}:${t(d.getUTCHours())}:${t(d.getUTCMinutes())}:${t(d.getUTCSeconds())}`
}
const header = (kind: string, tail: string) => `HEADER RECORD*******${kind.padEnd(8)}HEADER RECORD!!!!!!!${tail}  `

export interface XptOptions {
  /** SASDatasetName (≤ 8 characters). */
  name: string
  /** SASFieldName per column, in column order. */
  variables: string[]
  /** Variable labels per column (cut to 40 bytes); default the variable name. */
  labels?: string[]
  /** Dataset label (cut to 40 bytes). */
  label?: string
  now?: Date
}

/** Writes one dataset as a SAS V5 transport file. Throws when a text value exceeds 200 bytes. */
export function writeXpt(table: CombinedTable, o: XptOptions): Uint8Array {
  const tooLong = xptLimitIssues(table)
  if (tooLong.length) throw new Error(`${table.name}: text longer than ${XPT_MAX_TEXT} bytes cannot be written to XPT (${tooLong.join(', ')})`)
  if (o.name.length > NAME || o.variables.some((v) => v.length > NAME)) throw new Error(`${table.name}: XPT names are limited to ${NAME} characters`)
  const date = sasDate(o.now ?? new Date())
  const vars = table.columns.map((c, i) => ({
    name: o.variables[i],
    label: cut(o.labels?.[i] ?? o.variables[i], LABEL),
    char: c.dataType === 'string',
    length: c.dataType === 'string' ? textLength(table, i) : 8,
  }))
  const chunks: Uint8Array[] = []
  const line = (s: string) => chunks.push(pad(s, 80))
  line(header('LIBRARY', '0'.repeat(30)))
  line(`${'SAS'.padEnd(8)}${'SAS'.padEnd(8)}${'SASLIB'.padEnd(8)}${'9.4'.padEnd(8)}${'X64_LIN'.padEnd(8)}${''.padEnd(24)}${date}`)
  line(date)
  line(header('MEMBER', '000000000000000001600000000140'))
  line(header('DSCRPTR', '0'.repeat(30)))
  line(`${'SAS'.padEnd(8)}${o.name.padEnd(8)}${'SASDATA'.padEnd(8)}${'9.4'.padEnd(8)}${'X64_LIN'.padEnd(8)}${''.padEnd(24)}${date}`)
  chunks.push(new Uint8Array([...pad(date, 16), ...pad('', 16), ...pad(cut(o.label ?? '', LABEL), LABEL), ...pad('', 8)]))
  line(header('NAMESTR', `000000${String(vars.length).padStart(4, '0')}${'0'.repeat(20)}`))

  const namestr = new Uint8Array(140 * vars.length)
  let pos = 0
  vars.forEach((v, i) => {
    const b = new DataView(namestr.buffer, 140 * i, 140)
    b.setInt16(0, v.char ? 2 : 1)
    b.setInt16(2, 0)
    b.setInt16(4, v.length)
    b.setInt16(6, i + 1)
    namestr.set(pad(v.name, 8), 140 * i + 8)
    namestr.set(pad(v.label, 40), 140 * i + 16)
    namestr.set(pad('', 8), 140 * i + 56) // format
    namestr.set(pad('', 8), 140 * i + 72) // informat
    b.setInt32(84, pos)
    pos += v.length
  })
  chunks.push(fill80(namestr))
  line(header('OBS', '0'.repeat(30)))

  const obs = new Uint8Array(pos * table.rows.length).fill(0x20)
  table.rows.forEach((r, ri) => {
    let at = ri * pos
    vars.forEach((v, ci) => {
      const value = r[ci]
      if (v.char) {
        if (value !== null) obs.set(enc.encode(String(value)), at)
      } else obs.set(ibmDouble(typeof value === 'number' ? value : value === null ? null : Number(value)), at)
      at += v.length
    })
  })
  chunks.push(fill80(obs))

  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

function fill80(b: Uint8Array): Uint8Array {
  const n = Math.ceil(b.byteLength / 80) * 80
  if (n === b.byteLength) return b
  const out = new Uint8Array(n).fill(0x20)
  out.set(b)
  return out
}

export interface XptDataset {
  name: string
  label: string
  variables: { name: string; label: string; type: 'num' | 'char'; length: number }[]
  rows: (string | number | null)[][]
}

/** Reads a single-member SAS V5 transport file. */
export function readXpt(bytes: Uint8Array): XptDataset {
  const text = (from: number, n: number) => dec.decode(bytes.subarray(from, from + n)).replace(/ +$/, '')
  if (!text(0, 80).startsWith('HEADER RECORD*******LIBRARY HEADER RECORD')) throw new Error('Not a SAS V5 transport file')
  const name = text(80 * 5 + 8, 8)
  const label = text(80 * 6 + 32, 40)
  const nsHeader = text(80 * 7, 80)
  if (!nsHeader.startsWith('HEADER RECORD*******NAMESTR')) throw new Error('NAMESTR header not found')
  const count = Number(nsHeader.slice(54, 58))
  const nsStart = 80 * 8
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const variables = Array.from({ length: count }, (_, i) => {
    const o = nsStart + 140 * i
    return {
      name: text(o + 8, 8),
      label: text(o + 16, 40),
      type: view.getInt16(o) === 2 ? ('char' as const) : ('num' as const),
      length: view.getInt16(o + 4),
      pos: view.getInt32(o + 84),
    }
  })
  const obsStart = nsStart + Math.ceil((140 * count) / 80) * 80 + 80
  if (!text(obsStart - 80, 80).startsWith('HEADER RECORD*******OBS')) throw new Error('OBS header not found')
  const width = variables.reduce((n, v) => n + v.length, 0)
  const rows: (string | number | null)[][] = []
  for (let at = obsStart; width > 0 && at + width <= bytes.byteLength; at += width) {
    const rec = bytes.subarray(at, at + width)
    if (rec.every((x) => x === 0x20)) break // padding of the last 80-byte record
    rows.push(variables.map((v) => (v.type === 'char' ? (text(at + v.pos, v.length) || null) : fromIbmDouble(rec.subarray(v.pos, v.pos + 8)))))
  }
  return { name, label, variables: variables.map(({ pos: _, ...v }) => v), rows }
}
