import { describe, expect, it } from 'vitest'
import type { StudyConfig } from '@/types/studypack'
import { evaluateProvenance, parseDatabaseMetaData, softwareVersions } from './cdmSource'
import { buildTimeline, event, parseTime } from './timeline'

const enc = new TextEncoder()
const DBM = 'database_id,cdm_source_name,cdm_version,vocabulary_version,cdm_release_date\nA,Site A EHR,5.4,v5.0 30-AUG-26,2026-09-30\n'
const base = { studyId: 'S', cdmVersion: '5.4', framework: { name: 'Strategus', modules: ['CohortGeneratorModule', 'CohortMethodModule'] } } as unknown as StudyConfig
const files = (extra: Record<string, string> = {}) =>
  Object.fromEntries(
    Object.entries({
      'results/DatabaseMetaData/database_meta_data.csv': DBM,
      'results/CohortGeneratorModule/cg_cohort_count.csv': 'x\n',
      'results/CohortMethodModule/cm_result.csv': 'x\n',
      'code/renv.lock': JSON.stringify({ R: { Version: '4.4.1' }, Packages: { Strategus: { Version: '1.2.0' }, ggplot2: { Version: '3.5.0' } } }),
      ...extra,
    }).map(([k, v]) => [k, enc.encode(v)]),
  )

describe('cdm_source and software provenance', () => {
  it('parses database_meta_data.csv and renv.lock', () => {
    expect(parseDatabaseMetaData(DBM)).toMatchObject({ databaseId: 'A', cdmVersion: '5.4', vocabularyVersion: 'v5.0 30-AUG-26' })
    expect(softwareVersions(JSON.stringify({ R: { Version: '4.4.1' }, Packages: { CohortMethod: { Version: '5.4.0' }, dplyr: { Version: '1' } } }))).toEqual({ r: '4.4.1', packages: { CohortMethod: '5.4.0' } })
  })

  it('is clean when every source agrees', () => {
    const r = evaluateProvenance({ config: base, files: files(), dqd: { cdmSourceName: 'Site A EHR', vocabularyVersion: 'V5.0 30-AUG-26' } })
    expect(r.issues).toEqual([])
    expect(r.software).toEqual({ r: '4.4.1', packages: { Strategus: '1.2.0' } })
  })

  it('flags DQD run on another CDM build, unmet requirements and missing modules (blocking only in regulatory mode)', () => {
    const cfg = { ...base, assurance: 'regulatory', cdmRequirements: { vocabularyVersion: 'v5.0 31-DEC-26' }, framework: { name: 'Strategus', modules: [...base.framework.modules, 'CohortDiagnosticsModule'] } } as StudyConfig
    const r = evaluateProvenance({ config: cfg, files: files(), dqd: { cdmSourceName: 'Other', vocabularyVersion: 'v5.0 01-JAN-26' } })
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
      ['dqd-vocabulary-mismatch', 'block'],
      ['dqd-source-mismatch', 'block'],
      ['vocabulary-requirement', 'block'],
      ['modules-missing', 'block'],
    ])
    const std = evaluateProvenance({ config: { ...cfg, assurance: 'standard' }, files: files(), dqd: { vocabularyVersion: 'v5.0 01-JAN-26' } })
    expect(std.issues.every((i) => i.severity === 'warn')).toBe(true)
  })

  it('reports missing cdm_source', () => {
    const f = files()
    delete f['results/DatabaseMetaData/database_meta_data.csv']
    expect(evaluateProvenance({ config: base, files: f }).issues[0].code).toBe('cdm-source-missing')
  })
})

describe('timeline', () => {
  it('parses the formats DQD, R and cdm_source use', () => {
    expect(parseTime('2026-10-28 09:12:03')).toBe(Date.parse('2026-10-28T09:12:03'))
    expect(parseTime('20260930')).toBe(Date.parse('2026-09-30'))
    expect(parseTime('nonsense')).toBeUndefined()
  })

  it('accepts a possible order and gives the trusted window', () => {
    const t = buildTimeline(
      [
        event('cdmRelease', 'CDM release', '2026-09-30', 'site-tool'),
        event('protocolIssued', 'Protocol issued', '2026-10-01T00:00:00Z', 'coordinator-signed'),
        event('dqdEnd', 'DQD end', '2026-10-28 10:41:55', 'site-tool'),
        event('logFirst', 'Strategus start', '2026-10-29 01:00:00', 'site-tool'),
        event('sealed', 'Sealed', '2026-10-30T00:00:00Z', 'device-clock'),
        event('received', 'Received', '2026-11-01T00:00:00Z', 'device-clock'),
      ].filter((e) => !!e),
      true,
    )
    expect(t.issues).toEqual([])
    expect(t.trustedWindow).toEqual({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' })
    expect(t.events[0].key).toBe('cdmRelease')
  })

  it('flags an impossible order; a seal before the protocol blocks in regulatory mode', () => {
    const t = buildTimeline(
      [event('protocolIssued', 'Protocol issued', '2026-10-10T00:00:00Z', 'coordinator-signed'), event('sealed', 'Sealed', '2026-10-01T00:00:00Z', 'device-clock')].filter((e) => !!e),
      true,
    )
    expect(t.issues).toHaveLength(1)
    expect(t.issues[0].severity).toBe('block')
  })

  it('tolerates zone-less local times within a day', () => {
    const t = buildTimeline([event('logLast', 'Strategus end', '2026-10-30 08:00:00', 'site-tool'), event('sealed', 'Sealed', '2026-10-30T00:00:00Z', 'device-clock')].filter((e) => !!e))
    expect(t.issues).toEqual([])
  })
})
