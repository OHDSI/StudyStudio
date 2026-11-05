import { ProtocolImport } from './ProtocolImport'
import { ArtifactSlots } from './ArtifactSlots'
import { AuditPanel } from './AuditPanel'
import { PackagePanel } from './PackagePanel'
import { EvidencePanel } from './EvidencePanel'

export function SiteWorkspace() {
  return (
    <div className="flex flex-col gap-8">
      <ProtocolImport />
      <div className="flex flex-col gap-4">
        <ArtifactSlots />
        <AuditPanel />
        <EvidencePanel />
      </div>
      <PackagePanel />
    </div>
  )
}
