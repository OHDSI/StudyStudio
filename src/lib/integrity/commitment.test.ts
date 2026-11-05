import { describe, expect, it } from 'vitest'
import { commit, verifyCommitment } from './commitment'
import { sha256Hex } from './hasher'

const enc = new TextEncoder()

describe('salted commitment', () => {
  it('verifies the original and nothing else', async () => {
    const original = enc.encode('cohort_id,count\n1,3\n')
    const c = await commit(original)
    expect(c.salt).toMatch(/^[0-9a-f]{64}$/)
    expect(await verifyCommitment(original, c)).toBe(true)
    expect(await verifyCommitment(enc.encode('cohort_id,count\n1,4\n'), c)).toBe(false)
  })

  it('does not equal the plain hash (masked values cannot be brute-forced from it)', async () => {
    const original = enc.encode('cohort_id,count\n1,3\n')
    const c = await commit(original)
    expect(c.commitment).not.toBe(await sha256Hex(original))
    // Without the salt, trying every masked value 1..4 never reproduces the commitment.
    for (let v = 1; v < 5; v++) expect(await sha256Hex(enc.encode(`cohort_id,count\n1,${v}\n`))).not.toBe(c.commitment)
  })

  it('is deterministic for a given salt', async () => {
    const b = enc.encode('x')
    const a = await commit(b, '00'.repeat(32))
    expect((await commit(b, '00'.repeat(32))).commitment).toBe(a.commitment)
  })
})
