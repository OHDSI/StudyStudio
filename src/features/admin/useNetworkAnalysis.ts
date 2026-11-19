import * as React from 'react'
import { useStudyStore } from '@/store/useStudyStore'
import { crossCheckSites, protocolKeyPaths, siteVerdict } from '@/lib/network/aggregator'
import { checkPlausibility, type PlausibilityFinding } from '@/lib/network/plausibility'
import { missingAttrition } from '@/lib/network/crossSiteEvidence'
import { evaluateEvidence } from '@/lib/studypack/evidence'
import { withEnrollment } from '@/lib/security/signer'
import { DEFAULT_REASON_CODES } from '@/lib/network/dispositionLog'
import type { SiteRow } from '@/lib/export/regulatory'
import { isRScriptStudy, pinnedFileHashes } from '@/types/studypack'

/** Derived network state shared by the Aggregator and Export Hub. */
export function useNetworkAnalysis() {
  const sites = useStudyStore((s) => s.sites)
  const config = useStudyStore((s) => s.config)
  const roster = useStudyStore((s) => s.roster)
  const rosterStatus = useStudyStore((s) => s.rosterStatus)
  const log = useStudyStore((s) => s.log)
  const logRev = useStudyStore((s) => s.logRev)
  const earlierIssues = useStudyStore((s) => s.earlierIssues)
  return React.useMemo(() => {
    const knownIssues = new Map(earlierIssues.map((e) => [e.sha256, e.config]))
    const expected = pinnedFileHashes(config)
    const sections = config?.protectedSections ?? {}
    const paths = protocolKeyPaths(config, sites)
    const cross = crossCheckSites(sites, expected, sections, paths)
    const plausibility = checkPlausibility(sites)
    const decisions = log.decisions()
    // In a regulatory study an enrollment only counts if the roster is signed by the protocol issuer.
    const regulatory = config?.assurance === 'regulatory'
    const rosterIssue = regulatory && roster && rosterStatus?.trust !== 'signed-by-issuer' ? rosterStatus?.message ?? 'The signer roster is not verified' : undefined
    const rows: SiteRow[] = sites.map((site) => {
      // Re-evaluate each pack's evidence under the coordinator's protocol (or the one the site sealed with).
      // An R script study has no Strategus evidence (DQD, CDM metadata, log, run record) to judge.
      const evidence = isRScriptStudy(config ?? site.sealedProtocol) ? undefined : evaluateEvidence({
        config: config ?? site.sealedProtocol,
        files: site.files,
        sealedAt: site.manifest?.sealedAt?.utc ?? site.manifest?.generatedAt,
        receivedAt: site.receivedAt,
        hashes: { file: site.fileHashes, section: site.sectionHashes },
        declaredModified: (site.manifest?.files ?? []).filter((f) => f.originalCommitment).map((f) => f.path),
      })
      const signatures = withEnrollment(site.signatureChecks, roster, site.siteId, site.receivedAt, rosterIssue)
      const verdict = siteVerdict(site, cross, config?.studyId, sites, { config, evidence, signatures, knownIssues })
      const decision = decisions.get(site.zipSha256)
      // A2: CohortMethod in the specification but no attrition table at this site (for review, never an exclusion).
      const attrition: PlausibilityFinding[] = missingAttrition(site, config ?? site.sealedProtocol)
        ? [{ code: 'attrition-missing', message: 'No CohortMethod attrition table (cm_attrition) although CohortMethod is in the analysis specification' }]
        : []
      return { site, verdict, evidence, signatures, plausibility: [...(plausibility.get(site.key) ?? []), ...attrition], decision, adopted: decision ? decision === 'adopt' : verdict.recommended === 'adopt' }
    })
    const reasonCodes = config?.adoptionPolicy?.reasonCodes ?? DEFAULT_REASON_CODES
    return { sites, cross, rows, paths, config, log, locked: log.locked, reasonCodes, regulatory }
    // logRev changes whenever the (mutable) log is appended to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, config, roster, rosterStatus, log, logRev, earlierIssues])
}
