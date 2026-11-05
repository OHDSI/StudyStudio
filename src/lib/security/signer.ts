/**
 * Electronic signatures without a network (docs/regulatory/requirements.md R1).
 *
 * - Keys: ECDSA P-256 generated in the browser. The private key only ever leaves memory wrapped with
 *   AES-GCM under a PBKDF2-derived key, as a "key file" the signer keeps. Key file + passphrase are the
 *   two signature components (21 CFR 11.200).
 * - Signatures: detached JWS (RFC 7515, General JSON Serialization, ES256) over the exact bytes of the
 *   signed file (manifest.json, study_config.json, a disposition-log head). Nothing is re-serialised, so
 *   any JOSE library or openssl can verify them without this tool.
 * - Key IDs are RFC 7638 JWK thumbprints. Trust comes from the signer roster, not from the signature.
 */
import { b64url, b64urlDecode } from './base64url'

const enc = new TextEncoder()
const dec = new TextDecoder()

export type SignerRole = 'operator' | 'site-pi' | 'coordinator'
export const SIGNER_ROLES: SignerRole[] = ['operator', 'site-pi', 'coordinator']

export interface SignerInfo {
  name: string
  organization: string
  role: SignerRole
}

export interface PublicEcJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
}

/** RFC 7638 thumbprint (SHA-256, base64url): the stable key ID used for enrollment. */
export async function jwkThumbprint(j: PublicEcJwk): Promise<string> {
  const canonical = `{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canonical))))
}

// ---------------------------------------------------------------- key file

export const KEY_FILE_FORMAT = 'studypack-signing-key/1' as const

export interface KeyFile {
  format: typeof KEY_FILE_FORMAT
  signer: SignerInfo
  kid: string
  publicJwk: PublicEcJwk
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
  wrap: { name: 'AES-GCM'; iv: string }
  wrappedPkcs8: string
  createdAt: string
}

export const MIN_PASSPHRASE_LENGTH = 12
const PBKDF2_ITERATIONS = 600_000
const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const
const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const

async function deriveKek(passphrase: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])
}

const toPublic = (j: JsonWebKey): PublicEcJwk => ({ kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! })

/** Create a signing key and return it only as a passphrase-protected key file. */
export async function createKeyFile(signer: SignerInfo, passphrase: string, opts: { now?: Date; iterations?: number } = {}): Promise<KeyFile> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`)
  if (!signer.name.trim()) throw new Error('Signer name is required')
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS
  const pair = (await crypto.subtle.generateKey(EC, true, ['sign', 'verify'])) as CryptoKeyPair
  const publicJwk = toPublic(await crypto.subtle.exportKey('jwk', pair.publicKey))
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const kek = await deriveKek(passphrase, salt, iterations)
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('pkcs8', pair.privateKey, kek, { name: 'AES-GCM', iv }))
  return {
    format: KEY_FILE_FORMAT,
    signer: { name: signer.name.trim(), organization: signer.organization.trim(), role: signer.role },
    kid: await jwkThumbprint(publicJwk),
    publicJwk,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64url(salt) },
    wrap: { name: 'AES-GCM', iv: b64url(iv) },
    wrappedPkcs8: b64url(wrapped),
    createdAt: (opts.now ?? new Date()).toISOString(),
  }
}

export function parseKeyFile(v: unknown): KeyFile {
  const k = v as Partial<KeyFile>
  if (!k || k.format !== KEY_FILE_FORMAT) throw new Error('Not a StudyPack signing key file')
  if (!k.kid || !k.publicJwk || !k.wrappedPkcs8 || !k.kdf || !k.wrap || !k.signer) throw new Error('Key file is incomplete')
  return k as KeyFile
}

export interface UnlockedSigner {
  key: CryptoKey
  kid: string
  publicJwk: PublicEcJwk
  signer: SignerInfo
}

export async function unlockKeyFile(file: KeyFile, passphrase: string): Promise<UnlockedSigner> {
  const kek = await deriveKek(passphrase, b64urlDecode(file.kdf.salt), file.kdf.iterations)
  let key: CryptoKey
  try {
    key = await crypto.subtle.unwrapKey('pkcs8', b64urlDecode(file.wrappedPkcs8) as BufferSource, kek, { name: 'AES-GCM', iv: b64urlDecode(file.wrap.iv) as BufferSource }, EC, false, ['sign'])
  } catch {
    throw new Error('Wrong passphrase or corrupted key file')
  }
  if ((await jwkThumbprint(file.publicJwk)) !== file.kid) throw new Error('Key file ID does not match its public key')
  // The private and public halves must belong together (detects a key file whose public key was swapped).
  const probe = enc.encode(`probe:${file.kid}`)
  const pub = await crypto.subtle.importKey('jwk', file.publicJwk, EC, false, ['verify'])
  if (!(await crypto.subtle.verify(ES256, pub, await crypto.subtle.sign(ES256, key, probe), probe))) throw new Error('Private key does not match the public key')
  return { key, kid: file.kid, publicJwk: file.publicJwk, signer: file.signer }
}

