import * as React from 'react'
import { FileCog, FileJson, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { kidFingerprint } from '@/lib/security/signer'
import { useStudyStore } from '@/store/useStudyStore'
import { readProtocolFile } from '@/lib/strategus/protocol'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input } from '@/components/ui/input'
import { DropZone } from '@/features/common/DropZone'
import { Hash } from '@/features/common/Hash'
import { StepHeader } from '@/features/common/StepHeader'
import type { StudyConfig } from '@/types/studypack'

export function ProtocolImport() {
  const config = useStudyStore((s) => s.config)
  const setConfig = useStudyStore((s) => s.setConfig)
  const [errors, setErrors] = React.useState<string[]>([])
  const [manual, setManual] = React.useState({ studyId: '', cdmVersion: '5.4', minCellCount: 5 })

  const onFiles = async (files: { name: string; bytes: Uint8Array }[]) => {
    const f = files[0]
    const res = await readProtocolFile(f.name, f.bytes)
    setErrors(res.errors)
    if (res.config) await setConfig(res.config, res.files, res)
  }

  const applyManual = async () => {
    if (!manual.studyId.trim()) return setErrors(['Enter a Study ID'])
    const c: StudyConfig = {
      configVersion: '1.0.0',
      studyId: manual.studyId.trim(),
      studyTitle: manual.studyId.trim(),
      cdmVersion: manual.cdmVersion,
      issuedAt: new Date().toISOString(),
      minCellCount: manual.minCellCount,
      framework: { name: 'Strategus', modules: [] },
      cohorts: [],
      expectedHashes: {},
      protectedSections: {},
    }
    setErrors([])
    await setConfig(c)
  }

  return (
    <section>
      <StepHeader n={1} title="Protocol Import / Initiate" description="Load the study_config.json (or protocol ZIP) distributed by the network coordinator." done={!!config} />
      <Card>
        <CardContent className="pt-5">
          {!config ? (
            <div className="grid gap-4 md:grid-cols-2">
              <DropZone onFiles={onFiles} accept=".json,.zip" title="Drop study_config.json / *_protocol.zip" hint="A protocol ZIP also pre-fills analysisSpecifications.json, ExecuteAnalyses.R and renv.lock" />
              <div className="flex flex-col gap-3 rounded-lg border p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileCog className="size-4" /> Manual entry
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Study ID" className="col-span-3">
                    <Input value={manual.studyId} onChange={(e) => setManual({ ...manual, studyId: e.target.value })} placeholder="ACEI_ANGIO_2026" />
                  </Field>
                  <Field label="CDM Version">
                    <Input value={manual.cdmVersion} onChange={(e) => setManual({ ...manual, cdmVersion: e.target.value })} />
                  </Field>
                  <Field label="Min cell count">
                    <Input type="number" min={1} value={manual.minCellCount} onChange={(e) => setManual({ ...manual, minCellCount: Number(e.target.value) || 5 })} />
                  </Field>
                  <div className="flex items-end">
                    <Button variant="secondary" className="w-full" onClick={applyManual}>
                      Apply
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Manual entry does not verify files against protocol hashes.</p>
              </div>
            </div>
          ) : (
            <ConfigSummary config={config} onReset={() => setConfig(undefined)} />
          )}
          {errors.length > 0 && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </section>
  )
}

function ConfigSummary({ config, onReset }: { config: StudyConfig; onReset: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex items-center gap-2">
          <FileJson className="size-5 text-primary" />
          <div>
            <div className="font-semibold">{config.studyTitle}</div>
            <div className="text-xs text-muted-foreground">
              {config.studyId} · CDM {config.cdmVersion} · issued {new Date(config.issuedAt).toLocaleString()}
            </div>
          </div>
        </div>
        <Badge variant="secondary">{config.framework?.name ?? 'Strategus'}</Badge>
        {config.assurance === 'regulatory' ? <Badge variant="default">Regulatory assurance</Badge> : <Badge variant="outline">Standard assurance</Badge>}
        <Badge variant="warning">Suppress: 0 &lt; n &lt; {config.minCellCount}</Badge>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onReset}>
          <RotateCcw /> Change
        </Button>
      </div>
      <ProtocolSignature />
      {config.framework?.modules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Modules</span>
          {config.framework.modules.map((m) => (
            <Badge key={m} variant="outline">{m.replace(/Module$/, '')}</Badge>
          ))}
        </div>
      )}
      {config.cohorts.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {config.cohorts.map((c) => (
            <Badge key={c.cohortId} variant="outline">
              {c.cohortId} {c.cohortName}
              {c.roles.length > 0 && <span className="text-muted-foreground">· {c.roles.join(', ')}</span>}
            </Badge>
          ))}
        </div>
      )}
      {(Object.keys(config.expectedHashes).length > 0 || Object.keys(config.protectedSections ?? {}).length > 0) && (
        <Card className="bg-muted/30 shadow-none">
          <CardHeader className="p-3 pb-1">
            <CardTitle className="text-xs">Expected SHA-256 (protocol-pinned artifacts)</CardTitle>
            <CardDescription className="text-xs">Files loaded at this site are verified against these</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-1 p-3 pt-0 text-xs">
            {Object.entries(config.expectedHashes).map(([p, h]) => (
              <div key={p} className="flex items-center justify-between gap-2">
                <code>{p}</code>
                <Hash value={h} />
              </div>
            ))}
            {Object.entries(config.protectedSections ?? {}).map(([p, sec]) => (
              <div key={p} className="flex items-center justify-between gap-2">
                <span>
                  <code>{p}</code> <span className="text-muted-foreground">— below “{sec.marker}”</span>
                </span>
                <Hash value={sec.sha256} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function ProtocolSignature() {
  const checks = useStudyStore((s) => s.protocol?.signatureChecks)
  if (!checks?.length) return <div className="flex items-center gap-1 text-xs text-muted-foreground"><ShieldAlert className="size-3.5" /> The protocol is not signed by the coordinator.</div>
  return (
    <div className="flex flex-col gap-1 text-xs">
      {checks.map((c, i) => (
        <div key={i} className={c.valid ? 'flex items-center gap-1 text-success' : 'flex items-center gap-1 text-destructive'}>
          {c.valid ? <ShieldCheck className="size-3.5" /> : <ShieldAlert className="size-3.5" />}
          {c.valid ? (
            <span>
              Issued and signed by <b>{c.signer?.name}</b> ({c.signer?.organization}) at {c.signedAt} · key <code>{kidFingerprint(c.kid)}</code>
              <span className="text-muted-foreground"> — confirm this fingerprint with the coordinator</span>
            </span>
          ) : (
            <span>Invalid coordinator signature{c.error ? `: ${c.error}` : ''} — the protocol may have been altered</span>
          )}
        </div>
      ))}
    </div>
  )
}
