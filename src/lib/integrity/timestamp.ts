/**
 * RFC 3161 time-stamp tokens (requirements R2), exchanged as files.
 *
 * The tool sends nothing (connect-src 'none'), so it never talks to a time-stamp authority (TSA) itself.
 * It writes a request (.tsq) for a SHA-256 digest; the coordinator sends it to a TSA of their choice
 * (e.g. with curl) and drops the reply (.tsr) back in. The tool then checks the token:
 *   - the TSA granted it, and its message imprint is the SHA-256 of the data it should cover,
 *   - the CMS signed attributes bind the TSTInfo (content type, message digest) and, when present,
 *     the signing certificate (ESS signing-certificate v1/v2),
 *   - the signature verifies with the certificate in the token, which is marked for time stamping.
 * It does not decide whether the TSA itself is trustworthy: no certificate chain is built. The report
 * shows the TSA's name and certificate fingerprint, and `openssl ts -verify -CAfile <TSA root>` checks the
 * chain independently.
 *
 * Why tokens give trusted bounds: a token over the protocol is sealed into each pack, so the pack was made
 * after the token existed (lower bound); a token over the disposition log head shows the receipts listed
 * up to that head existed by the token's time (upper bound).
 */
import { bytesToHex } from './hasher'

// ---------- DER ----------

interface Der {
  tag: number
  /** Whole element (tag, length, value). */
  raw: Uint8Array
  value: Uint8Array
  /** Child elements of a constructed element. */
  children: Der[]
}

class DerError extends Error {}

function readDer(bytes: Uint8Array, offset = 0): Der {
  const start = offset
  if (offset + 2 > bytes.length) throw new DerError('Truncated DER')
  const tag = bytes[offset++]
  if ((tag & 0x1f) === 0x1f) throw new DerError('Multi-byte DER tags are not supported')
  let len = bytes[offset++]
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4) throw new DerError('Unsupported DER length')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + bytes[offset++]
  }
  const end = offset + len
  if (end > bytes.length) throw new DerError('Truncated DER')
  const value = bytes.subarray(offset, end)
  const children: Der[] = []
  if (tag & 0x20) {
    let p = 0
    while (p < value.length) {
      const c = readDer(value, p)
      children.push(c)
      p += c.raw.length
    }
  }
  return { tag, raw: bytes.subarray(start, end), value, children }
}

function der(tag: number, value: Uint8Array): Uint8Array {
  const len = value.length
  const head = len < 0x80 ? [tag, len] : len < 0x100 ? [tag, 0x81, len] : [tag, 0x82, len >> 8, len & 0xff]
  const out = new Uint8Array(head.length + len)
  out.set(head)
  out.set(value, head.length)
  return out
}
const seq = (...parts: Uint8Array[]) => der(0x30, concat(parts))

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function oid(d: Der): string {
  const v = d.value
  const out = [Math.floor(v[0] / 40), v[0] % 40]
  let n = 0
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i] & 0x7f)
    if (!(v[i] & 0x80)) {
      out.push(n)
      n = 0
    }
  }
  return out.join('.')
}

function encodeOid(s: string): Uint8Array {
  const parts = s.split('.').map(Number)
  const bytes = [parts[0] * 40 + parts[1]]
  for (const p of parts.slice(2)) {
    const b = [p & 0x7f]
    for (let n = Math.floor(p / 128); n > 0; n = Math.floor(n / 128)) b.unshift((n & 0x7f) | 0x80)
    bytes.push(...b)
  }
  return der(0x06, Uint8Array.from(bytes))
}

const int = (d: Der) => d.value.reduce((n, b) => n * 256 + b, 0)
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
const ab = (b: Uint8Array) => new Uint8Array(b).buffer as ArrayBuffer

// ---------- OIDs ----------

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  extKeyUsage: '2.5.29.37',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecPublicKey: '1.2.840.10045.2.1',
}
const HASHES: Record<string, 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
}
const SHA256_OID = '2.16.840.1.101.3.4.2.1'
const RSA_SIG: Record<string, string> = { '1.2.840.113549.1.1.11': 'SHA-256', '1.2.840.113549.1.1.12': 'SHA-384', '1.2.840.113549.1.1.13': 'SHA-512' }
const ECDSA_SIG: Record<string, string> = { '1.2.840.10045.4.3.2': 'SHA-256', '1.2.840.10045.4.3.3': 'SHA-384', '1.2.840.10045.4.3.4': 'SHA-512' }
const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 },
}

// ---------- Request ----------

export const TSQ_CONTENT_TYPE = 'application/timestamp-query'

