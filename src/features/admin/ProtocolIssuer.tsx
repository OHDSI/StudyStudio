import * as React from 'react'
import { BookOpen, Download, FileCode2, FolderGit2, Loader2, Stamp } from 'lucide-react'
import { useStudyStore } from '@/store/useStudyStore'
import { issueProtocol, locateStudyRepo, protocolZip, PROTOCOL_PATHS, unzipRepo, type RepoFile } from '@/lib/strategus/protocol'
import { parseAnalysisSpecification, type AnalysisSpecSummary } from '@/lib/strategus/spec'
import { protectedSection, inputMinCellCount, PROTECTED_MARKER } from '@/lib/strategus/executeScript'
import { describeCohort } from '@/lib/codegen/circe'
import { safeId } from '@/lib/studypack/builder'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropZone, type DroppedFile } from '@/features/common/DropZone'
import { Hash } from '@/features/common/Hash'
import { download } from '@/lib/utils'

const num = (v: string, d: number) => (v === '' || Number.isNaN(Number(v)) ? d : Number(v))
const TEMPLATE_URL = 'https://github.com/ohdsi-studies/StrategusStudyRepoTemplate'

export function ProtocolIssuer() {
  const repo = useStudyStore((s) => s.repo)
  const setRepo = useStudyStore((s) => s.setRepo)
  const issued = useStudyStore((s) => s.issued)
  const setIssued = useStudyStore((s) => s.setIssued)
  const setConfig = useStudyStore((s) => s.setConfig)

  const [meta, setMeta] = React.useState({ studyId: '', studyTitle: '', description: '', principalInvestigator: '', sponsor: '', cdmVersion: '5.4', minCellCount: 5 })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [preview, setPreview] = React.useState<string>(PROTOCOL_PATHS.executeAnalyses)

  const summary = React.useMemo<{ spec?: AnalysisSpecSummary; error?: string }>(() => {
    if (!repo?.specText) return {}
    try {
      return { spec: parseAnalysisSpecification(repo.specText) }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [repo])
  const spec = summary.spec
  const hasMarker = repo?.executeText ? protectedSection(repo.executeText) !== undefined : false
  const scriptMin = repo?.executeText ? inputMinCellCount(repo.executeText) : undefined

  const onFiles = async (files: DroppedFile[]) => {
    setError(undefined)
    let list: RepoFile[] = []
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) list.push(...(await unzipRepo(f.bytes)))
      else list.push({ path: f.name, bytes: f.bytes })
    }
    // Merge with already-loaded artifacts so the repo can be assembled from several drops.
    const merged = locateStudyRepo(list)
    const next = {
      specText: merged.specText ?? repo?.specText,
      executeText: merged.executeText ?? repo?.executeText,
      renvText: merged.renvText ?? repo?.renvText,
      studyName: merged.studyName ?? repo?.studyName,
      sources: { ...repo?.sources, ...Object.fromEntries(Object.entries(merged.sources).filter(([, v]) => v)) },
      errors: [] as string[],
    }
    if (!next.specText) next.errors.push('analysisSpecifications.json not found (expected inst/analysisSpecifications.json)')
    if (!next.executeText) next.errors.push('No execution script found (ExecuteAnalyses.R or an .R file calling Strategus::execute())')
    if (!next.renvText) next.errors.push('renv.lock not found')
    setRepo(next)
    if (next.studyName && !meta.studyId) setMeta((m) => ({ ...m, studyId: next.studyName!, studyTitle: m.studyTitle || next.studyName! }))
  }

  const issue = async () => {
    if (!repo) return
    setBusy(true)
    setError(undefined)
    try {
      const p = await issueProtocol(repo, { ...meta, studyId: meta.studyId.trim(), studyTitle: meta.studyTitle.trim() })
      setIssued(p)
      await setConfig(p.config)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const blockers = [
    ...(repo?.errors ?? []),
    ...(summary.error ? [summary.error] : []),
    ...(!meta.studyId.trim() ? ['Enter a Study ID'] : []),
  ]
  const id = safeId(meta.studyId || 'study')
  const dec = new TextDecoder()

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="flex flex-col gap-4 lg:col-span-3">
        <Card>
          <CardHeader>
            <CardTitle><FolderGit2 className="size-5" /> 1. Strategus study repository</CardTitle>
            <CardDescription>
              Design the study in R with the OHDSI{' '}
              <a className="underline" href={TEMPLATE_URL} target="_blank" rel="noreferrer">StrategusStudyRepoTemplate</a>{' '}
              or your own Strategus layout, then drop the repository ZIP (GitHub “Download ZIP”) or its files here: the analysis specification JSON,
              the R script that calls <code>Strategus::execute()</code> (e.g. <code>ExecuteAnalyses.R</code>), <code>renv.lock</code> (and optionally <code>config.yml</code>).
              OHDSI Study Studio does not generate analysis code — it pins and distributes these artifacts.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <DropZone multiple accept=".zip,.json,.R,.r,.lock,.yml" onFiles={onFiles} title="Drop the study repository ZIP or files" hint="Files can be added over several drops" compact />
            {repo && (
              <Table>
                <TableBody>
                  {(Object.keys(PROTOCOL_PATHS) as (keyof typeof PROTOCOL_PATHS)[]).map((k) => (
                    <TableRow key={k} className="text-xs">
                      <TableCell className="font-mono">{PROTOCOL_PATHS[k]}</TableCell>
                      <TableCell>{repo.sources[k] ? <span className="text-muted-foreground">from {repo.sources[k]}</span> : <Badge variant="destructive">missing</Badge>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {repo && (
              <Button variant="ghost" size="sm" className="w-fit" onClick={() => setRepo(undefined)}>Clear</Button>
            )}
          </CardContent>
        </Card>

        {spec && (
          <Card>
            <CardHeader>
              <CardTitle><BookOpen className="size-5" /> 2. Analysis specification</CardTitle>
              <CardDescription>Read-only summary of what every site will run. Edit the design in R and re-drop to change it.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Modules</span>
                {spec.modules.map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
              </div>
              {spec.cohortMethod && (
                <div className="rounded-md border p-3 text-xs">
                  <div className="mb-1 font-medium">CohortMethod — {spec.cohortMethod.analyses.length} analysis setting(s)</div>
                  {spec.cohortMethod.targetComparatorOutcomes.map((t, i) => (
                    <div key={i}>
                      T {t.targetId} vs C {t.comparatorId} → outcomes {t.outcomesOfInterest.join(', ') || '—'} · {t.negativeControlOutcomes} negative controls · {t.excludedCovariateConcepts.toLocaleString()} excluded covariate concepts
                      {t.excludedCovariateConcepts === 0 && <Badge variant="warning" className="ml-2">no covariate exclusions — exposure concepts may enter the PS model</Badge>}
                    </div>
                  ))}
                  {spec.cohortMethod.analyses.map((a) => <div key={a.analysisId} className="text-muted-foreground">#{a.analysisId} {a.description}</div>)}
                </div>
              )}
              {spec.sccs && (
                <div className="rounded-md border p-3 text-xs">
                  <div className="mb-1 font-medium">Self-Controlled Case Series — {spec.sccs.analyses.length} analysis setting(s)</div>
                  {spec.sccs.exposures.map((e) => (
                    <div key={e.exposureId}>Exposure {e.exposureId} → outcomes {e.outcomesOfInterest.join(', ') || '—'} · {e.negativeControlOutcomes} negative controls</div>
                  ))}
                  {spec.sccs.analyses.map((a) => <div key={a.analysisId} className="text-muted-foreground">#{a.analysisId} {a.description}</div>)}
                </div>
              )}
              <div className="text-xs text-muted-foreground">{spec.negativeControlOutcomes} negative control outcome(s) in shared resources</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Cohort</TableHead>
                    <TableHead>Roles</TableHead>
                    <TableHead>Entry criteria</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spec.cohorts.map((c) => (
                    <TableRow key={c.cohortId} className="text-xs">
                      <TableCell className="font-mono">{c.cohortId}</TableCell>
                      <TableCell className="font-medium">{c.cohortName}{c.subset && <Badge variant="outline" className="ml-1">subset</Badge>}</TableCell>
                      <TableCell>{c.roles.join(', ') || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{c.expression ? describeCohort(c.expression) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>3. Study metadata</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            <Field label="Study ID *"><Input value={meta.studyId} onChange={(e) => setMeta({ ...meta, studyId: e.target.value })} placeholder="from config.yml studyName" /></Field>
            <Field label="Study title" className="md:col-span-2"><Input value={meta.studyTitle} onChange={(e) => setMeta({ ...meta, studyTitle: e.target.value })} /></Field>
            <Field label="Principal investigator"><Input value={meta.principalInvestigator} onChange={(e) => setMeta({ ...meta, principalInvestigator: e.target.value })} /></Field>
            <Field label="Sponsor"><Input value={meta.sponsor} onChange={(e) => setMeta({ ...meta, sponsor: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="CDM Version"><Input value={meta.cdmVersion} onChange={(e) => setMeta({ ...meta, cdmVersion: e.target.value })} /></Field>
              <Field label="Min cell count"><Input type="number" min={1} value={meta.minCellCount} onChange={(e) => setMeta({ ...meta, minCellCount: num(e.target.value, 5) })} /></Field>
            </div>
            <Field label="Description" className="md:col-span-3"><Textarea value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field>
            {scriptMin !== undefined && scriptMin < meta.minCellCount && (
              <Alert variant="warning" className="md:col-span-3">
                <AlertDescription>ExecuteAnalyses.R defaults to minCellCount {scriptMin}, below the protocol's {meta.minCellCount}. Sites may export small cells; OHDSI Study Studio will block them, but consider raising the default.</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 lg:col-span-2">
        <Card className="lg:sticky lg:top-24">
          <CardHeader>
            <CardTitle><Stamp className="size-5" /> 4. Issue protocol</CardTitle>
            <CardDescription>
              Pins analysisSpecifications.json and renv.lock (whole-file SHA-256). The execution script is pinned below “{PROTECTED_MARKER}” when that marker is present (sites still fill in their INPUTS block), otherwise as a whole file.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {repo?.executeText && (
              <div className="text-xs text-muted-foreground">
                Execution script: {hasMarker ? <>protected section below “{PROTECTED_MARKER}” will be pinned.</> : <>no “{PROTECTED_MARKER}” marker — the whole file will be pinned, so sites must not edit it (configure via environment variables or config.yml instead).</>}
              </div>
            )}
            {blockers.length > 0 && (
              <Alert variant="warning">
                <AlertDescription>
                  <ul className="list-disc pl-4 text-xs">{blockers.map((e) => <li key={e}>{e}</li>)}</ul>
                </AlertDescription>
              </Alert>
            )}
            <Button disabled={blockers.length > 0 || !repo || busy} onClick={issue}>
              {busy ? <Loader2 className="animate-spin" /> : <Stamp />} Issue protocol
            </Button>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
            {issued && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="success" onClick={async () => download(`${id}_protocol.zip`, await protocolZip(issued))}><Download /> Protocol ZIP for sites</Button>
                  <Button size="sm" variant="outline" onClick={() => download('study_config.json', JSON.stringify(issued.config, null, 2) + '\n', 'application/json')}><Download /> study_config.json</Button>
                </div>
                <div className="text-xs text-muted-foreground">Issued {new Date(issued.config.issuedAt).toLocaleString()} · this config is also used as the Multi-Site Aggregator reference</div>
                <Table>
                  <TableBody>
                    {Object.keys(issued.files).map((p) => (
                      <TableRow key={p} className="text-xs" data-state={preview === p ? 'selected' : undefined}>
                        <TableCell><button className="font-mono hover:underline" onClick={() => setPreview(p)}>{p}</button></TableCell>
                        <TableCell>
                          <Hash value={issued.config.expectedHashes[p] ?? issued.config.protectedSections[p]?.sha256} />
                          {issued.config.protectedSections[p] && <div className="text-[10px] text-muted-foreground">protected section</div>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex items-center gap-2 text-xs font-medium"><FileCode2 className="size-4" /> {preview}<Badge variant="outline" className="ml-auto">preview</Badge></div>
                <pre className="max-h-[420px] overflow-auto rounded-md bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-100">
                  {dec.decode(issued.files[preview]).slice(0, 20000)}
                </pre>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
