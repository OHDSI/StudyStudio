import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossCheckSites, loadStudyPack, siteVerdict } from '@/lib/network/aggregator'
import { buildRegulatoryExport } from '@/lib/export/regulatory'
import type { StudyConfig } from '@/types/studypack'
import { issueProtocol, locateStudyRepo, unzipRepo, type ProtocolMeta } from './protocol'
import { issuedProfileRefusals, PROFILE_NOTE, PROFILES, profileRefusals } from './profiles'

const samples = path.resolve(__dirname, '../../../samples')
const repo = async () => locateStudyRepo(await unzipRepo(readFileSync(path.join(samples, 'study-repo.zip'))))
const base: ProtocolMeta = { studyId: 'LEADER_LIKE', studyTitle: 'T', cdmVersion: '5.4', minCellCount: 5, assurance: 'regulatory', now: new Date('2026-11-20T00:00:00Z'), sites: [{ siteId: 'Site_A' }, { siteId: 'Site_B' }] }
const sap = { name: 'sap.pdf', title: 'Statistical analysis plan v1.0', bytes: new TextEncoder().encode('sap') }
const eca: ProtocolMeta = {
  ...base,
  profile: 'eca-comparison',
  sites: [{ siteId: 'Site_A', role: 'treated' }, { siteId: 'Site_B', role: 'external-comparator' }],
  documents: [sap],
  registration: { registry: 'EU PAS Register', id: 'EUPAS000000' },
}
const forbidden = /approved|accepted|compliant|ready for/i

describe('profiles are descriptive presets', () => {
  it('never use designation words in their names, descriptions or note', () => {
    for (const p of Object.values(PROFILES)) {
      expect(p.label).not.toMatch(forbidden)
      for (const r of p.requirements) expect(r).not.toMatch(forbidden)
    }
    expect(PROFILE_NOTE).toMatch(/not a regulatory designation/)
    expect(PROFILE_NOTE).not.toMatch(forbidden)
  })
})

describe('eca-comparison: refused at issue unless its requirements are met', () => {
  it('issues with roles including an external comparator, an analysis-plan document and a registration', async () => {
    const p = await issueProtocol(await repo(), eca)
    expect(p.config.profile).toBe('eca-comparison')
  })
  it.each([
    ['a site without a role', { sites: [{ siteId: 'Site_A' }, { siteId: 'Site_B', role: 'external-comparator' }] }, /give every listed site a role \(missing for Site_A\)/],
    ['no external comparator', { sites: [{ siteId: 'Site_A', role: 'treated' }, { siteId: 'Site_B', role: 'treated' }] }, /at least one listed site needs the role "external-comparator"/],
    ['no plan documents', { documents: undefined }, /pin the plan documents/],
    ['no analysis plan among them', { documents: [{ ...sap, title: 'Study protocol v2' }] }, /titled as an analysis plan/],
    ['no registration', { registration: undefined }, /declare the registration/],
  ])('refuses %s', async (_what, change, message) => {
    await expect(issueProtocol(await repo(), { ...eca, ...change } as ProtocolMeta)).rejects.toThrow(message)
  })
})

describe('pms-db-survey: refused at issue unless its requirements are met', () => {
  it('needs a source release date for every listed site and a data-quality policy', async () => {
    await expect(issueProtocol(await repo(), { ...base, profile: 'pms-db-survey', sites: [{ siteId: 'Site_A', sourceReleaseDate: '2026-09-30' }, { siteId: 'Site_B' }] })).rejects.toThrow(/source release date \(missing for Site_B\)/)
    const ok = await issueProtocol(await repo(), { ...base, profile: 'pms-db-survey', sites: [{ siteId: 'Site_A', sourceReleaseDate: '2026-09-30' }, { siteId: 'Site_B', sourceReleaseDate: '2026-08-31' }] })
    expect(ok.config.profile).toBe('pms-db-survey')
    expect(ok.config.dataQuality).toBeDefined()
    expect(issuedProfileRefusals({ profile: 'pms-db-survey' })).toEqual([expect.stringMatching(/needs a data-quality policy/)])
  })
})

describe('general and standard protocols', () => {
  it('records nothing for the general profile: the protocol is issued exactly as without a profile', async () => {
    const without = await issueProtocol(await repo(), base)
    const general = await issueProtocol(await repo(), { ...base, profile: 'general' })
    expect(general.config).not.toHaveProperty('profile')
    expect(general.configBytes).toEqual(without.configBytes)
  })
  it('refuses a profile on a standard protocol, and an unknown profile', () => {
    expect(profileRefusals({ profile: 'eca-comparison', assurance: 'standard' })).toEqual(['Profiles apply to regulatory assurance only'])
    expect(profileRefusals({ profile: 'something-else', assurance: 'regulatory' })).toEqual(['Unknown profile "something-else"'])
  })
})

