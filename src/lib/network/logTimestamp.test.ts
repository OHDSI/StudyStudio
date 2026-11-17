import { describe, expect, it, vi } from 'vitest'
import { DispositionLog } from './dispositionLog'
import { logTimestampNote, receiptTimestamp, verifyLogTimestamps } from './logTimestamp'

// The token itself is checked in integrity/timestamp.test.ts; here a stand-in accepts any token for the
// hash it is given and reads its time from the token bytes, so the log logic can be tested on its own.
vi.mock('@/lib/integrity/timestamp', () => ({
  verifyTimestamp: vi.fn(async (bytes: Uint8Array, sha256: string) => ({ valid: true, genTime: new TextDecoder().decode(bytes), imprint: sha256, tsa: 'Test TSA' })),
}))
const { verifyTimestamp } = await import('@/lib/integrity/timestamp')

const actor = { name: 'Coordinator', role: 'coordinator', organization: 'Org' }
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const enc = new TextEncoder()

async function stamp(log: DispositionLog, genTime: string) {
  const tsr = enc.encode(genTime)
  await log.append(logTimestampNote(log, tsr, await verifyTimestamp(tsr, log.headHash), actor))
}

describe('time-stamps over the disposition log', () => {
  it('bounds each receipt by the earliest token that covers it', async () => {
    const log = new DispositionLog()
    await log.append({ actor, action: 'received', siteId: 'A', packSha256: A })
    await stamp(log, '2026-11-01T00:00:00.000Z')
    await log.append({ actor, action: 'received', siteId: 'B', packSha256: B })
    await stamp(log, '2026-11-02T00:00:00.000Z')
    const stamps = await verifyLogTimestamps(log)
    expect(stamps.map((s) => [s.coversSeq, s.check.valid])).toEqual([[0, true], [2, true]])
    expect(receiptTimestamp(log, stamps, A)?.genTime).toBe('2026-11-01T00:00:00.000Z')
    expect(receiptTimestamp(log, stamps, B)?.genTime).toBe('2026-11-02T00:00:00.000Z')
    expect(receiptTimestamp(log, stamps, 'c'.repeat(64))).toBeUndefined()
  })

  it('survives export and import, and rejects a token moved to cover another entry', async () => {
    const log = new DispositionLog()
    await log.append({ actor, action: 'received', siteId: 'A', packSha256: A })
    await stamp(log, '2026-11-01T00:00:00.000Z')
    const again = await DispositionLog.fromJsonl(log.toJsonl())
    expect((await verifyLogTimestamps(again))[0].check.valid).toBe(true)

    // A forged note claiming to cover entry 0 with another hash.
    const forged = new DispositionLog()
    await forged.append({ actor, action: 'received', siteId: 'A', packSha256: A })
    await forged.append({ actor, action: 'note', details: { timestamp: { format: 'rfc3161-log-head/1', coversSeq: 0, coversHash: B, token: 'eA' } } })
    const [s] = await verifyLogTimestamps(forged)
    expect(s.check).toMatchObject({ valid: false, error: 'The token does not cover entry 0 of this log' })
    expect(receiptTimestamp(forged, [s], A)).toBeUndefined()
  })
})