// ---------------------------------------------------------------- detached JWS

export type SignatureMeaning = 'protocol-issued' | 'sealed' | 'approved-for-release' | 'roster-approved' | 'disposition-locked' | 'disposition-exported'

export const MEANING_STATEMENT: Record<SignatureMeaning, string> = {
  'protocol-issued': 'I issue this protocol for the network study.',
  sealed: 'I sealed this StudyPack and confirm that its contents are the results produced at this site.',
  'approved-for-release': 'I approve the release of this StudyPack from this site.',
  'roster-approved': 'I verified the identity of each enrolled signer and approve this signer roster.',
  'disposition-locked': 'I lock the site dispositions. Comparative results between exposure groups were not viewed when making them.',
  'disposition-exported': 'I confirm this disposition log as exported with the submission package.',
}

export interface ProtectedHeader {
  alg: 'ES256'
  typ: 'studypack+jws'
  kid: string
  jwk: PublicEcJwk
  'sp:signer': SignerInfo
  'sp:meaning': SignatureMeaning
  'sp:statement': string
  'sp:signedAt': string
  'sp:tzOffsetMinutes': number
  /** Times are read from the signer's device clock; there is no trusted time source offline (R2.2). */
  'sp:timeSource': 'device-clock'
}

export interface DetachedJws {
  signatures: { protected: string; signature: string }[]
}

export async function addSignature(
  jws: DetachedJws | undefined,
  payload: Uint8Array,
  s: UnlockedSigner,
  meaning: SignatureMeaning,
  now = new Date(),
): Promise<DetachedJws> {
  const header: ProtectedHeader = {
    alg: 'ES256',
    typ: 'studypack+jws',
    kid: s.kid,
    jwk: s.publicJwk,
    'sp:signer': s.signer,
    'sp:meaning': meaning,
    'sp:statement': MEANING_STATEMENT[meaning],
    'sp:signedAt': now.toISOString(),
    'sp:tzOffsetMinutes': -now.getTimezoneOffset(),
    'sp:timeSource': 'device-clock',
  }
  const protectedB64 = b64url(enc.encode(JSON.stringify(header)))
  // Web Crypto ECDSA returns raw r||s, which is exactly the JWS ES256 signature format.
  const sig = new Uint8Array(await crypto.subtle.sign(ES256, s.key, enc.encode(`${protectedB64}.${b64url(payload)}`)))
  return { signatures: [...(jws?.signatures ?? []), { protected: protectedB64, signature: b64url(sig) }] }
}

// ---------------------------------------------------------------- roster + verification

export interface EnrolledSigner {
  kid: string
  name: string
  organization: string
  role: SignerRole
  /** Site the signer belongs to (empty for the coordinator). */
  siteId?: string
  enrolledAt: string
  /** Who verified the signer's identity, and how (R1.5 — an SOP step recorded here). */
  verifiedBy: string
  verificationMethod: string
  revokedAt?: string
}

export interface SignerRoster {
  format: 'studypack-signer-roster/1'
  studyId: string
  signers: EnrolledSigner[]
}

export function parseRoster(v: unknown): SignerRoster {
  const r = v as Partial<SignerRoster>
  if (!r || r.format !== 'studypack-signer-roster/1' || !Array.isArray(r.signers)) throw new Error('Not a StudyPack signer roster')
  return r as SignerRoster
}

export interface SignatureCheck {
  kid: string
  /** Cryptographically valid over this payload. */
  valid: boolean
  /** In the roster, for this site, enrolled before and not revoked at signing time. */
  enrolled: boolean
  enrollmentIssue?: string
  signer?: SignerInfo
  meaning?: SignatureMeaning
  signedAt?: string
  tzOffsetMinutes?: number
  error?: string
}

/**
 * Is a key trusted for this site? Enrollment binds a key to a verified person; it does not matter whether
 * the signature was made before or after enrollment (the signing time is only a device-clock reading).
 * Revocation is judged against the coordinator's receipt time when known, so a revoked key cannot be used
 * by back-dating the signer's clock.
 */
export function enrollment(roster: SignerRoster | undefined, kid: string, signedAt: string | undefined, siteId: string | undefined, receivedAt?: string): { enrolled: boolean; issue?: string } {
  if (!roster) return { enrolled: false, issue: 'No signer roster loaded' }
  const e = roster.signers.find((s) => s.kid === kid)
  if (!e) return { enrolled: false, issue: 'Key is not in the signer roster' }
  if (siteId !== undefined && e.siteId && e.siteId !== siteId) return { enrolled: false, issue: `Key is enrolled for ${e.siteId}, not ${siteId}` }
  const t = Date.parse(receivedAt ?? signedAt ?? '')
  if (e.revokedAt && (Number.isNaN(t) || t >= Date.parse(e.revokedAt))) return { enrolled: false, issue: `Key was revoked at ${e.revokedAt}` }
  return { enrolled: true }
}

