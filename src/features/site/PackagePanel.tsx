import * as React from 'react'
import { AlertTriangle, Archive, CheckCircle2, Download, Loader2, Lock, PackageCheck, PenLine } from 'lucide-react'
import { exportedMinCellCount, siteFiles, useStudyStore, type SlotFile } from '@/store/useStudyStore'
import { evaluateReadiness } from '@/lib/studypack/readiness'
import { evaluateEvidence } from '@/lib/studypack/evidence'
import { buildStudyPack, packFileName, retentionFileName, type BuiltPack, type ProtocolCheck } from '@/lib/studypack/builder'
import { kidFingerprint } from '@/lib/security/signer'
import { SigningKeys } from '@/features/common/SigningKeys'
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
  const { siteId, config, slots, results, signers, protocol } = useStudyStore()
  const exportedMin = React.useMemo(() => exportedMinCellCount(slots), [slots])
  const evidence = React.useMemo(() => evaluateEvidence({ config, files: siteFiles({ slots, results }) }), [config, slots, results])
  const readiness = React.useMemo(
    () =>
      evaluateReadiness({
        siteId,
        config,
        slots,
        results: results?.files ?? {},
        exportedMinCellCount: exportedMin,
        evidence,
        signers: signers.map((s) => ({ role: s.signer.signer.role })),
        protocolSignature: protocol?.signatureChecks,
      }),
    [siteId, config, slots, results, exportedMin, evidence, signers, protocol],
  )
  const [built, setBuilt] = React.useState<BuiltPack>()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()

  // Invalidate a previously built pack whenever inputs change.
  React.useEffect(() => setBuilt(undefined), [siteId, config, slots, results, signers])

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
      const now = new Date()
      const pack = await buildStudyPack({
        now,
        assurance: config.assurance ?? 'standard',
        protocolBytes: protocol?.bytes,
        protocolSignatureBytes: protocol?.signatureBytes,
        evidence: evaluateEvidence({ config, files: siteFiles({ slots, results }), sealedAt: now.toISOString() }),
        signers,
        studyId: config.studyId,
        studyTitle: config.studyTitle,
        siteId: siteId.trim(),
        cdmVersion: config.cdmVersion,
        minCellCount: config.minCellCount,
        exportedMinCellCount: exportedMin,
        files: [
          ...entries.map(([id, f]) => ({ path: SLOT_BY_ID[id].path, role: SLOT_BY_ID[id].role, originalName: f.name, bytes: f.bytes, audit: f.audit, remediated: f.remediated, original: f.original, modification: f.modification })),
          ...Object.entries(results?.files ?? {}).map(([p, f]) => ({ path: `${RESULTS_DIR}/${p}`, role: 'result' as const, originalName: p, bytes: f.bytes, audit: f.audit, remediated: f.remediated, original: f.original, modification: f.modification })),
        ],
        protocolChecks,
      })
      setBuilt(pack)
      download(pack.zipName, pack.zipBlob)
      // Regulatory studies must keep the receipt; in standard studies it is offered, not pushed.
      if (pack.retention.originals.length && config.assurance === 'regulatory') download(retentionFileName(pack.manifest.siteId, pack.manifest.studyId), JSON.stringify(pack.retention, null, 2) + '\n', 'application/json')
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
          <SigningKeys
            roles={['operator', 'site-pi']}
            description={`Sign manifest.json with your key (operator: "sealed", site PI: "approved for release"). ${config?.assurance === 'regulatory' ? 'Required for this regulatory study.' : 'Optional for this study.'} Signatures cover every file through its SHA-256.`}
          />
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
              {built.signature && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <PenLine className="size-4 text-success" /> Signed by
                  {built.auditReport.signers?.map((s) => (
                    <Badge key={s.kid} variant="success">{s.name} · {s.meaning} · {kidFingerprint(s.kid)}</Badge>
                  ))}
                </div>
              )}
              {built.retention.originals.length > 0 && (
                <Alert variant={config?.assurance === 'regulatory' ? 'warning' : 'default'}>
                  <Archive />
                  <AlertTitle>{config?.assurance === 'regulatory' ? 'Keep the retention receipt and the originals at this site' : 'Optional: retention receipt for the masked originals'}</AlertTitle>
                  <AlertDescription>
                    <p>
                      {built.retention.originals.length} file(s) were masked or redacted. The StudyPack carries only salted commitments to the originals. The receipt <code>{retentionFileName(built.manifest.siteId, built.manifest.studyId)}</code> holds the salts that prove which originals you held — keep it with the unmasked files for the retention period and do not send it.
                    </p>
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => download(retentionFileName(built.manifest.siteId, built.manifest.studyId), JSON.stringify(built.retention, null, 2) + '\n', 'application/json')}>
                      <Download /> {config?.assurance === 'regulatory' ? 'Save retention receipt again' : 'Save retention receipt'}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
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
