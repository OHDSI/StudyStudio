import * as React from 'react'
import { ShieldAlert, ShieldCheck, Wand2 } from 'lucide-react'
import { useStudyStore, type SlotFile } from '@/store/useStudyStore'
import { SLOT_BY_ID, type SlotId } from '@/lib/studypack/slots'
import type { MaskStyle } from '@/lib/audit/cellAuditor'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const MAX_ROWS = 200

const SOURCE_LABEL: Record<string, string> = {
  specification: 'results data model',
  name: 'column names',
  fallback: 'all integer columns (no hints)',
}

export function AuditPanel() {
  const slots = useStudyStore((s) => s.slots)
  const results = useStudyStore((s) => s.results)
  const min = useStudyStore((s) => s.config?.minCellCount ?? 5)
  const remediateAll = useStudyStore((s) => s.remediateAll)
  const [style, setStyle] = React.useState<MaskStyle>('negative')

  const audited: { path: string; file: SlotFile }[] = [
    ...(Object.entries(slots) as [SlotId, SlotFile][]).filter(([, f]) => f.audit).map(([id, file]) => ({ path: SLOT_BY_ID[id].path, file })),
    ...Object.entries(results?.files ?? {}).filter(([, f]) => f.audit).map(([p, file]) => ({ path: `results/${p}`, file })),
  ]
  if (audited.length === 0) return null
  const failing = audited.filter((a) => !a.file.audit!.passed)
  const findings = failing.flatMap((a) => a.file.audit!.findings.map((f) => ({ path: a.path, f })))
  const scanned = audited.reduce((n, a) => n + a.file.audit!.scannedCells, 0)
  const bySource = audited.reduce<Record<string, number>>((m, a) => {
    for (const s of a.file.audit!.sheets) m[s.countColumnSource] = (m[s.countColumnSource] ?? 0) + 1
    return m
  }, {})

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {failing.length ? <ShieldAlert className="size-5 text-destructive" /> : <ShieldCheck className="size-5 text-success" />}
          Zero-PHI &amp; Small-Cell Audit
        </CardTitle>
        <CardDescription>
          Rule: flag count values with 0 &lt; n &lt; {min} (1–{min - 1}) / flag direct-identifier columns such as person_id or date of birth. Already-censored values (-{min}, &lt;{min}, NA) pass.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="secondary">{audited.length} file(s)</Badge>
          <Badge variant="secondary">{scanned.toLocaleString()} cells scanned</Badge>
          {Object.entries(bySource).map(([src, n]) => (
            <Badge key={src} variant="outline">count columns from {SOURCE_LABEL[src] ?? src}: {n}</Badge>
          ))}
          {failing.length > 0 && <Badge variant="destructive">{failing.length} file(s) with violations</Badge>}
        </div>

        {failing.length > 0 ? (
          <>
            <Alert variant="destructive">
              <ShieldAlert />
              <AlertTitle>Export Violation Warning</AlertTitle>
              <AlertDescription>
                <p>
                  {findings.length} small cell(s) (0 &lt; n &lt; {min}) or direct identifier(s) detected. The StudyPack cannot be generated until they are resolved.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Select value={style} onChange={(e) => setStyle(e.target.value as MaskStyle)} className="h-8 w-auto text-xs" aria-label="Masking style">
                    <option value="negative">-{min} (HADES convention, keeps columns numeric)</option>
                    <option value="lt">&lt;{min}</option>
                    <option value="na">NA</option>
                  </Select>
                  <Button variant="destructive" size="sm" onClick={() => remediateAll(style)}>
                    <Wand2 /> One-click auto-masking (drop identifier columns)
                  </Button>
                </div>
                {style !== 'negative' && (
                  <p className="mt-2 text-xs">
                    Note: Strategus result tables declare these columns as integers, so “{style === 'lt' ? `<${min}` : 'NA'}” may not load into the OHDSI results database. -{min} is the convention HADES itself uses.
                  </p>
                )}
              </AlertDescription>
            </Alert>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Sheet</TableHead>
                  <TableHead>Row</TableHead>
                  <TableHead>Column</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Value / reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {findings.slice(0, MAX_ROWS).map(({ path, f }, i) => (
                  <TableRow key={i} className="text-xs">
                    <TableCell className="font-mono">{path}</TableCell>
                    <TableCell>{f.sheet ?? '—'}</TableCell>
                    <TableCell>{f.kind === 'smallCell' ? f.row : 'header'}</TableCell>
                    <TableCell className="font-mono">{f.column}</TableCell>
                    <TableCell>{f.kind === 'smallCell' ? <Badge variant="destructive">Small cell</Badge> : <Badge variant="warning">Direct identifier</Badge>}</TableCell>
                    <TableCell>{f.kind === 'smallCell' ? <span className="font-mono font-semibold text-destructive">{f.value}</span> : f.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {findings.length > MAX_ROWS && <div className="text-xs text-muted-foreground">and {findings.length - MAX_ROWS} more</div>}
          </>
        ) : (
          <Alert variant="success">
            <ShieldCheck />
            <AlertTitle>Audit passed</AlertTitle>
            <AlertDescription>No small cells or direct identifiers detected.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}
