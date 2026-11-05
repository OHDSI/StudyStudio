import * as React from 'react'
import { ClipboardCheck } from 'lucide-react'
import { siteFiles, useStudyStore } from '@/store/useStudyStore'
import { evaluateEvidence } from '@/lib/studypack/evidence'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EvidenceView } from '@/features/common/EvidenceView'

/** Live preview of the evidence that will be sealed (data quality, provenance, log, time). */
export function EvidencePanel() {
  const config = useStudyStore((s) => s.config)
  const slots = useStudyStore((s) => s.slots)
  const results = useStudyStore((s) => s.results)
  const evidence = React.useMemo(() => evaluateEvidence({ config, files: siteFiles({ slots, results }) }), [config, slots, results])
  if (!config || !results) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <ClipboardCheck className="size-5" /> Data quality &amp; provenance evidence
          <Badge variant={evidence.assurance === 'regulatory' ? 'default' : 'outline'} className="ml-2">{evidence.assurance} assurance</Badge>
        </CardTitle>
        <CardDescription>
          Sealed into audit_report.json and re-checked by the coordinator. {evidence.assurance === 'regulatory' ? 'In a regulatory study, red items block packaging.' : 'In a standard study these are warnings only.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <EvidenceView evidence={evidence} />
      </CardContent>
    </Card>
  )
}