export function parseJws(v: unknown): DetachedJws {
  const j = v as Partial<DetachedJws>
  if (!j || !Array.isArray(j.signatures)) throw new Error('Not a detached JWS (General JSON Serialization)')
  return j as DetachedJws
}

export async function verifyDetachedJws(jws: DetachedJws, payload: Uint8Array, roster?: SignerRoster, siteId?: string): Promise<SignatureCheck[]> {
  const body = b64url(payload)
  return Promise.all(
    jws.signatures.map(async (s): Promise<SignatureCheck> => {
      try {
        const h = JSON.parse(dec.decode(b64urlDecode(s.protected))) as ProtectedHeader
        if (h.alg !== 'ES256') throw new Error(`Unsupported algorithm ${String(h.alg)}`)
        if (!h.jwk || (await jwkThumbprint(h.jwk)) !== h.kid) throw new Error('Key ID does not match the embedded key')
        const key = await crypto.subtle.importKey('jwk', h.jwk, EC, false, ['verify'])
        const valid = await crypto.subtle.verify(ES256, key, b64urlDecode(s.signature) as BufferSource, enc.encode(`${s.protected}.${body}`))
        const { enrolled, issue } = enrollment(roster, h.kid, h['sp:signedAt'], siteId)
        return {
          kid: h.kid,
          valid,
          enrolled,
          enrollmentIssue: issue,
          signer: h['sp:signer'],
          meaning: h['sp:meaning'],
          signedAt: h['sp:signedAt'],
          tzOffsetMinutes: h['sp:tzOffsetMinutes'],
        }
      } catch (e) {
        return { kid: '?', valid: false, enrolled: false, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
}

/** Re-evaluate enrollment of already-verified signatures (e.g. after a roster is loaded). */
export function withEnrollment(checks: SignatureCheck[], roster: SignerRoster | undefined, siteId?: string, receivedAt?: string, rosterIssue?: string): SignatureCheck[] {
  return checks.map((c) => {
    if (!c.valid) return c
    if (rosterIssue) return { ...c, enrolled: false, enrollmentIssue: rosterIssue }
    const { enrolled, issue } = enrollment(roster, c.kid, c.signedAt, siteId, receivedAt)
    return { ...c, enrolled, enrollmentIssue: issue }
  })
}

/** Short, human-comparable form of a key ID for reading out over the phone during enrollment. */
export function kidFingerprint(kid: string): string {
  return (kid.slice(0, 16).match(/.{1,4}/g) ?? []).join('-')
}

// ---------------------------------------------------------------- enrollment card

/** The public half of a key file, sent to the coordinator for enrollment (contains no secret). */
export interface EnrollmentCard {
  format: 'studypack-enrollment-card/1'
  kid: string
  publicJwk: PublicEcJwk
  signer: SignerInfo
  createdAt: string
}

export function enrollmentCard(k: KeyFile): EnrollmentCard {
  return { format: 'studypack-enrollment-card/1', kid: k.kid, publicJwk: k.publicJwk, signer: k.signer, createdAt: k.createdAt }
}

export async function parseEnrollmentCard(v: unknown): Promise<EnrollmentCard> {
  const c = v as Partial<EnrollmentCard>
  if (!c || c.format !== 'studypack-enrollment-card/1' || !c.publicJwk || !c.kid || !c.signer) throw new Error('Not a StudyPack enrollment card')
  if ((await jwkThumbprint(c.publicJwk)) !== c.kid) throw new Error('Enrollment card key ID does not match its public key')
  return c as EnrollmentCard
}

// ---------------------------------------------------------------- roster trust

export type RosterTrust = 'signed-by-issuer' | 'signed-by-other' | 'unsigned' | 'invalid'

export interface RosterStatus {
  trust: RosterTrust
  checks: SignatureCheck[]
  message: string
}

/**
 * A roster is only as trustworthy as whoever signed it. The trust anchor is the key that signed the
 * protocol (study_config.json): the roster must carry a valid "roster-approved" signature by that key.
 */
export async function verifyRoster(rosterBytes: Uint8Array, signature: DetachedJws | undefined, issuerKids: readonly string[]): Promise<RosterStatus> {
  if (!signature) return { trust: 'unsigned', checks: [], message: 'The signer roster is not signed' }
  const checks = await verifyDetachedJws(signature, rosterBytes)
  if (checks.some((c) => !c.valid)) return { trust: 'invalid', checks, message: 'The signer roster signature is invalid — the roster was changed after signing' }
  const byIssuer = checks.find((c) => issuerKids.includes(c.kid) && c.meaning === 'roster-approved')
  if (byIssuer) return { trust: 'signed-by-issuer', checks, message: `Signed by ${byIssuer.signer?.name ?? 'the protocol issuer'} (protocol issuer key)` }
  return { trust: 'signed-by-other', checks, message: issuerKids.length ? 'The signer roster is signed, but not by the key that issued the protocol' : 'The signer roster is signed, but the protocol is unsigned, so there is no key to trust it against' }
}

export function rosterBytes(r: SignerRoster): Uint8Array {
  return enc.encode(JSON.stringify(r, null, 2) + '\n')
}
