import * as React from 'react'
import { Download, FileCode, FileText, Loader2, Package, Printer, ScrollText, Trash2 } from 'lucide-react'
import { useNetworkAnalysis } from './useNetworkAnalysis'
import { useStudyStore } from '@/store/useStudyStore'
import { addSignature } from '@/lib/security/signer'
import { datasetFiles, DEFAULT_ADAM_CT_VERSION, type DatasetFormat } from '@/lib/cdisc/defineXml'
import { AGENCIES, AGENCY_LABELS, AGENCY_NOTES, type Agency } from '@/lib/cdisc/validatorProfiles'
import { buildHtmlReport, buildMarkdownReport, buildRegulatoryExport, datasetFormatLabel, listResultTables, PROFILE_LABELS, reviewersGuideFor, SUBMISSION_PROFILES, type RegulatoryExport, type SubmissionProfile } from '@/lib/export/regulatory'
import { parseP21Report, reportMismatches, runLabel, type ValidatorRun } from '@/lib/cdisc/p21Report'
import { DropZone, type DroppedFile } from '@/features/common/DropZone'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Hash } from '@/features/common/Hash'
import { MarkdownPreview } from '@/features/common/MarkdownPreview'
import { download, formatBytes } from '@/lib/utils'
import { safeId } from '@/lib/studypack/builder'
import { DEFINE_XML_VERSIONS, type DefineXmlVersion } from '@/lib/cdisc/defineXml'
import { DATASET_JSON_VERSIONS, type DatasetJsonVersion } from '@/lib/cdisc/datasetJson'

const PROFILE_NOTES: Record<SubmissionProfile, string> = {
  'aggregated-results':
    'Recommended. The datasets are presented as what they are: aggregated results, not SDTM or ADaM data. define.xml, the datasets and a readable data definition go in misc/ as non-standard data; do not tag them as ADaM. The reviewer\'s guide says where the package belongs (FDA eCTD 5.3.5.4, PMDA misc folder) for you to confirm with the agency.',
  'adam-other':
    'Only if the agency asks for ADaM: the datasets are declared as non-standard "ADAM OTHER" datasets of an ADaM submission. Validators then report a missing ADSL (AD0001, Reject), which the reviewer\'s guide explains.',
}

const DEFINE_NOTES: Record<DefineXmlVersion, string> = {
  '2.1': 'Current CDISC release. OMOP datasets are flagged def:IsNonStandard="Yes".',
  '2.0': 'For reviewers that still require v2.0. Non-standard datasets cannot be flagged: the whole file is declared as ADaM-IG 1.3.',
}
/** Dataset format choices: Dataset-JSON per version, or SAS V5 transport. */
const DATASET_CHOICES = [...DATASET_JSON_VERSIONS.map((v) => `json-${v}` as const), 'xpt'] as const
type DatasetChoice = (typeof DATASET_CHOICES)[number]
const DATASET_NOTES: Record<DatasetChoice, string> = {
  'json-1.1': 'Current CDISC release (flat columns / rows).',
  'json-1.0': 'Legacy layout (clinicalData.itemGroupData with ITEMGROUPDATASEQ).',
  xpt: 'SAS Version 5 transport files, the format most agencies expect, and the one the PMDA validator reads. Dataset and variable names become the 8-character SAS names; text is limited to 200 bytes.',
}

