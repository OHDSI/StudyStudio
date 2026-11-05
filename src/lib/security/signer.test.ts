import { describe, expect, it } from 'vitest'
import { b64url, b64urlDecode } from './base64url'
import {
  addSignature,
  createKeyFile,
  jwkThumbprint,
  parseKeyFile,
  unlockKeyFile,
  verifyDetachedJws,
  type SignerRoster,
} from './signer'

const enc = new TextEncoder()
const signer = { name: 'Hanako Yamada', organization: 'Site A Hospital', role: 'operator' as const }
const PASS = 'correct horse battery'
// Fewer PBKDF2 iterations keep the tests fast; production uses the default.
const fast = { iterations: 1000, now: new Date('2026-11-01T00:00:00Z') }

describe('base64url', () => {
  it('round-trips large payloads without padding', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 256)
    const s = b64url(bytes)
    expect(s).not.toMatch(/[=+/]/)
    expect(b64urlDecode(s)).toEqual(bytes)
  })
})

describe('jwkThumbprint (RFC 7638)', () => {
  it('matches the RFC 7638 §3.1 style computation for an EC key', async () => {
    // Example EC key from RFC 7517 Appendix A.1; thumbprint computed from the canonical member order.
    const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'MKBCTNIcKUSDii11ySs3526iDZ8AiTo7Tu6KPAqv7D4', y: '4Etl6SRW2YiLUrN5vfvVHuhp7x8PxltmWWlbbM4IFyM' }
    const expected = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`))))
    expect(await jwkThumbprint(jwk)).toBe(expected)
  })
})

describe('key file', () => {
  it('rejects short passphrases', async () => {
    await expect(createKeyFile(signer, 'short', fast)).rejects.toThrow(/at least/)
  })

  it('unlocks with the right passphrase only', async () => {
    const kf = parseKeyFile(JSON.parse(JSON.stringify(await createKeyFile(signer, PASS, fast))))
    expect(kf.kid).toBe(await jwkThumbprint(kf.publicJwk))
    const u = await unlockKeyFile(kf, PASS)
    expect(u.kid).toBe(kf.kid)
    await expect(unlockKeyFile(kf, 'wrong passphrase!!')).rejects.toThrow(/Wrong passphrase/)
  })

  it('detects a key file whose public key was swapped', async () => {
    const a = await createKeyFile(signer, PASS, fast)
    const b = await createKeyFile(signer, PASS, fast)
    await expect(unlockKeyFile({ ...a, publicJwk: b.publicJwk, kid: b.kid }, PASS)).rejects.toThrow(/does not match/)
  })
})

describe('detached JWS', () => {
  const payload = enc.encode('{"files":[]}\n')

  it('verifies, records meaning/time/zone, and fails on any payload change', async () => {
    const kf = await createKeyFile(signer, PASS, fast)
    const u = await unlockKeyFile(kf, PASS)
    const jws = await addSignature(undefined, payload, u, 'sealed', new Date('2026-11-02T03:04:05Z'))
    const [ok] = await verifyDetachedJws(jws, payload)
    expect(ok).toMatchObject({ valid: true, kid: kf.kid, meaning: 'sealed', signedAt: '2026-11-02T03:04:05.000Z', signer })
    expect(typeof ok.tzOffsetMinutes).toBe('number')
    const [bad] = await verifyDetachedJws(jws, enc.encode('{"files":[1]}\n'))
    expect(bad.valid).toBe(false)
  })

  it('supports several signers and checks the roster', async () => {
    const op = await unlockKeyFile(await createKeyFile(signer, PASS, fast), PASS)
    const pi = await unlockKeyFile(await createKeyFile({ ...signer, name: 'PI', role: 'site-pi' }, PASS, fast), PASS)
    let jws = await addSignature(undefined, payload, op, 'sealed', new Date('2026-11-02T00:00:00Z'))
    jws = await addSignature(jws, payload, pi, 'approved-for-release', new Date('2026-11-03T00:00:00Z'))
    const roster: SignerRoster = {
      format: 'studypack-signer-roster/1',
      studyId: 'S',
      signers: [
        { kid: op.kid, name: 'Hanako Yamada', organization: 'Site A', role: 'operator', siteId: 'Site_A', enrolledAt: '2026-10-01T00:00:00Z', verifiedBy: 'Coordinator', verificationMethod: 'video call + ID' },
        { kid: pi.kid, name: 'PI', organization: 'Site A', role: 'site-pi', siteId: 'Site_A', enrolledAt: '2026-10-01T00:00:00Z', verifiedBy: 'Coordinator', verificationMethod: 'video call + ID', revokedAt: '2026-11-02T12:00:00Z' },
      ],
    }
    const [a, b] = await verifyDetachedJws(jws, payload, roster, 'Site_A')
    expect(a).toMatchObject({ valid: true, enrolled: true })
    expect(b).toMatchObject({ valid: true, enrolled: false })
    expect(b.enrollmentIssue).toMatch(/revoked/)
    const [other] = await verifyDetachedJws(jws, payload, roster, 'Site_B')
    expect(other.enrolled).toBe(false)
    expect(other.enrollmentIssue).toMatch(/Site_A/)
  })

  it('judges revocation by the coordinator receipt time, so a back-dated signature does not help', async () => {
    const { enrollment } = await import('./signer')
    const roster: SignerRoster = {
      format: 'studypack-signer-roster/1',
      studyId: 'S',
      signers: [{ kid: 'k', name: 'n', organization: 'o', role: 'operator', siteId: 'Site_A', enrolledAt: '2026-11-10T00:00:00Z', verifiedBy: 'C', verificationMethod: 'm', revokedAt: '2026-11-05T00:00:00Z' }],
    }
    // Signed (by the device clock) before revocation, but received after it.
    expect(enrollment(roster, 'k', '2026-11-01T00:00:00Z', 'Site_A', '2026-11-06T00:00:00Z').enrolled).toBe(false)
    expect(enrollment(roster, 'k', '2026-11-01T00:00:00Z', 'Site_A', '2026-11-04T00:00:00Z').enrolled).toBe(true)
    // Enrollment after signing is fine: it binds the key to a verified person.
    expect(enrollment({ ...roster, signers: [{ ...roster.signers[0], revokedAt: undefined }] }, 'k', '2026-11-01T00:00:00Z', 'Site_A').enrolled).toBe(true)
  })

  it('rejects a header whose embedded key does not match its kid', async () => {
    const u = await unlockKeyFile(await createKeyFile(signer, PASS, fast), PASS)
    const jws = await addSignature(undefined, payload, u, 'sealed')
    const h = JSON.parse(new TextDecoder().decode(b64urlDecode(jws.signatures[0].protected)))
    h.kid = 'someone-else'
    const forged = { signatures: [{ protected: b64url(enc.encode(JSON.stringify(h))), signature: jws.signatures[0].signature }] }
    const [r] = await verifyDetachedJws(forged, payload)
    expect(r.valid).toBe(false)
    expect(r.error).toMatch(/Key ID/)
  })
})
