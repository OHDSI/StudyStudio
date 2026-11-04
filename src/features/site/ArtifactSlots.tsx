import { AlertTriangle, CheckCircle2, FileCheck2, FolderOpen, Loader2, ShieldAlert, Trash2, XCircle } from 'lucide-react'
import { useStudyStore, type SlotFile } from '@/store/useStudyStore'
import { SITE_PRODUCED_SLOTS, SLOT_BY_ID, SLOTS, planBulkIngest, type SlotDef, type SlotId } from '@/lib/studypack/slots'
import { readResultsZip, resultFilesFromList, moduleOf, RDMS_FILE } from '@/lib/strategus/results'
import { hashesEqual } from '@/lib/integrity/hasher'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DropZone, type DroppedFile } from '@/features/common/DropZone'
import { Hash } from '@/features/common/Hash'
import { StepHeader } from '@/features/common/StepHeader'
import { cn, formatBytes } from '@/lib/utils'
import * as React from 'react'

const GROUPS: { dir: string; title: string }[] = [
  { dir: 'etl', title: 'etl/ — upstream ETL' },
  { dir: 'evidence', title: 'evidence/ — quality evidence' },
  { dir: 'definitions', title: 'definitions/ — Strategus analysis specification (from protocol)' },
  { dir: 'code', title: 'code/ — execution script, dependencies and settings' },
]

function SlotStatus({ file, expected, sectionHash }: { file?: SlotFile; expected?: string; sectionHash?: string }) {
  if (!file) return <Badge variant="outline">Empty</Badge>
  if (file.error) return <Badge variant="destructive"><XCircle /> Error</Badge>
  if (file.audit && !file.audit.passed) return <Badge variant="destructive"><ShieldAlert /> Violations {file.audit.findings.length}</Badge>
  const pinned = expected ?? sectionHash
  const actual = expected ? file.sha256 : file.protectedSha256
  if (pinned && !hashesEqual(pinned, actual)) return <Badge variant="warning"><AlertTriangle /> Protocol mismatch</Badge>
  if (pinned) return <Badge variant="success"><CheckCircle2 /> Protocol match</Badge>
  if (file.audit?.passed) return <Badge variant="success"><CheckCircle2 /> Audit passed</Badge>
  return <Badge variant="secondary"><FileCheck2 /> Loaded</Badge>
}

function SlotCard({ slot }: { slot: SlotDef }) {
  const file = useStudyStore((s) => s.slots[slot.id])
  const busy = useStudyStore((s) => s.busy[slot.id])
  const expected = useStudyStore((s) => s.config?.expectedHashes?.[slot.path])
  const section = useStudyStore((s) => s.config?.protectedSections?.[slot.path])
  const ingest = useStudyStore((s) => s.ingest)
  const remove = useStudyStore((s) => s.remove)
  const bad = !!file && (!!file.error || (file.audit && !file.audit.passed))
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border bg-background p-3', bad && 'border-destructive/60 bg-destructive/5')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold">{slot.label}</div>
          <div className="text-xs text-muted-foreground">{slot.description}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {slot.required && <Badge variant="outline" className="text-[10px]">Required</Badge>}
          {slot.audited && <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-700">Audited</Badge>}
        </div>
      </div>
      {file ? (
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate" title={file.name}>{file.name}{file.fromProtocol && <span className="ml-1 text-muted-foreground">(from protocol)</span>}</span>
            <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Hash value={section ? file.protectedSha256 : file.sha256} />
            <div className="flex items-center gap-1">
              {file.remediated && <Badge variant="secondary" className="text-[10px]">Masked</Badge>}
              <SlotStatus file={file} expected={expected} sectionHash={section?.sha256} />
              <Button size="icon" variant="ghost" onClick={() => remove(slot.id)} aria-label="Remove"><Trash2 /></Button>
            </div>
          </div>
          {section && <div className="text-[11px] text-muted-foreground">Hash shown is the protected section below “{section.marker}”; your INPUTS block may differ.</div>}
          {file.error && <div className="text-destructive">{file.error}</div>}
        </div>
      ) : (
        <DropZone compact accept={slot.accept.join(',')} onFiles={async (fs) => ingest(slot.id, fs[0].name.split('/').pop()!, fs[0].bytes)}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <span className="text-xs text-muted-foreground">Drop or click to choose ({slot.accept.join(', ')})</span>}
        </DropZone>
      )}
    </div>
  )
}

/** Load a Strategus results archive (Strategus::zipResults) or a dropped/selected results folder. */
export async function loadResults(files: DroppedFile[], ingestResults: (source: string, f: { path: string; bytes: Uint8Array }[]) => Promise<void>) {
  const zips = files.filter((f) => /\.zip$/i.test(f.name))
  if (zips.length) {
    const z = zips[0]
    return ingestResults(z.name, await readResultsZip(z.bytes))
  }
  const csvs = files.filter((f) => /\.csv$/i.test(f.name))
  const root = csvs[0]?.name.includes('/') ? csvs[0].name.split('/')[0] : 'selected files'
  return ingestResults(root, resultFilesFromList(csvs))
}

