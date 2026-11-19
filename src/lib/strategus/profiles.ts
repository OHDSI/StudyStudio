/**
 * Use-case profiles for regulatory assurance: presets over the controls of assessment stages 1–4 (site list,
 * plan documents, registration, data-quality policy). A profile adds no mechanism and asks nothing new of
 * sites; its requirements are checked when the protocol is issued. It is a preset of this tool's gates, not a
 * regulatory designation, and says nothing about whether any regulator accepts a study.
 *
 * Profiles whose rules cannot be checked with that machinery are not offered (see docs/regulatory/requirements.md).
 */
import type { ExpectedSite, StudyConfig } from '@/types/studypack'

export const KNOWN_PROFILES = ['general', 'eca-comparison', 'pms-db-survey'] as const
export type ProtocolProfile = (typeof KNOWN_PROFILES)[number]

export interface ProfileDefinition {
  label: string
  /** Plain-language requirements in force, as listed in the reports. */
  requirements: string[]
}

/** Shown next to the selector and in the reports. */
export const PROFILE_NOTE = 'A profile is a preset of this tool’s gates, checked when the protocol is issued. It is not a regulatory designation.'

const BASE = [
  'Coordinator-signed protocol; every StudyPack signed by an enrolled signer',
  'Pre-specified data-quality gate, CDM / vocabulary requirements and exclusion reasons',
  'Run record and execution log required at every site',
  'Participating sites listed at issue; every listed site has a decision or a “not received” entry before the lock',
]

/** A plan document whose title names it as an analysis plan (title containing "analysis plan" or "SAP"). */
export const ANALYSIS_PLAN_TITLE = /analysis plan|\bSAP\b/i

export const PROFILES: Record<ProtocolProfile, ProfileDefinition> = {
  general: { label: 'Regulatory — general', requirements: BASE },
  'eca-comparison': {
    label: 'Regulatory — external-control comparison (provenance emphasis)',
    requirements: [
      ...BASE,
      'Every listed site has a role, and at least one has the role “external-comparator”',
      'Plan documents pinned in the protocol, including one titled as an analysis plan (“analysis plan” or “SAP” in its title)',
      'Registration declared at issue (shown as declared by the coordinator; not verified by the tool)',
    ],
  },
  'pms-db-survey': {
    label: 'Regulatory — post-marketing database survey',
    requirements: [
      ...BASE,
      'Every listed site has the source release date of its database',
      'Data-quality policy present in the protocol',
      'Source release and data cut-off shown per site in the audit report and reviewer’s guide',
    ],
  },
}

export const isKnownProfile = (p: unknown): p is ProtocolProfile => typeof p === 'string' && (KNOWN_PROFILES as readonly string[]).includes(p)

/** Label for a profile as recorded in study_config.json; absent = general; unknown = handled as general. */
export function profileLabel(profile?: string): string {
  if (!profile) return PROFILES.general.label
  return isKnownProfile(profile) ? PROFILES[profile].label : `“${profile}” (not known to this build of the tool; handled as general)`
}

/** Requirements in force under a profile (unknown profiles are handled as general). */
export const profileRequirements = (profile?: string) => PROFILES[isKnownProfile(profile) ? profile : 'general'].requirements

/** Why a protocol cannot be issued under this profile, from what the coordinator entered. */
export function profileRefusals(meta: {
  profile?: string
  assurance?: string
  sites?: ExpectedSite[]
  documents?: { title: string }[]
  registration?: { registry: string; id: string }
}): string[] {
  const p = meta.profile
  if (!p || p === 'general') return []
  if (!isKnownProfile(p)) return [`Unknown profile "${p}"`]
  if (meta.assurance !== 'regulatory') return ['Profiles apply to regulatory assurance only']
  const out: string[] = []
  const label = PROFILES[p].label
  if (p === 'eca-comparison') {
    const missingRole = (meta.sites ?? []).filter((s) => !s.role?.trim()).map((s) => s.siteId)
    if (missingRole.length) out.push(`${label}: give every listed site a role (missing for ${missingRole.join(', ')})`)
    if (!(meta.sites ?? []).some((s) => s.role?.trim().toLowerCase() === 'external-comparator')) out.push(`${label}: at least one listed site needs the role "external-comparator"`)
    if (!meta.documents?.length) out.push(`${label}: pin the plan documents`)
    else if (!meta.documents.some((d) => ANALYSIS_PLAN_TITLE.test(d.title))) out.push(`${label}: one plan document must be titled as an analysis plan ("analysis plan" or "SAP" in its title)`)
    if (!meta.registration?.registry?.trim() || !meta.registration?.id?.trim()) out.push(`${label}: declare the registration`)
  }
  if (p === 'pms-db-survey') {
    const missing = (meta.sites ?? []).filter((s) => !s.sourceReleaseDate?.trim()).map((s) => s.siteId)
    if (missing.length) out.push(`${label}: give every listed site its source release date (missing for ${missing.join(', ')})`)
  }
  return out
}

/** Checks on the issued config itself (fields the tool fills in, such as the data-quality policy). */
export function issuedProfileRefusals(config: Pick<StudyConfig, 'profile' | 'dataQuality'>): string[] {
  if (config.profile === 'pms-db-survey' && !config.dataQuality) return [`${PROFILES['pms-db-survey'].label}: the protocol needs a data-quality policy`]
  return []
}
