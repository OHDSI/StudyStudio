import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { protocolZip, readProtocolFile, type IssuedProtocol } from '@/lib/strategus/protocol'
import { buildStudyPack } from '@/lib/studypack/builder'
import { auditResultFiles } from '@/lib/strategus/results'
import { loadStudyPack, crossCheckSites, siteVerdict } from '@/lib/network/aggregator'
import { evaluateEvidence } from '@/lib/studypack/evidence'
import type { StudyConfig } from '@/types/studypack'

// A real RFC 3161 token over study_config.json, from protocol ZIP to site pack to the Aggregator.
const dir = path.join(__dirname, 'testdata')
const read = (f: string) => new Uint8Array(readFileSync(path.join(dir, f)))
const configBytes = read('study_config.json')
const config = JSON.parse(new TextDecoder().decode(configBytes)) as StudyConfig
const enc = new TextEncoder()

async function packWith(timestamp: Uint8Array) {
  const results = [{ path: 'CohortGeneratorModule/cg_cohort_count.csv', bytes: enc.encode('database_id,cohort_id,cohort_subjects\nX,1,120\n') }]
  const audits = auditResultFiles(results, { minCellCount: 5 })
  const p = await buildStudyPack({
    studyId: 'TS_TEST',
    siteId: 'Site_A',
    cdmVersion: '5.4',
    minCellCount: 5,
    protocolBytes: configBytes,
    protocolTimestampBytes: timestamp,
    files: results.map((r) => ({ path: `results/${r.path}`, role: 'result' as const, originalName: r.path, bytes: r.bytes, audit: audits.get(r.path) })),
  })
  return loadStudyPack(p.zipName, new Uint8Array(await p.zipBlob.arrayBuffer()))
}

describe('protocol time-stamp from issue to adoption', () => {
  it('travels in the protocol ZIP and is checked at the site', async () => {
    const issued: IssuedProtocol = { config, configBytes, files: {}, summary: { modules: [], cohorts: [], negativeControlOutcomes: 0 }, timestamp: read('rsa.tsr') }
    const zip = new Uint8Array(await (await protocolZip(issued)).arrayBuffer())
    const r = await readProtocolFile('TS_TEST_protocol.zip', zip)
    expect(r.errors).toEqual([])
    expect(r.timestampCheck).toMatchObject({ valid: true, tsa: 'Test TSA rsa (Study Studio Test)' })
  })

  it('reports a token that does not cover the protocol', async () => {
    const other = enc.encode('{"studyId":"TS_TEST","cdmVersion":"5.4","minCellCount":3}\n')
    const issued: IssuedProtocol = { config, configBytes: other, files: {}, summary: { modules: [], cohorts: [], negativeControlOutcomes: 0 }, timestamp: read('rsa.tsr') }
    const r = await readProtocolFile('TS_TEST_protocol.zip', new Uint8Array(await (await protocolZip(issued)).arrayBuffer()))
    expect(r.errors).toEqual(['The time-stamp token on study_config.json is invalid: The token covers different data'])
  })

  it('is sealed into the pack and gives the seal a lower bound on the TSA clock', async () => {
    const site = await packWith(read('ec.tsr'))
    expect(site.integrity.status).toBe('verified')
    expect(site.protocolTimestamp).toMatchObject({ valid: true })
    const e = evaluateEvidence({ config, files: site.files, sealedAt: '2099-01-01T00:00:00Z', receivedAt: '2099-01-02T00:00:00Z', protocolTimestamp: site.protocolTimestamp })
    expect(e.timeline.trustedWindow).toMatchObject({ from: site.protocolTimestamp!.genTime, fromSource: 'tsa', toSource: 'device-clock' })
    expect(siteVerdict(site, crossCheckSites([site]), 'TS_TEST', [site]).reasons).not.toContainEqual(expect.stringContaining('time-stamp'))
  })

  it('excludes a pack whose sealed token is invalid', async () => {
    const site = await packWith(read('nocert.tsr'))
    expect(site.protocolTimestamp?.valid).toBe(false)
    const v = siteVerdict(site, crossCheckSites([site]), 'TS_TEST', [site])
    expect(v.recommended).toBe('exclude')
    expect(v.reasons).toContainEqual(expect.stringContaining('Invalid time-stamp token on the sealed protocol'))
  })
})
