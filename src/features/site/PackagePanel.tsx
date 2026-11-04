import * as React from 'react'
import { AlertTriangle, CheckCircle2, Download, Loader2, Lock, PackageCheck } from 'lucide-react'
import { exportedMinCellCount, useStudyStore, type SlotFile } from '@/store/useStudyStore'
import { evaluateReadiness } from '@/lib/studypack/readiness'
import { buildStudyPack, packFileName, type BuiltPack, type ProtocolCheck } from '@/lib/studypack/builder'
import { RESULTS_DIR, SLOT_BY_ID, type SlotId } from '@/lib/studypack/slots'
import { hashesEqual } from '@/lib/integrity/hasher'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Hash } from '@/features/common/Hash'
import { StepHeader } from '@/features/common/StepHeader'
import { download, formatBytes } from '@/lib/utils'

export function PackagePanel() {
  const { siteId, config, slots, results } = useStudyStore()
  const exportedMin = React.useMemo(() => exportedMinCellCount(slots), [slots])
  const readiness = React.useMemo(
    () => evaluateReadiness({ siteId, config, slots, results: results?.files ?? {}, exportedMinCellCount: exportedMin }),
    [siteId, config, slots, results, exportedMin],
  )
  const [built, setBuilt] = React.useState<BuiltPack>()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()

  // Invalidate a previously built pack whenever inputs change.
  React.useEffect(() => setBuilt(undefined), [siteId, config, slots, results])

  const build = async () => {
    if (!config || !readiness.canPackage) return
    setBusy(true)
    setError(undefined)
    try {
      const entries = Object.entries(slots) as [SlotId, SlotFile][]
      const byPath = (path: string) => entries.find(([id]) => SLOT_BY_ID[id].path === path)?.[1]
      const protocolChecks: ProtocolCheck[] = [
        ...Object.entries(config.expectedHashes).map(([path, expected]) => {
          const actual = byPath(path)?.sha256
          return { path, kind: 'file' as const, expected, actual, match: hashesEqual(actual, expected) }
        }),
        ...Object.entries(config.protectedSections ?? {}).map(([path, sec]) => {
          const actual = byPath(path)?.protectedSha256
          return { path, kind: 'section' as const, expected: sec.sha256, actual, match: hashesEqual(actual, sec.sha256) }
        }),
      ]
      const pack = await buildStudyPack({
        studyId: config.studyId,
        studyTitle: config.studyTitle,
        siteId: siteId.trim(),
        cdmVersion: config.cdmVersion,
        minCellCount: config.minCellCount,
        exportedMinCellCount: exportedMin,
        files: [
          ...entries.map(([id, f]) => ({ path: SLOT_BY_ID[id].path, role: SLOT_BY_ID[id].role, originalName: f.name, bytes: f.bytes, audit: f.audit, remediated: f.remediated })),
          ...Object.entries(results?.files ?? {}).map(([p, f]) => ({ path: `${RESULTS_DIR}/${p}`, role: 'result' as const, originalName: p, bytes: f.bytes, audit: f.audit, remediated: f.remediated })),
        ],
        protocolChecks,
      })
      setBuilt(pack)
      download(pack.zipName, pack.zipBlob)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <StepHeader n={3} title="Package & Download" description="After the audit passes, the SHA-256 of every file is sealed into manifest.json and the submission ZIP is produced." done={!!built} />
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          {readiness.blockers.length > 0 && (
            <Alert variant={readiness.privacyViolations ? 'destructive' : 'warning'}>
              <Lock />
              <AlertTitle>{readiness.privacyViolations ? 'ZIP generation is locked (export blocked)' : 'Prerequisites for ZIP generation are not met'}</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {readiness.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {readiness.warnings.length > 0 && (
            <Alert variant="warning">
              <AlertTriangle />
              <AlertTitle>Warnings</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {readiness.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" variant={readiness.canPackage ? 'success' : 'secondary'} disabled={!readiness.canPackage || busy} onClick={build}>
              {busy ? <Loader2 className="animate-spin" /> : readiness.canPackage ? <Download /> : <Lock />}
              Download StudyPack
            </Button>
            <code className="text-xs text-muted-foreground">{packFileName(siteId || 'site', config?.studyId || 'study')}</code>
            {readiness.canPackage && !built && (
              <Badge variant="success">
                <CheckCircle2 /> Ready
              </Badge>
            )}
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {built && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <PackageCheck className="size-4 text-success" /> Generated {built.zipName} ({formatBytes(built.zipBlob.size)})
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => download(built.zipName, built.zipBlob)}>
                  <Download /> Download again
                </Button>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>path</TableHead>
                    <TableHead>role</TableHead>
                    <TableHead>size</TableHead>
                    <TableHead>sha256</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {built.manifest.files.map((f) => (
                    <TableRow key={f.path} className="text-xs">
                      <TableCell className="font-mono">{built.rootDir}/{f.path}</TableCell>
                      <TableCell><Badge variant="outline">{f.role}</Badge></TableCell>
                      <TableCell>{formatBytes(f.sizeBytes)}</TableCell>
                      <TableCell><Hash value={f.sha256} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
