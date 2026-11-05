import { describe, expect, it } from 'vitest'
import { DispositionLog, GENESIS } from './dispositionLog'

const actor = { name: 'Coordinator', role: 'coordinator', organization: 'Network' }
const PACK = 'a'.repeat(64)

async function sample() {
  const log = new DispositionLog()
  await log.append({ actor, action: 'received', siteId: 'Site_A', packSha256: PACK })
  await log.append({ actor, action: 'exclude', siteId: 'Site_A', packSha256: PACK, from: 'undecided', to: 'exclude', recommended: 'exclude', reasonCode: 'INTEGRITY' })
  return log
}

describe('DispositionLog', () => {
  it('chains entries and round-trips through JSONL', async () => {
    const log = await sample()
    expect(log.entries[0].prevHash).toBe(GENESIS)
    expect(log.entries[1].prevHash).not.toBe(GENESIS)
    const again = await DispositionLog.fromJsonl(log.toJsonl(), { headHash: log.headHash, entries: 2 })
    expect(again.headHash).toBe(log.headHash)
    expect(again.decisions().get(PACK)).toBe('exclude')
  })

  it('requires identity, a pre-specified reason, and justification for overrides', async () => {
    const log = new DispositionLog()
    await expect(log.append({ actor: { ...actor, name: '' }, action: 'note' })).rejects.toThrow(/identified/)
    await expect(log.append({ actor, action: 'exclude', packSha256: PACK })).rejects.toThrow(/reason code/)
    await expect(log.append({ actor, action: 'exclude', packSha256: PACK, reasonCode: 'BECAUSE' })).rejects.toThrow(/not pre-specified/)
    await expect(log.append({ actor, action: 'exclude', packSha256: PACK, reasonCode: 'OTHER' })).rejects.toThrow(/justification/)
    await expect(log.append({ actor, action: 'adopt', packSha256: PACK, deviatesFromRecommendation: true, reasonCode: 'INTEGRITY' })).rejects.toThrow(/justification/)
    await log.append({ actor, action: 'adopt', packSha256: PACK, deviatesFromRecommendation: true, reasonCode: 'INTEGRITY', reasonText: 'Mismatch is a CRLF artefact, confirmed with the site' })
    expect(log.size).toBe(1)
  })

  it('refuses decisions after lock', async () => {
    const log = await sample()
    await log.append({ actor, action: 'lock' })
    await expect(log.append({ actor, action: 'adopt', packSha256: PACK })).rejects.toThrow(/locked/)
    await log.append({ actor, action: 'note', reasonText: 'still allowed' })
  })

  it('detects an edited, removed or truncated entry', async () => {
    const log = await sample()
    await log.append({ actor, action: 'lock' })
    const lines = log.toJsonl().trim().split('\n')
    const edited = [lines[0], lines[1].replace('INTEGRITY', 'PRIVACY'), lines[2]].join('\n')
    await expect(DispositionLog.fromJsonl(edited)).rejects.toThrow(/chain is broken/)
    await expect(DispositionLog.fromJsonl([lines[0], lines[2]].join('\n'))).rejects.toThrow(/sequence gap/)
    await expect(DispositionLog.fromJsonl(lines.slice(0, 2).join('\n'), { headHash: log.headHash, entries: 3 })).rejects.toThrow(/signed head/)
  })
})
