import { describe, expect, it } from 'vitest'
import { evaluateEvidence, judgeEvidence, type SiteEvidence } from './evidence'

/** Regulatory evidence with nothing loaded, then with the given findings added. */
function withFindings(extra: Partial<Pick<SiteEvidence, 'provenance' | 'runRecord'>> & { dqdBlock?: boolean } = {}): SiteEvidence {
  const e = evaluateEvidence({ config: { assurance: 'regulatory' } as never, files: {}, hashes: { file: {} } })
  return {
    ...e,
    dqdGate: extra.dqdBlock ? { ...e.dqdGate, findings: [{ ruleId: 'R1', severity: 'block', rationale: 'structural check failed' } as never] } : e.dqdGate,
    provenance: extra.provenance ?? { ...e.provenance, issues: [] },
    runRecord: extra.runRecord ?? e.runRecord,
  }
}

describe('judgeEvidence exclusion reasons', () => {
  it('maps each blocker to its pre-specified reason without parsing the message', () => {
    const base = withFindings()
    const e = withFindings({
      dqdBlock: true,
      provenance: {
        ...base.provenance,
        issues: [
          { severity: 'block', code: 'cdm-version-requirement', message: 'Protocol requires CDM 5.4; this database is CDM 5.3' },
          { severity: 'block', code: 'modules-missing', message: 'No results for module(s) in the analysis specification: X' },
        ],
      },
      runRecord: { ...base.runRecord!, issues: [{ severity: 'block', code: 'input-renvLock', message: 'The run used a different renv.lock' }, { severity: 'block', code: 'results-stale', message: 'stale' }] },
    })
    const v = judgeEvidence(e)
    expect(v.blockers).toEqual(v.blocking.map((b) => b.message))
    expect(v.blocking.map((b) => [b.message, b.reason])).toEqual([
      ['Data quality (R1): structural check failed', 'DATA_QUALITY'],
      ['Provenance: Protocol requires CDM 5.4; this database is CDM 5.3', 'CDM_REQUIREMENT'],
      ['Provenance: No results for module(s) in the analysis specification: X', 'PROTOCOL_DEVIATION'],
      ['Strategus execution log is missing (logs/execution.log)', 'PROTOCOL_DEVIATION'],
      ['Run record: The run used a different renv.lock', 'PROTOCOL_DEVIATION'],
      ['Run record: stale', 'INTEGRITY'],
    ])
  })
})
