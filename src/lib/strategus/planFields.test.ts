import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { amendmentDistance, crossCheckSites, loadStudyPack, protocolKeyPaths, siteVerdict } from '@/lib/network/aggregator'
import { buildRegulatoryExport } from '@/lib/export/regulatory'
import { sha256Hex } from '@/lib/integrity/hasher'
import { pinnedFileHashes, REGISTRATION_LABEL, type StudyConfig } from '@/types/studypack'
import { issueProtocol, issueRefusals, locateStudyRepo, protocolZip, readProtocolFile, unzipRepo } from './protocol'

const samples = path.resolve(__dirname, '../../../samples')
const enc = new TextEncoder()
const v1Bytes = new Uint8Array(readFileSync(path.join(samples, 'standard/protocol/study_config.json')))
const v1 = JSON.parse(new TextDecoder().decode(v1Bytes)) as StudyConfig
const repo = async () => locateStudyRepo(await unzipRepo(readFileSync(path.join(samples, 'study-repo.zip'))))
const meta = { studyId: v1.studyId, studyTitle: v1.studyTitle, cdmVersion: '5.4', minCellCount: 5, now: new Date('2026-11-15T00:00:00Z') }

async function packs() {
  const dir = path.join(samples, 'standard/packs')
  return Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
}
const verdictUnder = (config: StudyConfig, sites: Awaited<ReturnType<typeof packs>>, knownIssues?: Map<string, StudyConfig>) => {
  const cross = crossCheckSites(sites, pinnedFileHashes(config), config.protectedSections, protocolKeyPaths(config, sites))
  return (siteId: string) => siteVerdict(sites.find((s) => s.siteId === siteId)!, cross, config.studyId, sites, { config, knownIssues })
}

describe('P1–P3 at issue', () => {
  it('adds nothing when unused, so a standard protocol is issued as before', async () => {
    const p = await issueProtocol(await repo(), meta)
    for (const k of ['amends', 'documents', 'registration', 'sites']) expect(p.config).not.toHaveProperty(k)
    expect(Object.keys(p.files).some((f) => f.startsWith('docs/'))).toBe(false)
  })

  it('records the amendment, pins and ships the documents, and records the registration, all under the signature', async () => {
    const p = await issueProtocol(await repo(), {
      ...meta,
      amends: { previousBytes: v1Bytes, summary: 'Adds a sensitivity analysis' },
      documents: [{ name: 'SAP v1.pdf', title: 'Statistical analysis plan v1.0', bytes: enc.encode('%PDF-1.7 not parsed') }],
      registration: { registry: 'EU PAS Register', id: 'EUPAS000000', registeredAt: '2026-10-01' },
    })
    expect(p.config.amends).toEqual({ previousSha256: await sha256Hex(v1Bytes), previousIssuedAt: v1.issuedAt, summary: 'Adds a sensitivity analysis' })
    expect(p.config.documents).toEqual([{ path: 'docs/SAP_v1.pdf', sha256: await sha256Hex(enc.encode('%PDF-1.7 not parsed')), title: 'Statistical analysis plan v1.0' }])
    expect(p.config.registration).toEqual({ registry: 'EU PAS Register', id: 'EUPAS000000', registeredAt: '2026-10-01' })
    // The protocol ZIP carries the document, and reading it back keeps it for the site to seal.
    const read = await readProtocolFile('x_protocol.zip', new Uint8Array(await (await protocolZip(p)).arrayBuffer()))
    expect(read.files['docs/SAP_v1.pdf']).toEqual(enc.encode('%PDF-1.7 not parsed'))
  })

  it('refuses an amendment without a summary or for another study, an untitled document and a partial registration', () => {
    expect(issueRefusals({ studyId: v1.studyId, amends: { previousBytes: v1Bytes, summary: ' ' } })).toEqual(['Summarise what the amendment changes'])
    expect(issueRefusals({ studyId: 'OTHER', amends: { previousBytes: v1Bytes, summary: 'x' } })).toEqual([`The previous issue is for study ${v1.studyId}, not OTHER`])
    expect(issueRefusals({ documents: [{ name: 'a.pdf', title: '', bytes: new Uint8Array() }] })).toEqual(['a.pdf: give the document a title'])
    expect(issueRefusals({ registration: { registry: 'EU PAS', id: '' } })).toEqual(['A registration needs both the registry and the registration ID'])
  })
})

