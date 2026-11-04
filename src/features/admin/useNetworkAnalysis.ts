import * as React from 'react'
import { useStudyStore } from '@/store/useStudyStore'
import { crossCheckSites, PROTOCOL_KEY_PATHS, siteVerdict } from '@/lib/network/aggregator'
import type { SiteRow } from '@/lib/export/regulatory'

/** Derived network state shared by the Aggregator and Export Hub. */
export function useNetworkAnalysis() {
  const sites = useStudyStore((s) => s.sites)
  const config = useStudyStore((s) => s.config)
  const overrides = useStudyStore((s) => s.adoptOverride)
  return React.useMemo(() => {
    const expected = config?.expectedHashes ?? {}
    const sections = config?.protectedSections ?? {}
    const paths = [...new Set([...PROTOCOL_KEY_PATHS, ...Object.keys(expected), ...Object.keys(sections)])]
    const cross = crossCheckSites(sites, expected, sections, paths)
    const rows: SiteRow[] = sites.map((site) => {
      const verdict = siteVerdict(site, cross, config?.studyId, sites)
      return { site, verdict, adopted: overrides[site.key] ?? verdict.recommended === 'adopt' }
    })
    return { sites, cross, rows, paths, config }
  }, [sites, config, overrides])
}