describe('profiles in verification and reports', () => {
  const load = async () => {
    const config = JSON.parse(readFileSync(path.join(samples, 'standard/protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'standard/packs')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    return { config, sites, cross }
  }

  it('a pack sealed under a profile this build does not know is handled as general, with a warning', async () => {
    const { config, sites, cross } = await load()
    const a = sites.find((s) => s.siteId === 'Site_A')!
    const future = { ...a, sealedProtocol: { ...a.sealedProtocol!, profile: 'future-profile' } }
    const v = siteVerdict(future, cross, config.studyId, sites, { config })
    expect(v.recommended).toBe('adopt')
    expect(v.codes).toEqual([])
    expect(v.warnings).toContain('Sealed under protocol profile "future-profile", which this build does not know; handled as general')
  })

  it('shows the profile and the requirements in force in the audit report and the reviewer\'s guide', async () => {
    const { config, sites, cross } = await load()
    const rows = sites.filter((s) => s.siteId === 'Site_A').map((s) => ({ site: s, verdict: siteVerdict(s, cross, config.studyId, sites), adopted: true }))
    const withProfile = { ...config, profile: 'eca-comparison' }
    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: withProfile, cross, rows })
    const label = PROFILES['eca-comparison'].label
    expect(out.markdown).toContain(`**Protocol profile:** ${label}. Requirements in force:`)
    expect(out.html).toContain(`Protocol profile: ${label}.`)
    expect(out.reviewersGuide.markdown).toContain(`- **Protocol profile:** ${label}. ${PROFILE_NOTE} Requirements in force:`)
    expect(out.reviewersGuide.markdown).toContain('  - Every listed site has a role, and at least one has the role “external-comparator”')
    // An unknown profile renders as such and is handled as general.
    const unknown = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: { ...config, profile: 'future-profile' }, cross, rows })
    expect(unknown.markdown).toContain('“future-profile” (not known to this build of the tool; handled as general)')
    // No profile recorded: nothing about profiles in the reports.
    const plain = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows })
    expect(plain.markdown).not.toContain('Protocol profile')
    expect(plain.reviewersGuide.markdown).not.toContain('Protocol profile')
  })
})