/** TimeStampReq (RFC 3161 §2.4.1) for a SHA-256 digest, asking for the TSA certificate in the reply. */
export function timeStampRequest(sha256: Uint8Array | string): Uint8Array {
  const digest = typeof sha256 === 'string' ? hexToBytes(sha256) : sha256
  if (digest.length !== 32) throw new Error('A SHA-256 digest is 32 bytes')
  const imprint = seq(seq(encodeOid(SHA256_OID), der(0x05, new Uint8Array())), der(0x04, digest))
  return seq(der(0x02, Uint8Array.of(1)), imprint, der(0x01, Uint8Array.of(0xff)))
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^([a-f0-9]{2})*$/i.test(hex)) throw new Error('Not a hex string')
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))
}

/** curl command that sends a request file to a TSA and saves the reply. */
export function tsaCommand(tsq: string, tsr: string, url = 'https://freetsa.org/tsr'): string {
  return `curl -sS -H "Content-Type: ${TSQ_CONTENT_TYPE}" --data-binary @${tsq} -o ${tsr} ${url}`
}

// ---------- Verification ----------

export interface TimestampCheck {
  valid: boolean
  /** TSA's time (ISO-8601 UTC), when the token could be read. */
  genTime?: string
  /** SHA-256 the token covers (hex). */
  imprint?: string
  serial?: string
  policy?: string
  /** Subject of the signing certificate, e.g. "Example TSA (Example Org)". */
  tsa?: string
  /** SHA-256 of the signing certificate (DER), to compare with the TSA's published certificate. */
  tsaCertSha256?: string
  error?: string
}

function name(n: Der): string {
  const attrs = new Map<string, string>()
  for (const rdn of n.children) for (const atv of rdn.children) attrs.set(oid(atv.children[0]), new TextDecoder().decode(atv.children[1].value))
  const cn = attrs.get(OID.commonName)
  const o = attrs.get(OID.organization)
  return cn && o ? `${cn} (${o})` : cn ?? o ?? '?'
}

