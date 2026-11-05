import { describe, expect, it } from 'vitest'
import { auditLog, redactLog } from './logAuditor'

const LOG = [
  '2026-10-29 01:00:00\t[Main thread]\tINFO\tStrategus\texecute\tRunning CohortGeneratorModule',
  '2026-10-29 01:00:01\t[Main thread]\tINFO\tStrategus\texecute\tminCellCount = 5',
  '2026-10-29 01:30:00\t[Main thread]\tWARN\tCohortMethod\tfitOutcomeModel\tHigh correlation between covariate and treatment',
  '2026-10-29 02:00:00\t[Main thread]\tERROR\tSelfControlledCaseSeriesModule\texecute\tFailed to converge',
  'Connecting using PostgreSQL driver: server = "db01.hospital.local/cdm", user = "omop_admin", password = "s3cr3t"',
  'Results written to /home/yamada/acei/results and C:\\Users\\yamada\\results, contact ops@hospital.jp at 10.0.12.5',
  'jdbc:postgresql://db01:5432/cdm?user=omop',
  '2026-10-29 03:15:42\t[Main thread]\tINFO\tStrategus\texecute\tFinished',
].join('\n')

describe('auditLog', () => {
  it('counts levels, extracts times, minCellCount and modules', () => {
    const a = auditLog(LOG)
    expect(a.entries).toBe(5)
    expect(a.firstTimestamp).toBe('2026-10-29 01:00:00')
    expect(a.lastTimestamp).toBe('2026-10-29 03:15:42')
    expect(a.counts.ERROR).toBe(1)
    expect(a.counts.WARN).toBe(1)
    expect(a.errors[0]).toMatchObject({ line: 4, level: 'ERROR' })
    expect(a.minCellCounts).toEqual([5])
    expect(a.modulesMentioned).toEqual(['CohortGeneratorModule', 'SelfControlledCaseSeriesModule'])
  })
})

describe('redactLog', () => {
  it('removes credentials, hosts, user names, e-mail and IPs but keeps the log readable', () => {
    const r = redactLog(LOG)
    for (const secret of ['s3cr3t', 'omop_admin', 'db01.hospital.local', 'yamada', 'ops@hospital.jp', '10.0.12.5', 'db01:5432']) expect(r.text).not.toContain(secret)
    expect(r.text).toContain('password = [REDACTED]')
    expect(r.text).toContain('/home/[REDACTED]/acei/results')
    expect(r.text).toContain('Failed to converge')
    expect(r.summary).toMatchObject({ password: 1, user: 1, 'connection-string': 1, 'home-path': 2, email: 1, 'ip-address': 1, 'jdbc-url': 1 })
    expect(r.redactions.every((x) => x.line >= 1)).toBe(true)
    // Redaction keeps the line count so line numbers in the audit stay valid.
    expect(r.text.split('\n').length).toBe(LOG.split('\n').length)
  })

  it('leaves a clean log unchanged', () => {
    const clean = '2026-10-29 01:00:00 INFO done'
    expect(redactLog(clean)).toEqual({ text: clean, redactions: [], summary: {} })
  })
})