describe('issue number and the re-issue rule (label-expansion, approval-condition, long-term-follow-up)', () => {
  const doc = (title: string, name = 'doc.pdf') => ({ name, title, bytes: new TextEncoder().encode(title) })
  const valid: Record<string, Partial<ProtocolMeta>> = {
    'label-expansion': { documents: [doc('Study protocol v1.0', 'protocol.pdf'), doc('Statistical analysis plan v1.0', 'sap.pdf')], registration: { registry: 'ClinicalTrials.gov', id: 'NCT00000000' } },
    'approval-condition': { documents: [doc('Approval conditions (commitment letter)')], registration: { registry: 'jRCT', id: 'jRCT0000000000' } },
    'long-term-follow-up': { sites: [{ siteId: 'Site_A', sourceReleaseDate: '2026-09-30' }, { siteId: 'Site_B', sourceReleaseDate: '2026-08-31' }] },
  }
  describe.each(Object.keys(valid))('%s', (profile) => {
    const meta = (extra: Partial<ProtocolMeta>): ProtocolMeta => ({ ...base, profile, ...valid[profile], ...extra })
    it('issues a first issue (number 1, no amendment)', async () => {
      const p = await issueProtocol(await repo(), meta({ issueNumber: 1 }))
      expect(p.config).toMatchObject({ profile, issueNumber: 1 })
      expect(p.config).not.toHaveProperty('amends')
    })
    it('refuses a re-issue (number 2) without the amendment link, saying what is missing', async () => {
      await expect(issueProtocol(await repo(), meta({ issueNumber: 2 }))).rejects.toThrow(/this is issue 2, a re-issue, so it must amend the previous issue/)
    })
    it('issues a re-issue that amends the previous issue', async () => {
      const first = await issueProtocol(await repo(), meta({ issueNumber: 1 }))
      const second = await issueProtocol(await repo(), meta({ issueNumber: 2, now: new Date('2026-11-21T00:00:00Z'), amends: { previousBytes: first.configBytes, summary: 'Extends follow-up' } }))
      expect(second.config).toMatchObject({ issueNumber: 2, amends: { previousIssuedAt: first.config.issuedAt, summary: 'Extends follow-up' } })
    })
    it('refuses a protocol without an issue number', async () => {
      await expect(issueProtocol(await repo(), meta({}))).rejects.toThrow(/enter the issue number \(1 for the first issue\)/)
    })
  })

  it('refuses each profile when its documents or registration are missing', async () => {
    await expect(issueProtocol(await repo(), { ...base, ...valid['label-expansion'], profile: 'label-expansion', issueNumber: 1, documents: [doc('Statistical analysis plan')] })).rejects.toThrow(/titled as the protocol/)
    await expect(issueProtocol(await repo(), { ...base, ...valid['approval-condition'], profile: 'approval-condition', issueNumber: 1, documents: [doc('Study protocol')] })).rejects.toThrow(/titled as the commitment it fulfils/)
    await expect(issueProtocol(await repo(), { ...base, ...valid['approval-condition'], profile: 'approval-condition', issueNumber: 1, registration: undefined })).rejects.toThrow(/declare the registration/)
    await expect(issueProtocol(await repo(), { ...base, profile: 'long-term-follow-up', issueNumber: 1 })).rejects.toThrow(/source release date \(missing for Site_A, Site_B\)/)
  })

  it('leaves general, eca-comparison and pms-db-survey protocols unaffected by the issue number', async () => {
    const pms: ProtocolMeta = { ...base, profile: 'pms-db-survey', sites: valid['long-term-follow-up'].sites }
    for (const m of [base, eca, pms]) {
      // With or without a number, and a re-issue number without an amendment, all issue as before.
      await expect(issueProtocol(await repo(), m)).resolves.toBeDefined()
      const numbered = await issueProtocol(await repo(), { ...m, issueNumber: 2 })
      expect(numbered.config.issueNumber).toBe(2)
    }
    expect((await issueProtocol(await repo(), base)).config).not.toHaveProperty('issueNumber')
  })

  it('rejects an issue number that is not a whole number from 1', async () => {
    await expect(issueProtocol(await repo(), { ...base, issueNumber: 0 })).rejects.toThrow(/whole number, 1 for the first issue/)
    await expect(issueProtocol(await repo(), { ...base, issueNumber: 1.5 })).rejects.toThrow(/whole number/)
  })

  it('shows the issue number with the issue time, and warns (only) for a pack sealed under an issue without a number', async () => {
    const v1Bytes = new Uint8Array(readFileSync(path.join(samples, 'standard/protocol/study_config.json')))
    const v1 = JSON.parse(new TextDecoder().decode(v1Bytes)) as StudyConfig
    const v2 = await issueProtocol(await repo(), {
      ...base, studyId: v1.studyId, profile: 'long-term-follow-up', issueNumber: 2, sites: [{ siteId: 'Site_A', sourceReleaseDate: '2026-09-30' }],
      amends: { previousBytes: v1Bytes, summary: 'Five-year extension' },
    })
    const dir = path.join(samples, 'standard/packs')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, v2.config.expectedHashes, v2.config.protectedSections, [...Object.keys(v2.config.expectedHashes), ...Object.keys(v2.config.protectedSections)])
    const a = sites.find((s) => s.siteId === 'Site_A')!
    const verdict = siteVerdict(a, cross, v1.studyId, sites, { config: { ...v2.config, assurance: 'standard' } })
    expect(verdict.recommended).toBe('adopt')
    expect(verdict.warnings).toContain(`Sealed under an issue without an issue number (issued ${v1.issuedAt}): the re-issue rule of the profile “${PROFILES['long-term-follow-up'].label}” cannot be checked for this pack`)
    const out = await buildRegulatoryExport({ studyId: v1.studyId, studyTitle: v1.studyTitle, config: { ...v2.config, assurance: 'standard' }, cross, rows: [{ site: a, verdict, adopted: true }], protocol: { configBytes: v2.configBytes, files: v2.files } })
    expect(out.markdown).toContain(`- **Protocol issued:** ${v2.config.issuedAt} (issue 2)`)
    expect(out.reviewersGuide.markdown).toContain(`- **Protocol issued:** ${v2.config.issuedAt} (issue 2)`)
    expect(out.reviewersGuide.markdown).toContain(`  - Current issue: issued ${v2.config.issuedAt} (issue 2), SHA-256`)
    // The earlier issue has no number: it is listed by its time alone.
    expect(out.reviewersGuide.markdown).toContain(`  - Amendment N−1: issued ${v1.issuedAt}, SHA-256`)
  })
})