function generalizedTime(d: Der): string {
  const s = new TextDecoder().decode(d.value)
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s)
  if (!m) throw new DerError(`Unsupported genTime ${s}`)
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ''}Z`).toISOString()
}

/** ECDSA signatures are DER (r, s) in CMS and fixed-size r‖s in WebCrypto. */
function ecdsaRaw(sig: Uint8Array, size: number): Uint8Array {
  const [r, s] = readDer(sig).children.map((c) => {
    let v = c.value
    while (v.length > size && v[0] === 0) v = v.subarray(1)
    const out = new Uint8Array(size)
    out.set(v, size - v.length)
    return out
  })
  return concat([r, s])
}

interface Cert {
  raw: Uint8Array
  serial: Uint8Array
  issuer: Uint8Array
  subject: string
  spki: Der
  timeStamping: boolean
}

function readCert(c: Der): Cert {
  const tbs = c.children[0]
  let i = tbs.children[0].tag === 0xa0 ? 1 : 0
  const serial = tbs.children[i++].value
  i++ // signature algorithm
  const issuer = tbs.children[i++].raw
  i++ // validity
  const subject = name(tbs.children[i++])
  const spki = tbs.children[i++]
  let timeStamping = false
  const exts = tbs.children.find((x) => x.tag === 0xa3)
  for (const ext of exts?.children[0]?.children ?? []) {
    if (oid(ext.children[0]) !== OID.extKeyUsage) continue
    const usages = readDer(ext.children[ext.children.length - 1].value).children.map(oid)
    timeStamping = usages.includes(OID.timeStamping)
  }
  return { raw: c.raw, serial, issuer, subject, spki, timeStamping }
}

async function verifySignature(cert: Cert, sigAlg: string, digestAlg: string, signed: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const keyAlg = oid(cert.spki.children[0].children[0])
  const subtle = globalThis.crypto.subtle
  if (keyAlg === OID.rsaEncryption) {
    const hash = RSA_SIG[sigAlg] ?? (sigAlg === OID.rsaEncryption ? HASHES[digestAlg] : undefined)
    if (!hash) throw new Error(`Unsupported RSA signature algorithm ${sigAlg}`)
    const key = await subtle.importKey('spki', ab(cert.spki.raw), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify'])
    return subtle.verify('RSASSA-PKCS1-v1_5', key, ab(signature), ab(signed))
  }
  if (keyAlg === OID.ecPublicKey) {
    const curve = CURVES[oid(cert.spki.children[0].children[1])]
    const hash = ECDSA_SIG[sigAlg]
    if (!curve || !hash) throw new Error(`Unsupported ECDSA key or signature algorithm ${sigAlg}`)
    const key = await subtle.importKey('spki', ab(cert.spki.raw), { name: 'ECDSA', namedCurve: curve.name }, false, ['verify'])
    return subtle.verify({ name: 'ECDSA', hash }, key, ab(ecdsaRaw(signature, curve.size)), ab(signed))
  }
  throw new Error(`Unsupported TSA key algorithm ${keyAlg}`)
}

/** The TimeStampToken (CMS ContentInfo) inside a TimeStampResp, or the token itself. */
function tokenOf(bytes: Uint8Array): Der {
  const top = readDer(bytes)
  if (top.children[0]?.tag === 0x06) return top // already a ContentInfo
  const status = int(top.children[0].children[0])
  if (status !== 0 && status !== 1) throw new Error(`The TSA did not grant the request (status ${status})`)
  if (!top.children[1]) throw new Error('The reply carries no time-stamp token')
  return top.children[1]
}

/**
 * Check a time-stamp reply (.tsr) or token against the SHA-256 (hex) of the data it should cover.
 * Never throws: problems are returned as { valid: false, error }.
 */
export async function verifyTimestamp(bytes: Uint8Array, expectedSha256: string): Promise<TimestampCheck> {
  const out: TimestampCheck = { valid: false }
  try {
    const ci = tokenOf(bytes)
    if (oid(ci.children[0]) !== OID.signedData) throw new Error('The token is not CMS signed data')
    const sd = ci.children[1].children[0]
    const encap = sd.children[2]
    if (oid(encap.children[0]) !== OID.tstInfo) throw new Error('The token does not contain TSTInfo')
    const eContent = encap.children[1].children[0].value
    const tst = readDer(eContent)
    const [, policy, imprint, serial, genTime] = tst.children
    out.policy = oid(policy)
    out.serial = bytesToHex(ab(serial.value))
    out.genTime = generalizedTime(genTime)
    out.imprint = bytesToHex(ab(imprint.children[1].value))
    if (oid(imprint.children[0].children[0]) !== SHA256_OID) throw new Error('The token does not use a SHA-256 message imprint')
    if (out.imprint !== expectedSha256.toLowerCase()) throw new Error('The token covers different data')

    const certs = sd.children.filter((c) => c.tag === 0xa0).flatMap((c) => c.children.filter((x) => x.tag === 0x30).map(readCert))
    const signerInfo = sd.children[sd.children.length - 1].children[0]
    if (!signerInfo) throw new Error('The token has no signer')
    const sid = signerInfo.children[1]
    const cert =
      sid.tag === 0x30
        ? certs.find((c) => equalBytes(c.issuer, sid.children[0].raw) && equalBytes(c.serial, sid.children[1].value))
        : certs.length === 1
          ? certs[0]
          : undefined
    if (!cert) throw new Error('The TSA certificate is not in the token (request it with certReq, as the requests made here do)')
    out.tsa = cert.subject
    out.tsaCertSha256 = bytesToHex(await globalThis.crypto.subtle.digest('SHA-256', ab(cert.raw)))
    if (!cert.timeStamping) throw new Error('The signing certificate is not marked for time stamping')

    const digestAlg = oid(signerInfo.children[2].children[0])
    const hash = HASHES[digestAlg]
    if (!hash || hash === 'SHA-1') throw new Error(`Unsupported signer digest algorithm ${digestAlg}`)
    const attrsEl = signerInfo.children[3]
    if (attrsEl?.tag !== 0xa0) throw new Error('The token has no signed attributes')
    const attrs = new Map(attrsEl.children.map((a) => [oid(a.children[0]), a.children[1].children[0]]))
    if (attrs.get(OID.contentType) && oid(attrs.get(OID.contentType)!) !== OID.tstInfo) throw new Error('The signed content type is not TSTInfo')
    const md = attrs.get(OID.messageDigest)
    const contentDigest = new Uint8Array(await globalThis.crypto.subtle.digest(hash, ab(eContent)))
    if (!md || !equalBytes(md.value, contentDigest)) throw new Error('The signed message digest does not match the TSTInfo')
    // ESS: the signed attributes name the signing certificate, so another certificate cannot be swapped in.
    const v2 = attrs.get(OID.signingCertificateV2)
    const v1 = attrs.get(OID.signingCertificate)
    if (v2 || v1) {
      const essCert = (v2 ?? v1)!.children[0].children[0]
      const hasAlg = essCert.children[0].tag === 0x30
      const alg = v2 ? (hasAlg ? HASHES[oid(essCert.children[0].children[0])] : 'SHA-256') : 'SHA-1'
      const certHash = essCert.children[hasAlg ? 1 : 0].value
      if (!alg || !equalBytes(certHash, new Uint8Array(await globalThis.crypto.subtle.digest(alg, ab(cert.raw)))))
        throw new Error('The signed attributes name a different signing certificate')
    }
    const signedAttrs = new Uint8Array(attrsEl.raw)
    signedAttrs[0] = 0x31 // signed as a SET OF, not the [0] IMPLICIT tag (RFC 5652 §5.4)
    const sigAlg = oid(signerInfo.children[4].children[0])
    const signature = signerInfo.children[5].value
    if (!(await verifySignature(cert, sigAlg, digestAlg, signedAttrs, signature))) throw new Error('The TSA signature does not verify')
    out.valid = true
  } catch (e) {
    out.error = e instanceof DerError ? `Not a readable time-stamp token (${e.message})` : e instanceof Error ? e.message : String(e)
  }
  return out
}
