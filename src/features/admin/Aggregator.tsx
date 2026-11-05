import * as React from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileJson, ListChecks, PenLine, Trash2, XCircle } from 'lucide-react'
import { useStudyStore } from '@/store/useStudyStore'
import { readProtocolFile } from '@/lib/strategus/protocol'
import { useNetworkAnalysis } from './useNetworkAnalysis'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropZone } from '@/features/common/DropZone'
import { Hash } from '@/features/common/Hash'
import type { HashCheckStatus, LoadedSitePack } from '@/lib/network/aggregator'
import { kidFingerprint, type SignatureCheck } from '@/lib/security/signer'
import type { SiteRow } from '@/lib/export/regulatory'
import { EvidenceView } from '@/features/common/EvidenceView'
import { ActorCard, DecisionCell, DispositionLogCard, LockCard, RosterCard } from './DispositionPanel'

function SignatureBadge({ checks }: { checks?: SignatureCheck[] }) {
  if (!checks?.length) return <Badge variant="outline">Unsigned</Badge>
  if (checks.some((c) => !c.valid)) return <Badge variant="destructive"><XCircle /> Invalid</Badge>
  const enrolled = checks.filter((c) => c.enrolled).length
  return (
    <Badge variant={enrolled ? 'success' : 'warning'} title={checks.map((c) => `${c.signer?.name} (${c.meaning}) ${c.enrolled ? 'enrolled' : c.enrollmentIssue ?? ''}`).join('\n')}>
      <PenLine /> {enrolled}/{checks.length} enrolled
    </Badge>
  )
}

function EvidenceBadge({ row }: { row: SiteRow }) {
  const e = row.evidence
  if (!e) return <span>—</span>
  const blocks = e.dqdGate.counts.block + e.provenance.issues.filter((i) => i.severity === 'block').length + e.timeline.issues.filter((i) => i.severity === 'block').length
  const warns = e.dqdGate.counts.warn + e.provenance.issues.filter((i) => i.severity === 'warn').length + e.timeline.issues.filter((i) => i.severity === 'warn').length
  const regulatory = e.assurance === 'regulatory'
  return (
    <div className="flex flex-col gap-0.5">
      {blocks + warns === 0 ? <Badge variant="success"><CheckCircle2 /> Clean</Badge> : <Badge variant={blocks && regulatory ? 'destructive' : 'warning'}>{blocks ? `${blocks} blocking · ` : ''}{warns} warning(s)</Badge>}
      {row.site.dqd && <span className="text-[10px] text-muted-foreground">DQD {row.site.dqd.percentPassed.toFixed(1)}% passed</span>}
    </div>
  )
}

function HashStatus({ status, hash }: { status?: HashCheckStatus; hash?: string }) {
  if (status === 'match') return <Badge variant="success" title={hash}><CheckCircle2 /> Match</Badge>
  if (status === 'missing') return <Badge variant="warning">Missing</Badge>
  return <Badge variant="destructive" title={hash}><XCircle /> Mismatch</Badge>
}

function IntegrityBadge({ site }: { site: LoadedSitePack }) {
  const i = site.integrity
  if (i.status === 'verified') return <Badge variant="success"><CheckCircle2 /> Verified {i.verifiedCount}</Badge>
  if (i.status === 'tampered') return <Badge variant="destructive"><XCircle /> Tampered</Badge>
  return <Badge variant="destructive"><AlertTriangle /> Invalid</Badge>
}

