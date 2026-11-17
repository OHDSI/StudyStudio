import { describe, expect, it } from 'vitest'
import { clockDiscrepancy, clockDiscrepancyMessage } from './deviceClock'
import { evaluateEvidence } from '@/lib/studypack/evidence'

const now = Date.parse('2026-11-18T00:00:00Z')

describe('device clock discrepancy', () => {
  it('reports the file most in the future when it exceeds the tolerance', () => {
    const d = clockDiscrepancy([{ name: 'a.csv', lastModified: now + 60_000 }, { name: 'b.csv', lastModified: now + 3_600_000 }, { name: 'c.csv' }], now)
    expect(d).toEqual({ file: 'b.csv', modifiedAt: '2026-11-18T01:00:00.000Z', observedAt: '2026-11-18T00:00:00.000Z', behindMinutes: 60 })
    expect(clockDiscrepancyMessage(d!)).toContain('about 60 minute(s) behind')
  })

  it('ignores ordinary drift and files from the past', () => {
    expect(clockDiscrepancy([{ name: 'a.csv', lastModified: now + 4 * 60_000 }, { name: 'b.csv', lastModified: now - 86_400_000 }], now)).toBeUndefined()
    expect(clockDiscrepancy([], now)).toBeUndefined()
  })

  it('becomes a warning in the evidence, never a blocker', () => {
    const d = clockDiscrepancy([{ name: 'cm_result.csv', lastModified: now + 3_600_000 }], now)!
    const e = evaluateEvidence({ config: { assurance: 'regulatory' } as never, files: {}, clockDiscrepancy: d })
    expect(e.timeline.issues).toContainEqual({ severity: 'warn', message: clockDiscrepancyMessage(d) })
  })
})