function ResultsBundleCard() {
  const results = useStudyStore((s) => s.results)
  const busy = useStudyStore((s) => s.busy.results)
  const ingestResults = useStudyStore((s) => s.ingestResults)
  const removeResults = useStudyStore((s) => s.removeResults)
  const files = Object.entries(results?.files ?? {})
  const modules = [...new Set(files.map(([p]) => moduleOf(p)))]
  const failing = files.filter(([, f]) => f.audit && !f.audit.passed).length
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border bg-background p-3', failing > 0 && 'border-destructive/60 bg-destructive/5')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-xs font-semibold">Strategus results</div>
          <div className="text-xs text-muted-foreground">
            The <code>results/&lt;databaseName&gt;</code> folder written by <code>Strategus::execute()</code>, or the ZIP from <code>Strategus::zipResults()</code>. Every CSV is audited; columns flagged <code>min_cell_count</code> in each module's <code>{RDMS_FILE}</code> are checked exactly.
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge variant="outline" className="text-[10px]">Required</Badge>
          <Badge variant="outline" className="border-amber-500/50 text-[10px] text-amber-700">Audited</Badge>
        </div>
      </div>
      {results ? (
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{results.source}</span>
            <span className="text-muted-foreground">{files.length} CSV · {modules.length} module(s)</span>
            {failing ? <Badge variant="destructive"><ShieldAlert /> {failing} file(s) with violations</Badge> : <Badge variant="success"><CheckCircle2 /> Audit passed</Badge>}
            <Button size="icon" variant="ghost" className="ml-auto" onClick={removeResults} aria-label="Remove results"><Trash2 /></Button>
          </div>
          <div className="flex flex-wrap gap-1">
            {modules.map((m) => (
              <Badge key={m} variant="outline">{m} ({files.filter(([p]) => moduleOf(p) === m).length})</Badge>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          <DropZone compact multiple accept=".zip,.csv" onFiles={(fs) => loadResults(fs, ingestResults)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <span className="text-xs text-muted-foreground">Drop the results ZIP or results folder</span>}
          </DropZone>
          <DropZone compact directory onFiles={(fs) => loadResults(fs, ingestResults)}>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><FolderOpen className="size-4" /> Choose results folder…</span>
          </DropZone>
        </div>
      )}
    </div>
  )
}

export function ArtifactSlots() {
  const ingest = useStudyStore((s) => s.ingest)
  const ingestResults = useStudyStore((s) => s.ingestResults)
  const filled = useStudyStore((s) => Object.keys(s.slots).length + (s.results ? 1 : 0))
  const [unknown, setUnknown] = React.useState<string[]>([])
  const [protectedNames, setProtectedNames] = React.useState<string[]>([])
  return (
    <section>
      <StepHeader n={2} title="Artifact Ingestion & Real-Time Audit" description="Drag & drop into each slot. SHA-256 hashing and the small-cell / direct-identifier audit run as soon as a file is loaded." done={filled > 0} />
      <Card>
        <CardContent className="flex flex-col gap-5 pt-5">
          <DropZone
            multiple
            title="Drop multiple files at once (auto-assigned by file name)"
            hint={`Site-produced artifacts: ${SITE_PRODUCED_SLOTS.map((id) => SLOT_BY_ID[id].label).join(', ')}, and the Strategus results ZIP. The analysis specification, ExecuteAnalyses.R and renv.lock come from the protocol ZIP.`}
            onFiles={async (fs) => {
              const slots = useStudyStore.getState().slots
              const protocolFilled = new Set((Object.keys(slots) as SlotId[]).filter((id) => slots[id]?.fromProtocol))
              const plan = planBulkIngest(fs.map((f) => f.name), protocolFilled)
              for (const a of plan.assign) {
                const f = fs.find((x) => x.name === a.name)!
                await ingest(a.slotId, f.name.split('/').pop()!, f.bytes)
              }
              const archive = fs.find((f) => plan.resultsArchives.includes(f.name))
              if (archive) await loadResults([archive], ingestResults)
              setUnknown(plan.unknown)
              setProtectedNames(plan.protectedByProtocol.map((p) => p.name))
            }}
          />
          {protectedNames.length > 0 && (
            <div className="text-xs text-amber-700">
              Skipped {protectedNames.join(', ')}: already provided by the protocol. To replace a protocol file, remove it from its slot and drop the new file there (it will be flagged if its hash differs from the protocol).
            </div>
          )}
          {unknown.length > 0 && <div className="text-xs text-amber-700">Could not assign: {unknown.join(', ')} (drop them into a specific slot; result CSVs go into “Strategus results”)</div>}
          {GROUPS.map((g) => (
            <div key={g.dir}>
              <div className="mb-2 font-mono text-xs font-semibold text-muted-foreground">{g.title}</div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {SLOTS.filter((s) => s.path.startsWith(g.dir + '/')).map((s) => (
                  <SlotCard key={s.id} slot={s} />
                ))}
              </div>
            </div>
          ))}
          <div>
            <div className="mb-2 font-mono text-xs font-semibold text-muted-foreground">results/ — Strategus results (zero-PHI)</div>
            <ResultsBundleCard />
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
