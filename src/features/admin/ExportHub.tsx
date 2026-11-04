import * as React from 'react'
import { Download, FileCode, FileText, Loader2, Package, Printer, ScrollText } from 'lucide-react'
import { useNetworkAnalysis } from './useNetworkAnalysis'
import { buildHtmlReport, buildMarkdownReport, buildRegulatoryExport, listResultTables, type RegulatoryExport } from '@/lib/export/regulatory'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Select } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Hash } from '@/features/common/Hash'
import { download, formatBytes } from '@/lib/utils'
import { safeId } from '@/lib/studypack/builder'
import { DEFINE_XML_VERSIONS, type DefineXmlVersion } from '@/lib/cdisc/defineXml'
import { DATASET_JSON_VERSIONS, type DatasetJsonVersion } from '@/lib/cdisc/datasetJson'

const DEFINE_NOTES: Record<DefineXmlVersion, string> = {
  '2.1': 'Current CDISC release. OMOP datasets are flagged def:IsNonStandard="Yes".',
  '2.0': 'For reviewers that still require v2.0. Non-standard datasets cannot be flagged; source fields use Origin "eDT".',
}
const DATASET_JSON_NOTES: Record<DatasetJsonVersion, string> = {
  '1.1': 'Current CDISC release (flat columns / rows).',
  '1.0': 'Legacy layout (clinicalData.itemGroupData with ITEMGROUPDATASEQ).',
}

/** Open the HTML report in a new window and trigger the browser's print dialog (Save as PDF). */
function printHtml(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const w = window.open(url, '_blank')
  if (w) w.addEventListener('load', () => w.print())
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function ExportHub() {
  const { rows, cross, config, sites } = useNetworkAnalysis()
  const [out, setOut] = React.useState<RegulatoryExport>()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [defineXmlVersion, setDefineXmlVersion] = React.useState<DefineXmlVersion>('2.1')
  const [datasetJsonVersion, setDatasetJsonVersion] = React.useState<DatasetJsonVersion>('1.1')
  const adopted = rows.filter((r) => r.adopted)
  const tables = React.useMemo(() => listResultTables(adopted.map((r) => r.site)), [rows])
  /** Deselected "<Module>/<table>" keys (default: everything selected). */
  const [deselected, setDeselected] = React.useState<Set<string>>(new Set())
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
    const input = { studyId, studyTitle, config, cross, rows, generatedAt: new Date().toISOString() }
    return { markdown: buildMarkdownReport(input), html: buildHtmlReport(input) }
  }, [studyId, studyTitle, config, cross, rows])

  React.useEffect(() => setOut(undefined), [rows, config, defineXmlVersion, datasetJsonVersion, deselected])

  const generate = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setOut(await buildRegulatoryExport({ studyId, studyTitle, config, cross, rows, defineXmlVersion, datasetJsonVersion, tables: selectedKeys }))
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
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">{report.markdown}</pre>
          ) : (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">Load site StudyPacks in the Multi-Site Aggregator to see the audit report.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><Package className="size-5" /> Submission package</CardTitle>
          <CardDescription>
            Combines the adopted sites' datasets into a hashed ZIP with define.xml, Dataset-JSON and the audit report (which additionally records the chosen standards and the package contents).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Define-XML version">
              <Select value={defineXmlVersion} onChange={(e) => setDefineXmlVersion(e.target.value as DefineXmlVersion)} aria-label="Define-XML version">
                {DEFINE_XML_VERSIONS.map((v) => <option key={v} value={v}>Define-XML v{v}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">{DEFINE_NOTES[defineXmlVersion]}</span>
            </Field>
            <Field label="Dataset-JSON version">
              <Select value={datasetJsonVersion} onChange={(e) => setDatasetJsonVersion(e.target.value as DatasetJsonVersion)} aria-label="Dataset-JSON version">
                {DATASET_JSON_VERSIONS.map((v) => <option key={v} value={v}>Dataset-JSON v{v}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">{DATASET_JSON_NOTES[datasetJsonVersion]}</span>
            </Field>
          </div>
          {tables.length > 0 && (
            <details className="rounded-md border p-3 text-sm" open={tables.length <= 12}>
              <summary className="cursor-pointer font-medium">
                Result tables — {selectedKeys.length} of {tables.length} selected
              </summary>
              <div className="mt-2 flex gap-2 text-xs">
                <Button size="sm" variant="ghost" onClick={() => setDeselected(new Set())}>Select all</Button>
                <Button size="sm" variant="ghost" onClick={() => setDeselected(new Set(tables.map((t) => t.key)))}>Select none</Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow><TableHead /><TableHead>Module</TableHead><TableHead>Table</TableHead><TableHead>Sites</TableHead><TableHead>Rows</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map((t) => (
                    <TableRow key={t.key} className="text-xs">
                      <TableCell><input type="checkbox" checked={!deselected.has(t.key)} onChange={() => toggle(t.key)} aria-label={`Include ${t.table}`} /></TableCell>
                      <TableCell>{t.module}</TableCell>
                      <TableCell className="font-mono">{t.table}</TableCell>
                      <TableCell>{t.sites}</TableCell>
                      <TableCell>{t.rows.toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!adopted.length || !selectedKeys.length || busy} onClick={generate}>
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
              </div>
              <Tabs defaultValue="define">
                <TabsList>
                  <TabsTrigger value="define">define.xml</TabsTrigger>
                  <TabsTrigger value="datasets">Dataset-JSON v{out.standards.datasetJson} ({Object.keys(out.datasets).length})</TabsTrigger>
                  <TabsTrigger value="manifest">manifest</TabsTrigger>
                </TabsList>
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
                        const path = `datasets/${t.sourceTable}.json`
                        return (
                          <TableRow key={path} className="text-xs">
                            <TableCell className="font-mono">{t.name}</TableCell>
                            <TableCell>{t.module}</TableCell>
                            <TableCell>{t.rows.length.toLocaleString()}</TableCell>
                            <TableCell>{t.columns.length}</TableCell>
                            <TableCell>
                              <Button size="sm" variant="ghost" onClick={() => download(`${t.sourceTable}.json`, out.datasets[path], 'application/json')}><Download /> {t.sourceTable}.json</Button>
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
