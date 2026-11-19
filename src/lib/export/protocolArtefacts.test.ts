import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { crossCheckSites, loadStudyPack, siteVerdict } from '@/lib/network/aggregator'
import { DispositionLog } from '@/lib/network/dispositionLog'
import { sha256Hex } from '@/lib/integrity/hasher'
import { protectedSectionHash } from '@/lib/strategus/executeScript'
import { PROTOCOL_PATHS, readProtocolFile } from '@/lib/strategus/protocol'
import type { StudyPackManifest } from '@/types/studypack'
import { buildRegulatoryExport } from './regulatory'

const samples = path.resolve(__dirname, '../../../samples')
const reg = path.join(samples, 'regulatory')
const dec = new TextDecoder()

async function regulatoryNetwork() {
  const protocol = await readProtocolFile('ACEI_ANGIO_2026_protocol.zip', readFileSync(path.join(reg, 'protocol/ACEI_ANGIO_2026_protocol.zip')))
  const config = protocol.config!
  const dir = path.join(reg, 'packs')
  const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
  const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
  const log = new DispositionLog()
  const actor = { name: 'Coordinator', role: 'coordinator', organization: 'Net' }
  const rows = []
  for (const s of sites) {
    const adopt = s.siteId === 'Site_A' || s.siteId === 'Site_B'
    const verdict = siteVerdict(s, cross, config.studyId, sites, { config })
    await log.append({ actor, action: adopt ? 'adopt' : 'exclude', siteId: s.siteId, packSha256: s.zipSha256, from: 'undecided', to: adopt ? 'adopt' : 'exclude', recommended: adopt ? 'adopt' : 'exclude', reasonCode: adopt ? undefined : 'INTEGRITY' })
    rows.push({ site: s, verdict, decision: adopt ? ('adopt' as const) : ('exclude' as const), adopted: adopt })
  }
  await log.append({ actor, action: 'lock', reasonText: 'attested' })
  const disposition = { entries: log.entries, jsonl: log.toJsonl(), headHash: log.headHash, head: log.headBytes(config.studyId) }
  const roster = { bytes: new Uint8Array(readFileSync(path.join(reg, 'roster/signer_roster.json'))), signatureBytes: new Uint8Array(readFileSync(path.join(reg, 'roster/signer_roster.jws.json'))) }
  return { protocol, config, sites, cross, rows, disposition, roster }
}

describe('C1: the submission package contains the protocol files its hashes refer to', () => {
  it('ships study_config.json, its signature, the pinned files and the roster, matching every site manifest', async () => {
    const n = await regulatoryNetwork()
    const out = await buildRegulatoryExport({
      studyId: n.config.studyId, studyTitle: n.config.studyTitle, config: n.config, cross: n.cross, rows: n.rows, disposition: n.disposition,
      protocol: { configBytes: n.protocol.configBytes, signatureBytes: n.protocol.signatureBytes, files: n.protocol.files },
      roster: n.roster,
    })
    const zip = await JSZip.loadAsync(await out.zipBlob.arrayBuffer())
    const root = 'ACEI_ANGIO_2026-submission/'
    const read = async (p: string) => zip.file(root + p)!.async('uint8array')
    for (const p of ['protocol/study_config.json', 'protocol/study_config.jws.json', 'protocol/analysisSpecifications.json', 'protocol/renv.lock', 'protocol/ExecuteAnalyses.R', 'roster/signer_roster.json', 'roster/signer_roster.jws.json'])
      expect(out.manifest.files.map((f) => f.path)).toContain(p)

    // Each adopted site's manifest hash of a protocol file resolves to a file in the package.
    const inPackage: Record<string, string> = {
      'protocol/study_config.json': 'protocol/study_config.json',
      'protocol/study_config.jws.json': 'protocol/study_config.jws.json',
      [PROTOCOL_PATHS.analysisSpecifications]: 'protocol/analysisSpecifications.json',
      [PROTOCOL_PATHS.renvLock]: 'protocol/renv.lock',
    }
    for (const r of n.rows.filter((x) => x.adopted)) {
      const manifest = JSON.parse(dec.decode(await read(`sites/${r.site.siteId}/manifest.json`))) as StudyPackManifest
      for (const [sitePath, pkgPath] of Object.entries(inPackage)) expect(manifest.files.find((f) => f.path === sitePath)?.sha256).toBe(await sha256Hex(await read(pkgPath)))
      // The execution script differs above the marker (each site's INPUTS block); its protected section is what is pinned.
      const section = n.config.protectedSections[PROTOCOL_PATHS.executeAnalyses]
      expect(await protectedSectionHash(dec.decode(r.site.files[PROTOCOL_PATHS.executeAnalyses]), section.marker)).toBe(await protectedSectionHash(dec.decode(await read('protocol/ExecuteAnalyses.R')), section.marker))
    }
    expect(out.markdown).toContain('### Protocol artefacts in this package')
    expect(out.markdown).toContain('coordinator signature verified')
    expect((await loadStudyPack(out.zipName, await out.zipBlob.arrayBuffer())).integrity.status).toBe('verified')
  })

  it('refuses a regulatory export when a protocol file does not match its pinned hash', async () => {
    const n = await regulatoryNetwork()
    const files = { ...n.protocol.files, [PROTOCOL_PATHS.analysisSpecifications]: new TextEncoder().encode('{"tampered":true}') }
    const params = { studyId: n.config.studyId, studyTitle: n.config.studyTitle, cross: n.cross, rows: n.rows, disposition: n.disposition, protocol: { configBytes: n.protocol.configBytes, signatureBytes: n.protocol.signatureBytes, files } }
    await expect(buildRegulatoryExport({ ...params, config: n.config })).rejects.toThrow(/protocol artefacts do not match the protocol: analysisSpecifications.json does not match/)
    // A standard study leaves the file out and says so in the audit report.
    const std = await buildRegulatoryExport({ ...params, config: { ...n.config, assurance: 'standard' }, protocol: { files } })
    expect(std.manifest.files.map((f) => f.path)).not.toContain('protocol/analysisSpecifications.json')
    expect(std.markdown).toMatch(/protocol\/analysisSpecifications.json` \| — \| ❌ not included/)
  })

  it('refuses a study_config.json whose coordinator signature does not verify', async () => {
    const n = await regulatoryNetwork()
    const configBytes = new TextEncoder().encode(dec.decode(n.protocol.configBytes!).replace('"minCellCount": 5', '"minCellCount": 1'))
    await expect(
      buildRegulatoryExport({ studyId: n.config.studyId, studyTitle: n.config.studyTitle, config: n.config, cross: n.cross, rows: n.rows, disposition: n.disposition, protocol: { configBytes, signatureBytes: n.protocol.signatureBytes, files: n.protocol.files } }),
    ).rejects.toThrow(/invalid coordinator signature/)
  })
})