export function Aggregator() {
  const config = useStudyStore((s) => s.config)
  const setConfig = useStudyStore((s) => s.setConfig)
  const addSitePacks = useStudyStore((s) => s.addSitePacks)
  const removeSite = useStudyStore((s) => s.removeSite)
  const clearSites = useStudyStore((s) => s.clearSites)
  const actor = useStudyStore((s) => s.actor)
  const decide = useStudyStore((s) => s.decide)
  const { sites, cross, rows, paths, locked, reasonCodes, regulatory } = useNetworkAnalysis()
  const [expanded, setExpanded] = React.useState<string>()
  const [msg, setMsg] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)

  const onPacks = async (files: { name: string; bytes: Uint8Array }[]) => {
    setLoading(true)
    try {
      const zips = files.filter((f) => /\.zip$/i.test(f.name))
      const dupes = await addSitePacks(zips).catch((e) => {
        setMsg(e instanceof Error ? e.message : String(e))
        return [] as string[]
      })
      const skipped = files.length - zips.length
      setMsg([dupes.length ? `Skipped duplicates: ${dupes.join(', ')}` : '', skipped ? `Ignored ${skipped} non-ZIP file(s)` : ''].filter(Boolean).join(' / ') || undefined)
    } finally {
      setLoading(false)
    }
  }

  const adoptedCount = rows.filter((r) => r.adopted).length

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ActorCard />
        <RosterCard />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm"><FileJson className="size-4" /> Verification reference (protocol)</CardTitle>
            <CardDescription className="text-xs">Uses the expected hashes in study_config.json. Without it, the majority hash across sites is the reference.</CardDescription>
          </CardHeader>
          <CardContent>
            {config ? (
              <div className="flex flex-col gap-1 text-xs">
                <div className="font-medium">{config.studyId} — {config.studyTitle}</div>
                <div className="text-muted-foreground">{Object.keys(config.expectedHashes).length + Object.keys(config.protectedSections ?? {}).length} pinned hashes · suppress &lt;{config.minCellCount}</div>
                <Button size="sm" variant="ghost" className="w-fit" onClick={() => setConfig(undefined)}>Clear</Button>
              </div>
            ) : (
              <DropZone
                compact
                accept=".json,.zip"
                onFiles={async (fs) => {
                  const r = await readProtocolFile(fs[0].name, fs[0].bytes)
                  if (r.config) await setConfig(r.config, undefined, r)
                  setMsg(r.errors.join(' / ') || undefined)
                }}
                title="Drop study_config.json"
              />
            )}
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm"><ListChecks className="size-4" /> Bulk load site StudyPacks</CardTitle>
            <CardDescription className="text-xs">Drop multiple *.studypack.zip files. They are extracted in memory and every SHA-256 in manifest.json is recomputed to detect tampering.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {actor || !regulatory ? (
              <DropZone multiple accept=".zip" onFiles={onPacks} title={loading ? 'Verifying…' : 'Drop *.studypack.zip'} hint="Load several sites at once — each receipt is recorded in the disposition audit trail" />
            ) : (
              <Alert variant="warning"><AlertDescription>Regulatory study: identify yourself above first — every receipt is recorded with who received it.</AlertDescription></Alert>
            )}
            {msg && <div className="text-xs text-amber-700">{msg}</div>}
          </CardContent>
        </Card>
      </div>

      {sites.length > 0 && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center gap-3">
            <CardTitle>Cross-site verification</CardTitle>
            <Badge variant="secondary">Received {sites.length}</Badge>
            <Badge variant="success">Adopted {adoptedCount}</Badge>
            <Badge variant="destructive">Excluded {sites.length - adoptedCount}</Badge>
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={locked || (regulatory && !actor) || rows.every((r) => r.decision)}
                onClick={async () => {
                  for (const r of rows.filter((x) => !x.decision))
                    await decide(r.site.key, r.verdict.recommended, r.verdict.recommended, r.verdict.recommended === 'exclude' ? r.verdict.codes[0] : undefined).catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
                }}
              >
                Record recommendations for undecided sites
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSites}><Trash2 /> Clear all</Button>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-4 text-xs">
              {paths.map((p) => (
                <div key={p} className="flex items-center gap-2">
                  <code>{p}</code>
                  {cross.references[p]?.kind === 'section' && <span className="text-muted-foreground">(protected section)</span>}
                  <span className="text-muted-foreground">reference:</span>
                  {cross.references[p]?.hash ? <Hash value={cross.references[p].hash} /> : <Badge variant="warning">None (tie)</Badge>}
                  <Badge variant="outline">{cross.references[p]?.source === 'protocol' ? 'Protocol' : cross.references[p]?.source === 'majority' ? 'Majority' : '—'}</Badge>
                </div>
              ))}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>Site</TableHead>
                  <TableHead>manifest</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Signature</TableHead>
                  <TableHead>Quality &amp; provenance</TableHead>
                  <TableHead>Small-cell audit</TableHead>
                  <TableHead>Recommendation</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const { site, verdict, adopted } = row
                  return (
                  <React.Fragment key={site.key}>
                    <TableRow className={adopted ? 'text-xs' : 'bg-destructive/5 text-xs'}>
                      <TableCell>
                        <button onClick={() => setExpanded(expanded === site.key ? undefined : site.key)} aria-label="Details">
                          {expanded === site.key ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{site.siteId}</div>
                        <div className="text-[10px] text-muted-foreground">{site.fileName}</div>
                      </TableCell>
                      <TableCell><IntegrityBadge site={site} /></TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-0.5">
                          {paths.map((p) => (
                            <span key={p} className="flex items-center gap-1">
                              <HashStatus status={cross.perSite[site.key]?.[p]?.status} hash={cross.perSite[site.key]?.[p]?.hash} />
                              <code className="text-[10px] text-muted-foreground">{p.split('/').pop()}</code>
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell><SignatureBadge checks={row.signatures} /></TableCell>
                      <TableCell className="min-w-28"><EvidenceBadge row={row} /></TableCell>
                      <TableCell>
                        {!site.reAudit ? <Badge variant="outline">No results</Badge> : site.reAudit.passed ? <Badge variant="success" title={`${site.reAudit.files} result files`}>Passed ({site.reAudit.files})</Badge> : <Badge variant="destructive">Violations {site.reAudit.smallCellCount + site.reAudit.identifierCount}</Badge>}
                      </TableCell>
                      <TableCell>
                        {verdict.recommended === 'adopt' ? <Badge variant="success">Adopt</Badge> : <Badge variant="destructive" title={verdict.reasons.join('\n')}>❌ Exclude</Badge>}
                      </TableCell>
                      <TableCell>
                        <DecisionCell row={row} reasonCodes={reasonCodes} locked={locked} canDecide={!!actor || !regulatory} />
                      </TableCell>
                      <TableCell>
                        <Button size="icon" variant="ghost" onClick={() => removeSite(site.key)} aria-label="Remove"><Trash2 /></Button>
                      </TableCell>
                    </TableRow>
                    {expanded === site.key && (
                      <TableRow>
                        <TableCell colSpan={10} className="bg-muted/30">
                          <SiteDetails site={site} reasons={verdict.reasons} />
                          <SignatureList checks={row.signatures} />
                          {row.evidence && <div className="mt-3"><EvidenceView evidence={row.evidence} /></div>}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                  )
                })}
              </TableBody>
            </Table>
            {rows.some((r) => r.adopted && r.verdict.recommended === 'exclude') && (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertDescription>A site recommended for exclusion has been adopted. The justification is recorded in the disposition audit trail and the audit report.</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
      {sites.length > 0 && <LockCard rows={rows} regulatory={regulatory} />}
      <DispositionLogCard />
    </div>
  )
}

function SiteDetails({ site, reasons }: { site: LoadedSitePack; reasons: string[] }) {
  const i = site.integrity
  return (
    <div className="grid gap-3 text-xs md:grid-cols-2">
      <div className="flex flex-col gap-1">
        <div><span className="text-muted-foreground">Study ID:</span> {site.studyId || '—'} · <span className="text-muted-foreground">CDM:</span> {site.manifest?.cdmVersion ?? '—'} · <span className="text-muted-foreground">Generated:</span> {site.manifest?.generatedAt ?? '—'}</div>
        <div><span className="text-muted-foreground">ZIP SHA-256:</span> <Hash value={site.zipSha256} full /></div>
        {site.dqd?.cdmSourceName && <div><span className="text-muted-foreground">CDM source:</span> {site.dqd.cdmSourceName}</div>}
        {site.exportedMinCellCount !== undefined && <div><span className="text-muted-foreground">Exported minCellCount:</span> {site.exportedMinCellCount}</div>}
        {site.reAudit && (
          <div>
            <span className="text-muted-foreground">Results re-audit:</span> {site.reAudit.files} files, {site.reAudit.scannedCells.toLocaleString()} cells
            {site.reAudit.failing.map((f) => (
              <div key={f.path} className="text-destructive">❌ results/{f.path}: {f.smallCellCount} small cell(s), {f.identifierCount} identifier column(s)</div>
            ))}
          </div>
        )}
        {reasons.length > 0 && (
          <div className="mt-1">
            <div className="font-medium text-destructive">Reasons for exclusion</div>
            <ul className="list-disc pl-4">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        )}
        {[...i.errors.map((e) => `❌ ${e}`), ...i.mismatched.map((m) => `❌ Hash mismatch ${m.path}: manifest ${m.expected.slice(0, 12)}… / actual ${m.actual.slice(0, 12)}…`), ...i.missing.map((m) => `❌ Listed in manifest but missing: ${m}`), ...i.unlisted.map((m) => `❌ Not listed in manifest: ${m}`)].map((t) => (
          <div key={t} className="text-destructive">{t}</div>
        ))}
      </div>
      <div>
        <div className="mb-1 font-medium">Files ({Object.keys(site.files).length})</div>
        <div className="max-h-48 overflow-auto rounded border bg-background">
          {Object.entries(site.fileHashes).sort().map(([p, h]) => {
            const listed = site.manifest?.files.find((f) => f.path === p)
            const ok = listed && listed.sha256.toLowerCase() === h
            return (
              <div key={p} className="flex items-center justify-between gap-2 border-b px-2 py-1 last:border-0">
                <code className={ok || p === 'manifest.json' ? '' : 'text-destructive'}>{p}</code>
                <Hash value={h} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SignatureList({ checks }: { checks?: SignatureCheck[] }) {
  if (!checks?.length) return null
  return (
    <div className="mt-3 flex flex-col gap-1 text-xs">
      <div className="font-medium">Signatures on manifest.json</div>
      {checks.map((c, i) => (
        <div key={i} className={c.valid && c.enrolled ? 'text-success' : c.valid ? 'text-amber-700' : 'text-destructive'}>
          {c.valid ? '✅' : '❌'} {c.signer?.name ?? '?'} ({c.signer?.organization ?? '?'}, {c.signer?.role ?? '?'}) — {c.meaning ?? '?'} at {c.signedAt ?? '?'} · key {kidFingerprint(c.kid)}
          {c.valid && !c.enrolled && <span> — {c.enrollmentIssue}</span>}
          {c.error && <span> — {c.error}</span>}
        </div>
      ))}
    </div>
  )
}
