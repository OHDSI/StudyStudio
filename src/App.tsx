import { Building2, Globe, Hospital, ShieldCheck, WifiOff } from 'lucide-react'
import { useStudyStore } from '@/store/useStudyStore'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { SiteWorkspace } from '@/features/site/SiteWorkspace'
import { AdminWorkspace } from '@/features/admin/AdminWorkspace'
import type { RoleMode } from '@/types/studypack'

function ModeToggle() {
  const mode = useStudyStore((s) => s.mode)
  const setMode = useStudyStore((s) => s.setMode)
  const item = (m: RoleMode, label: string, Icon: typeof Hospital) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        mode === m ? (m === 'site' ? 'bg-emerald-600 text-white shadow' : 'bg-indigo-600 text-white shadow') : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
  )
  return (
    <div className="inline-flex rounded-lg border bg-muted p-1">
      {item('site', 'Site Mode', Hospital)}
      {item('admin', 'Admin Mode', Globe)}
    </div>
  )
}

export default function App() {
  const mode = useStudyStore((s) => s.mode)
  const siteId = useStudyStore((s) => s.siteId)
  const setSiteId = useStudyStore((s) => s.setSiteId)
  const studyId = useStudyStore((s) => s.config?.studyId)

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-6 text-primary" />
            <div>
              <div className="text-base font-bold leading-tight">Study Studio</div>
              <div className="text-[11px] leading-tight text-muted-foreground">OHDSI Study &amp; Regulatory Pack Workspace</div>
            </div>
          </div>
          <ModeToggle />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {mode === 'site' ? (
              <label className="flex items-center gap-2">
                <Building2 className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">Site ID</span>
                <Input className="h-8 w-40" value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="e.g. Site_A" />
              </label>
            ) : (
              <span className="flex items-center gap-2">
                <Building2 className="size-4 text-muted-foreground" />
                <span className="text-muted-foreground">Site ID</span>
                <Badge variant="secondary">NETWORK (coordinator)</Badge>
              </span>
            )}
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">Study ID</span>
              <Badge variant={studyId ? 'default' : 'outline'}>{studyId ?? 'Not set'}</Badge>
            </span>
          </div>
          <Badge variant="outline" className="ml-auto gap-1.5 border-emerald-600/40 text-emerald-700" title="No external communication. All processing stays in this browser's memory.">
            <WifiOff /> Offline · Zero-Transmission
          </Badge>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{mode === 'site' ? <SiteWorkspace /> : <AdminWorkspace />}</main>
      <footer className="mx-auto max-w-7xl px-4 pb-8 text-xs text-muted-foreground">
        Data is processed only in this device's memory and is never sent to any server (Web Crypto API / JSZip / SheetJS / PapaParse).
      </footer>
    </div>
  )
}