describe('P1: packs sealed under an earlier issue', () => {
  it('are reported as sealed under amendment N−1 (a warning), not as a protocol deviation', async () => {
    const sites = await packs()
    const v2 = await issueProtocol(await repo(), { ...meta, amends: { previousBytes: v1Bytes, summary: 'Clarifies the time-at-risk' } })
    const a = verdictUnder(v2.config, sites)('Site_A')
    expect(a.recommended).toBe('adopt')
    expect(a.warnings).toContain(`Sealed under an earlier issue (amendment N−1, issued ${v1.issuedAt})`)
    // The same re-issue without the amendment link leaves the different issue unexplained.
    const unlinked = await issueProtocol(await repo(), meta)
    const b = verdictUnder(unlinked.config, sites)('Site_A')
    expect(b.codes).toContain('PROTOCOL_DEVIATION')
    expect(b.reasons.join()).toMatch(/Sealed with a different protocol issue/)
    // A tampered pack is still excluded for what it is.
    expect(verdictUnder(v2.config, sites)('Site_C').recommended).toBe('exclude')
  })

  it('follows a chain of amendments through issues the coordinator loaded', async () => {
    const sites = await packs()
    const v2 = await issueProtocol(await repo(), { ...meta, amends: { previousBytes: v1Bytes, summary: 'Second issue' } })
    const v3 = await issueProtocol(await repo(), { ...meta, now: new Date('2026-11-16T00:00:00Z'), amends: { previousBytes: v2.configBytes, summary: 'Third issue' } })
    const v2Sha = await sha256Hex(v2.configBytes)
    expect(amendmentDistance(v3.config, await sha256Hex(v1Bytes), new Map([[v2Sha, v2.config]]))).toBe(2)
    expect(verdictUnder(v3.config, sites)('Site_A').codes).toContain('PROTOCOL_DEVIATION')
    expect(verdictUnder(v3.config, sites, new Map([[v2Sha, v2.config]]))('Site_A').warnings).toContain(`Sealed under an earlier issue (amendment N−2, issued ${v1.issuedAt})`)

    const rows = sites.filter((s) => ['Site_A', 'Site_B'].includes(s.siteId)).map((s) => ({ site: s, verdict: verdictUnder(v3.config, sites, new Map([[v2Sha, v2.config]]))(s.siteId), adopted: true }))
    const cross = crossCheckSites(sites, pinnedFileHashes(v3.config), v3.config.protectedSections, protocolKeyPaths(v3.config, sites))
    const out = await buildRegulatoryExport({ studyId: v1.studyId, studyTitle: v1.studyTitle, config: v3.config, cross, rows, protocol: { configBytes: v3.configBytes, files: v3.files }, earlierIssues: [{ sha256: v2Sha, config: v2.config }] })
    const g = out.reviewersGuide.markdown
    expect(g).not.toContain('protocol version(s) and dates')
    expect(g).toContain(`  - Current issue: issued ${v3.config.issuedAt}, SHA-256 \`${await sha256Hex(v3.configBytes)}\`; changes from the previous issue: Third issue`)
    expect(g).toContain(`  - Amendment N−1: issued ${v2.config.issuedAt}, SHA-256 \`${v2Sha}\`; changes from the previous issue: Second issue`)
    expect(g).toContain(`  - Amendment N−2: issued ${v1.issuedAt}, SHA-256 \`${await sha256Hex(v1Bytes)}\``)
    expect(out.markdown).toContain('**Amendment chain:** current:')
  })
})

describe('P2 and P3 through verification and export', () => {
  it('compares plan documents across sites, exports them under protocol/docs/, and labels the registration', async () => {
    const sites = await packs()
    const doc = enc.encode('plan document bytes')
    const v2 = await issueProtocol(await repo(), {
      ...meta,
      amends: { previousBytes: v1Bytes, summary: 'Adds the SAP' },
      documents: [{ name: 'sap.pdf', title: 'Statistical analysis plan', bytes: doc }],
      registration: { registry: 'EU PAS Register', id: 'EUPAS000000' },
    })
    expect(protocolKeyPaths(v2.config, sites)).toContain('docs/sap.pdf')
    // Packs sealed under the earlier issue (which pinned no document) say so instead of a deviation.
    const a = verdictUnder(v2.config, sites)('Site_A')
    expect(a.recommended).toBe('adopt')
    expect(a.warnings).toContain('sap.pdf is not pinned by the earlier issue the pack was sealed under')

    const cross = crossCheckSites(sites, pinnedFileHashes(v2.config), v2.config.protectedSections, protocolKeyPaths(v2.config, sites))
    const rows = sites.filter((s) => s.siteId === 'Site_A').map((s) => ({ site: s, verdict: a, adopted: true }))
    const out = await buildRegulatoryExport({ studyId: v1.studyId, studyTitle: v1.studyTitle, config: v2.config, cross, rows, protocol: { configBytes: v2.configBytes, files: v2.files } })
    const zip = await JSZip.loadAsync(await out.zipBlob.arrayBuffer())
    expect(await zip.file(`${v1.studyId}-submission/protocol/docs/sap.pdf`)!.async('uint8array')).toEqual(doc)
    const label = `EU PAS Register EUPAS000000 — ${REGISTRATION_LABEL}`
    expect(REGISTRATION_LABEL).toBe('as declared by the coordinator; not verified by the tool')
    expect(out.markdown).toContain(`**Registration:** ${label}`)
    expect(out.html).toContain(`Registration: ${label}`)
    expect(out.reviewersGuide.markdown).toContain(`- **Registration:** ${label}`)
    expect(out.reviewersGuide.markdown).toContain('- **Plan document:** Statistical analysis plan (`protocol/docs/sap.pdf`')
  })
})

describe('P2 at the site', () => {
  it('asks nothing of the site, and warns only when a document did not arrive with the protocol', async () => {
    const { evaluateReadiness } = await import('@/lib/studypack/readiness')
    const config = { ...v1, documents: [{ path: 'docs/sap.pdf', sha256: 'a'.repeat(64), title: 'SAP' }] }
    const missing = evaluateReadiness({ siteId: 'Site_A', config, slots: {}, results: {}, protocolFilePaths: [] })
    expect(missing.warnings.join()).toMatch(/docs\/sap.pdf were not in the imported protocol/)
    const arrived = evaluateReadiness({ siteId: 'Site_A', config, slots: {}, results: {}, protocolFilePaths: ['docs/sap.pdf'] })
    expect(arrived.warnings.join()).not.toMatch(/docs\/sap.pdf/)
    expect(arrived.blockers).toEqual(evaluateReadiness({ siteId: 'Site_A', config: v1, slots: {}, results: {} }).blockers)
  })
})