/** Open the HTML report in a new window and trigger the browser's print dialog (Save as PDF). */
function printHtml(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const w = window.open(url, '_blank')
  if (w) w.addEventListener('load', () => w.print())
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function ExportHub() {
  const { rows, cross, config, sites, log, locked, regulatory } = useNetworkAnalysis()
  const logExport = useStudyStore((s) => s.logExport)
  const coordinator = useStudyStore((s) => s.signers.find((x) => x.signer.signer.role === 'coordinator')?.signer)
  const [out, setOut] = React.useState<RegulatoryExport>()
  /** Reports of validator runs on the generated package; they complete the reviewer's guide. */
  const [runs, setRuns] = React.useState<ValidatorRun[]>([])
  const [runError, setRunError] = React.useState<string>()
  React.useEffect(() => {
    setRuns([])
    setRunError(undefined)
  }, [out])
  const guide = React.useMemo(() => (out ? reviewersGuideFor(out.reviewersGuideInput, runs) : undefined), [out, runs])
  const addReports = (files: DroppedFile[]) => {
    const errors: string[] = []
    const added: ValidatorRun[] = []
    for (const f of files)
      try {
        added.push(parseP21Report(f.name.split('/').pop()!, f.bytes))
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    setRuns((r) => [...r.filter((x) => !added.some((a) => a.file === x.file)), ...added])
    setRunError(errors.length ? errors.join('; ') : undefined)
  }
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [defineXmlVersion, setDefineXmlVersion] = React.useState<DefineXmlVersion>('2.1')
  const [profile, setProfile] = React.useState<SubmissionProfile>('aggregated-results')
  const [datasetChoice, setDatasetChoice] = React.useState<DatasetChoice>('json-1.1')
  const datasetFormat: DatasetFormat = datasetChoice === 'xpt' ? 'xpt' : 'dataset-json'
  const datasetJsonVersion: DatasetJsonVersion = datasetChoice === 'json-1.0' ? '1.0' : '1.1'
  const [ctVersion, setCtVersion] = React.useState(DEFAULT_ADAM_CT_VERSION)
  const [agency, setAgency] = React.useState<Agency>('OTHER')
  const adopted = rows.filter((r) => r.adopted)
  const tables = React.useMemo(() => listResultTables(adopted.map((r) => r.site)), [rows])
  /** Deselected "<Module>/<table>" keys (default: every table except the copies of the specification). */
  const specKeys = React.useMemo(() => tables.filter((t) => t.specification).map((t) => t.key), [tables])
  const [deselected, setDeselected] = React.useState<Set<string>>(() => new Set(specKeys))
  React.useEffect(() => setDeselected(new Set(specKeys)), [specKeys.join('\n')])
  const selectedKeys = tables.map((t) => t.key).filter((k) => !deselected.has(k))
  const toggle = (k: string) =>
    setDeselected((d) => {
      const n = new Set(d)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const studyId = config?.studyId ?? sites.find((s) => s.studyId)?.studyId ?? 'STUDY'
  const studyTitle = config?.studyTitle ?? studyId
  const id = safeId(studyId)

  // The network audit report depends only on the verification state, not on the submission standards.
  const report = React.useMemo(() => {
    if (rows.length === 0) return undefined
    const input = { studyId, studyTitle, config, cross, rows, generatedAt: new Date().toISOString(), disposition: log.entries, dispositionHead: log.headHash }
    return { markdown: buildMarkdownReport(input), html: buildHtmlReport(input) }
  }, [studyId, studyTitle, config, cross, rows, log])

  React.useEffect(() => setOut(undefined), [rows, config, profile, defineXmlVersion, datasetChoice, ctVersion, agency, deselected])

  const generate = async () => {
    setBusy(true)
    setError(undefined)
    try {
      if (regulatory && !locked) throw new Error('Lock the site dispositions (Multi-Site Aggregator) before generating the submission package')
      // The export is itself an audit-trail event (EMA-CS §6.2.1), recorded before the log is packaged.
      await logExport({
        standards: { profile, defineXml: defineXmlVersion, datasetJson: datasetJsonVersion, ...(datasetFormat === 'xpt' ? { datasetFormat } : {}), ...(defineXmlVersion === '2.1' ? { ctVersion } : {}), agency },
        tables: selectedKeys,
        adoptedSites: adopted.map((r) => r.site.siteId),
      })
      const head = log.headBytes(studyId)
      const headSignature = coordinator ? await addSignature(undefined, head, coordinator, 'disposition-exported') : undefined
      setOut(
        await buildRegulatoryExport({
          studyId,
          studyTitle,
          config,
          cross,
          rows,
          defineXmlVersion,
          datasetJsonVersion,
          datasetFormat,
          profile,
          ctVersion,
          agency,
          tables: selectedKeys,
          disposition: { entries: log.entries, jsonl: log.toJsonl(), headHash: log.headHash, head, headSignature },
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle><ScrollText className="size-5" /> Export Hub (Regulatory)</CardTitle>
          <CardDescription>
            Review the cross-site audit report at any time, and export CDISC Define-XML and Dataset-JSON for the adopted sites.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Study</span>
            <Badge>{studyId}</Badge>
            <span className="text-muted-foreground">Adopted sites</span>
            {adopted.length ? adopted.map((r) => <Badge key={r.site.key} variant="success">{r.site.siteId}</Badge>) : <Badge variant="outline">None</Badge>}
            {rows.length - adopted.length > 0 && (
              <>
                <span className="text-muted-foreground">Excluded</span>
                {rows.filter((r) => !r.adopted).map((r) => <Badge key={r.site.key} variant="destructive">{r.site.siteId}</Badge>)}
              </>
            )}
          </div>
          {!config && <Alert variant="warning"><AlertDescription>No study_config.json loaded. Reference hashes are determined by majority across sites.</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-2">
          <div className="mr-auto flex flex-col gap-1.5">
            <CardTitle><FileText className="size-5" /> Audit report</CardTitle>
            <CardDescription>Network integrity &amp; privacy audit of every received site. Updates live as sites are loaded or adopted/excluded.</CardDescription>
          </div>
          <Button size="sm" variant="outline" disabled={!report} onClick={() => report && download(`${id}_audit_report.md`, report.markdown, 'text/markdown')}>
            <FileText /> Markdown
          </Button>
          <Button size="sm" variant="outline" disabled={!report} onClick={() => report && printHtml(report.html)}>
            <Printer /> PDF (print)
          </Button>
        </CardHeader>
        <CardContent>
          {report ? (
            <Tabs defaultValue="preview">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="source">Markdown source</TabsTrigger>
              </TabsList>
              <TabsContent value="preview">
                <MarkdownPreview markdown={report.markdown} className="max-h-[560px] overflow-auto rounded-md border p-4" />
              </TabsContent>
              <TabsContent value="source">
                <pre className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{report.markdown}</pre>
              </TabsContent>
            </Tabs>
          ) : (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Load site StudyPacks in the Multi-Site Aggregator to see the audit report.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><Package className="size-5" /> Submission package</CardTitle>
          <CardDescription>
            Combines the adopted sites' datasets into a hashed ZIP with define.xml, the datasets (Dataset-JSON or XPT) and the audit report (which additionally records the chosen standards and the package contents).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Package type" className="md:col-span-2">
              <Select value={profile} onChange={(e) => setProfile(e.target.value as SubmissionProfile)} aria-label="Package type">
                {SUBMISSION_PROFILES.map((p) => <option key={p} value={p}>{PROFILE_LABELS[p]}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">{PROFILE_NOTES[profile]}</span>
            </Field>
            <Field label="Define-XML version">
              <Select value={defineXmlVersion} onChange={(e) => setDefineXmlVersion(e.target.value as DefineXmlVersion)} aria-label="Define-XML version">
                {DEFINE_XML_VERSIONS.map((v) => <option key={v} value={v}>Define-XML v{v}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">{DEFINE_NOTES[defineXmlVersion]}</span>
            </Field>
            <Field label="Dataset format">
              <Select value={datasetChoice} onChange={(e) => setDatasetChoice(e.target.value as DatasetChoice)} aria-label="Dataset format">
                {DATASET_CHOICES.map((c) => <option key={c} value={c}>{c === 'xpt' ? 'SAS V5 transport (XPT)' : `Dataset-JSON v${c.slice(5)}`}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">{DATASET_NOTES[datasetChoice]}</span>
            </Field>
            <Field label="CDISC/NCI ADaM CT version (define.xml v2.1)">
              <Input value={defineXmlVersion === '2.1' ? ctVersion : ''} placeholder="Not declared in v2.0" disabled={defineXmlVersion !== '2.1'} onChange={(e) => setCtVersion(e.target.value)} aria-label="ADaM CT version" />
              <span className="text-xs text-muted-foreground">Package date (YYYY-MM-DD) declared in def:Standards. Use a version the target agency's data standards catalog accepts.</span>
            </Field>
            <Field label="Target agency (validator profile)">
              <Select value={agency} onChange={(e) => setAgency(e.target.value as Agency)} aria-label="Target agency">
                {AGENCIES.map((a) => <option key={a} value={a}>{AGENCY_LABELS[a]}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">Rates the conformance results; the package is the same for every agency. {AGENCY_NOTES[agency]}</span>
            </Field>
          </div>
          {tables.length > 0 && (
            <details className="rounded-md border p-3 text-sm" open={tables.length <= 12}>
              <summary className="cursor-pointer font-medium">
                Result tables — {selectedKeys.length} of {tables.length} selected
              </summary>
              <div className="mt-2 flex gap-2 text-xs">
                <Button size="sm" variant="ghost" onClick={() => setDeselected(new Set(specKeys))}>Results only</Button>
                <Button size="sm" variant="ghost" onClick={() => setDeselected(new Set())}>Select all</Button>
                <Button size="sm" variant="ghost" onClick={() => setDeselected(new Set(tables.map((t) => t.key)))}>Select none</Button>
              </div>
              {specKeys.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Tables marked <Badge variant="outline" className="text-[10px]">specification</Badge> copy the analysis specification (cohort definitions with their JSON and SQL, analysis settings), which is pinned and verified by SHA-256; they are not selected by default.
                </p>
              )}
              <Table>
                <TableHeader>
                  <TableRow><TableHead /><TableHead>Module</TableHead><TableHead>Table</TableHead><TableHead>Sites</TableHead><TableHead>Rows</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map((t) => (
                    <TableRow key={t.key} className="text-xs">
                      <TableCell><input type="checkbox" checked={!deselected.has(t.key)} onChange={() => toggle(t.key)} aria-label={`Include ${t.table}`} /></TableCell>
                      <TableCell>{t.module}</TableCell>
                      <TableCell className="font-mono">
                        {t.table}
                        {t.specification && <Badge variant="outline" className="ml-2 font-sans text-[10px]">specification</Badge>}
                      </TableCell>
                      <TableCell>{t.sites}</TableCell>
                      <TableCell>{t.rows.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {regulatory && !locked && <span className="self-center text-xs text-amber-700">Regulatory study: lock the site dispositions first.</span>}
            <Button disabled={!adopted.length || !selectedKeys.length || busy || (regulatory && !locked)} onClick={generate}>
              {busy ? <Loader2 className="animate-spin" /> : <FileCode />} Generate submission package
            </Button>
            {!adopted.length && rows.length > 0 && <span className="self-center text-xs text-muted-foreground">Adopt at least one site to build the package.</span>}
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

          {out && (
            <div className="flex flex-col gap-3 border-t pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="success" onClick={() => download(out.zipName, out.zipBlob)}><Download /> {out.zipName} ({formatBytes(out.zipBlob.size)})</Button>
                <Button size="sm" variant="outline" onClick={() => download('define.xml', out.defineXml, 'application/xml')}><Download /> define.xml (v{out.standards.defineXml})</Button>
                {out.dataDefinitionHtml && <Button size="sm" variant="outline" onClick={() => download('data_definition.html', out.dataDefinitionHtml!, 'text/html')}><Download /> data_definition.html</Button>}
                <span className="ml-2 text-xs text-muted-foreground">Reviewer's guide (draft, not in the ZIP):</span>
                <Button size="sm" variant="outline" onClick={() => download(`${id}_adrg_draft.md`, guide!.markdown, 'text/markdown')}><FileText /> Markdown</Button>
                <Button size="sm" variant="outline" onClick={() => download(`${id}_adrg_draft.html`, guide!.html, 'text/html')}><Download /> HTML</Button>
                <Button size="sm" variant="outline" onClick={() => printHtml(guide!.html)}><Printer /> PDF (print)</Button>
              </div>
              <ValidatorReports out={out} runs={runs} error={runError} onFiles={addReports} onRemove={(file) => setRuns((r) => r.filter((x) => x.file !== file))} />
              <Conformance out={out} agency={agency} />
              <Tabs defaultValue="define">
                <TabsList>
                  <TabsTrigger value="define">define.xml</TabsTrigger>
                  <TabsTrigger value="datasets">{datasetFormatLabel(out.standards)} ({Object.keys(out.datasets).length})</TabsTrigger>
                  <TabsTrigger value="manifest">manifest</TabsTrigger>
                  <TabsTrigger value="guide">Reviewer's guide (draft)</TabsTrigger>
                </TabsList>
                <TabsContent value="guide">
                  <p className="mb-2 text-xs text-muted-foreground">
                    Analysis Data Reviewer's Guide filled from the study, structured after the PHUSE ADRG template. Complete the parts marked “TO BE COMPLETED”, review every statement, and add the issues of your validator run.
                  </p>
                  <MarkdownPreview markdown={guide!.markdown} className="max-h-[560px] overflow-auto rounded-md border p-4" />
                </TabsContent>
                <TabsContent value="define">
                  <pre className="max-h-[560px] overflow-auto rounded-md bg-slate-950 p-3 text-[11px] text-slate-100">{out.defineXml}</pre>
                </TabsContent>
                <TabsContent value="datasets">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Dataset</TableHead><TableHead>Module</TableHead><TableHead>Records</TableHead><TableHead>Columns</TableHead><TableHead /></TableRow>
                    </TableHeader>
                    <TableBody>
                      {out.tables.map((t) => {
                        const path = datasetFiles(out.tables, out.standards.datasetFormat).get(t.name)!.path
                        const file = path.slice('datasets/'.length)
                        return (
                          <TableRow key={path} className="text-xs">
                            <TableCell className="font-mono">{t.name}</TableCell>
                            <TableCell>{t.module}</TableCell>
                            <TableCell>{t.rows.length.toLocaleString()}</TableCell>
                            <TableCell>{t.columns.length}</TableCell>
                            <TableCell>
                              <Button size="sm" variant="ghost" onClick={() => download(file, out.datasets[path], typeof out.datasets[path] === 'string' ? 'application/json' : 'application/octet-stream')}><Download /> {file}</Button>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </TabsContent>
                <TabsContent value="manifest">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>path</TableHead><TableHead>role</TableHead><TableHead>size</TableHead><TableHead>sha256</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {out.manifest.files.map((f) => (
                        <TableRow key={f.path} className="text-xs">
                          <TableCell className="font-mono">{f.path}</TableCell>
                          <TableCell><Badge variant="outline">{f.role}</Badge></TableCell>
                          <TableCell>{formatBytes(f.sizeBytes)}</TableCell>
                          <TableCell><Hash value={f.sha256} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const SEVERITY_VARIANT = { Reject: 'destructive', Error: 'destructive', Warning: 'warning' } as const

/** Result of the define.xml conformance checks, rated for the chosen agency, and the findings expected by design. */
/** Pinnacle 21 reports of this package: summarized here and written into sections 6.1 / 6.2 of the reviewer's guide. */
function ValidatorReports({ out, runs, error, onFiles, onRemove }: { out: RegulatoryExport; runs: ValidatorRun[]; error?: string; onFiles: (f: DroppedFile[]) => void; onRemove: (file: string) => void }) {
  const sasNames = [...datasetFiles(out.tables, out.standards.datasetFormat).values()].map((f) => f.sasName)
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="font-medium">Validator reports</div>
      <p className="text-xs text-muted-foreground">
        Run your validator (e.g. Pinnacle 21 Community) on the downloaded package, then add its Excel reports here: sections 6.1 and 6.2 of the reviewer's guide then list each run (engine, configuration, what was validated, date) and the issues it reported, with the explanation of every finding expected by design. Reports are read in the browser; local paths in them are reduced to file names.
      </p>
      <DropZone compact multiple accept=".xlsx" onFiles={onFiles} title="Drop Pinnacle 21 reports (.xlsx)" />
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {runs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow><TableHead>Run</TableHead><TableHead>Validated</TableHead><TableHead>Issues</TableHead><TableHead>Notes</TableHead><TableHead /></TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r, n) => {
              const mismatches = reportMismatches(r, sasNames)
              const unexpected = r.issues.filter((x) => !out.conformance.expected.some((e) => e.p21 === x.id))
              return (
                <TableRow key={r.file} className="text-xs">
                  <TableCell>V{n + 1}: {runLabel(r)}<div className="text-muted-foreground">{r.file}</div></TableCell>
                  <TableCell>{r.datasets.length ? `${r.datasets.length} dataset(s) + define.xml` : 'define.xml'}</TableCell>
                  <TableCell>{r.issues.map((x) => `${x.id} (${x.severity})`).join(', ') || 'none'}</TableCell>
                  <TableCell>
                    {mismatches.map((m) => <div key={m} className="text-amber-700">Not this package? {m}</div>)}
                    {unexpected.length > 0 && <div className="text-amber-700">To explain in 6.2: {unexpected.map((x) => x.id).join(', ')}</div>}
                    {!mismatches.length && !unexpected.length && <Badge variant="success">as expected</Badge>}
                  </TableCell>
                  <TableCell><Button size="icon" variant="ghost" onClick={() => onRemove(r.file)} aria-label={`Remove ${r.file}`}><Trash2 /></Button></TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

function Conformance({ out, agency }: { out: RegulatoryExport; agency: Agency }) {
  const { issues, expected } = out.conformance
  const rating = (s: Partial<Record<'FDA' | 'PMDA', 'Reject' | 'Error' | 'Warning'>>) => {
    const shown = agency === 'OTHER' ? (['FDA', 'PMDA'] as const) : ([agency] as const)
    const parts = shown.filter((a) => s[a]).map((a) => <Badge key={a} variant={SEVERITY_VARIANT[s[a]!]}>{agency === 'OTHER' ? `${a} ${s[a]}` : s[a]}</Badge>)
    return parts.length ? <span className="flex flex-wrap gap-1">{parts}</span> : <span className="text-muted-foreground">not rated</span>
  }
  const rejects = agency !== 'OTHER' && issues.some((i) => i.severity[agency] === 'Reject')
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="font-medium">Define-XML conformance</div>
      {issues.length === 0 ? (
        <Alert variant="success"><AlertDescription>No issues found by Study Studio's define.xml checks (references, SAS names, keys, lengths, classes, standards, datasets against define.xml). This does not replace running the agency's validator.</AlertDescription></Alert>
      ) : (
        <>
          {rejects && <Alert variant="destructive"><AlertDescription>{AGENCY_LABELS[agency]} would not accept this package: at least one issue is rated Reject.</AlertDescription></Alert>}
          <Table>
            <TableHeader>
              <TableRow><TableHead>Rule</TableHead><TableHead>Pinnacle 21</TableHead><TableHead>Rating</TableHead><TableHead>Element</TableHead><TableHead>Issue</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {issues.map((i, k) => (
                <TableRow key={k} className="text-xs">
                  <TableCell className="font-mono">{i.rule}</TableCell>
                  <TableCell className="font-mono">{i.p21.join(', ') || '—'}</TableCell>
                  <TableCell>{rating(i.severity)}</TableCell>
                  <TableCell className="font-mono">{i.target}</TableCell>
                  <TableCell>{i.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {expected.some((e) => e.severity.FDA === 'Reject' || e.severity.PMDA === 'Reject') && (
        <Alert variant="warning">
          <AlertDescription>
            Validating the datasets as ADaM data reports a Reject by design ({expected.filter((e) => e.severity.FDA === 'Reject' || e.severity.PMDA === 'Reject').map((e) => `${e.p21}: ${e.message}`).join('; ')}): the study submits aggregated results without subject-level data. Agree this submission format with the agency before submitting.
          </AlertDescription>
        </Alert>
      )}
      {(['define', 'data'] as const).map((scope) => {
        const list = expected.filter((e) => e.scope === scope)
        if (!list.length) return null
        return (
          <div key={scope} className="flex flex-col gap-1">
            <div className="text-xs font-medium">
              Expected validator findings — {scope === 'define' ? 'define.xml' : 'datasets validated with define.xml'} (explain them in the reviewer's guide; also recorded in the audit report)
            </div>
            {list.map((e) => (
              <div key={e.p21} className="rounded-md bg-muted/40 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2"><span className="font-mono">{e.p21}</span>{rating(e.severity)}<span>{e.message}</span></div>
                <p className="mt-1 text-muted-foreground">{e.explanation}</p>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
