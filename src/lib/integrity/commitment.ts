/**
 * Salted commitments to originals that were masked or redacted (requirements R5.2–R5.4).
 *
 * A plain SHA-256 of an unmasked results CSV would leak the suppressed values: anyone holding the
 * masked file can try every value 1…(minCellCount−1) for each masked cell until the hash matches.
 * The commitment SHA-256(salt ‖ original) with a random 256-bit salt reveals nothing; the site keeps
 * the salt (in its retention receipt) and can later prove which original it held.
 */
import { bytesToHex, sha256Hex } from './hasher'

export interface Commitment {
  commitment: string
  salt: string
}

export function randomSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

const hexToBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16))

export async function commit(original: Uint8Array, salt = randomSalt()): Promise<Commitment> {
  const s = hexToBytes(salt)
  const buf = new Uint8Array(s.length + original.length)
  buf.set(s)
  buf.set(original, s.length)
  return { commitment: await sha256Hex(buf), salt }
}

export async function verifyCommitment(original: Uint8Array, c: Commitment): Promise<boolean> {
  return (await commit(original, c.salt)).commitment === c.commitment.toLowerCase()
}
