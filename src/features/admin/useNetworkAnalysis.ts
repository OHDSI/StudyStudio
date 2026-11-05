import * as React from 'react'
import { useStudyStore } from '@/store/useStudyStore'
import { crossCheckSites, PROTOCOL_KEY_PATHS, siteVerdict } from '@/lib/network/aggregator'
import { evaluateEvidence } from '@/lib/studypack/evidence'
import { withEnrollment } from '@/lib/security/signer'
import { DEFAULT_REASON_CODES } from '@/lib/network/dispositionLog'
import type { SiteRow } from '@/lib/export/regulatory'

/** Derived network state shared by the Aggregator and Export Hub. */
export function useNetworkAnalysis() {
  const sites = useStudyStore((s) => s.sites)
  const config = useStudyStore((s) => s.config)
  const roster = useStudyStore((s) => s.roster)
  const rosterStatus = useStudyStore((s) => s.rosterStatus)
  const log = useStudyStore((s) => s.log)
  const logRev = useStudyStore((s) => s.logRev)
  return React.useMemo(() => {
    const expected = config?.expectedHashes ?? {}
    const sections = config?.protectedSections ?? {}
    const paths = [...new Set([...PROTOCOL_KEY_PATHS, ...Object.keys(expected), ...Object.keys(sections)])]
    const cross = crossCheckSites(sites, expected, sections, paths)
    const decisions = log.decisions()
    // In a regulatory study an enrollment only counts if the roster is signed by the protocol issuer.
    const regulatory = config?.assurance === 'regulatory'
    const rosterIssue = regulatory && roster && rosterStatus?.trust !== 'signed-by-issuer' ? rosterStatus?.message ?? 'The signer roster is not verified' : undefined
    const rows: SiteRow[] = sites.map((site) => {
      // Re-evaluate each pack's evidence under the coordinator's protocol (or the one the site sealed with).
      const evidence = evaluateEvidence({
        config: config ?? site.sealedProtocol,
        files: site.files,
        sealedAt: site.manifest?.sealedAt?.utc ?? site.manifest?.generatedAt,
        receivedAt: site.receivedAt,
      })
      const signatures = withEnrollment(site.signatureChecks, roster, site.siteId, site.receivedAt, rosterIssue)
      const verdict = siteVerdict(site, cross, config?.studyId, sites, { config, evidence, signatures })
      const decision = decisions.get(site.zipSha256)
      return { site, verdict, evidence, signatures, decision, adopted: decision ? decision === 'adopt' : verdict.recommended === 'adopt' }
    })
    const reasonCodes = config?.adoptionPolicy?.reasonCodes ?? DEFAULT_REASON_CODES
    return { sites, cross, rows, paths, config, log, locked: log.locked, reasonCodes, regulatory }
    // logRev changes whenever the (mutable) log is appended to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites, config, roster, rosterStatus, log, logRev])
}
