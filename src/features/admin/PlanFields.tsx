import * as React from 'react'
import { X } from 'lucide-react'
import { readProtocolFile } from '@/lib/strategus/protocol'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { DropZone } from '@/features/common/DropZone'
import { REGISTRATION_LABEL, type StudyConfig } from '@/types/studypack'

/** Amendment (P1), plan documents (P2) and registration (P3), as entered in the Protocol Issuer. All optional. */
export interface PlanInput {
  amends?: { previousBytes: Uint8Array; previous: Pick<StudyConfig, 'studyId' | 'issuedAt'>; summary: string }
  documents: { name: string; bytes: Uint8Array; title: string }[]
  registration: { registry: string; id: string; registeredAt: string }
}

export const EMPTY_PLAN: PlanInput = { documents: [], registration: { registry: '', id: '', registeredAt: '' } }

/** The ProtocolMeta fields for a plan input; empty inputs add nothing. */
export function planMeta(p: PlanInput) {
  const r = p.registration
  return {
    ...(p.amends ? { amends: { previousBytes: p.amends.previousBytes, summary: p.amends.summary } } : {}),
    ...(p.documents.length ? { documents: p.documents } : {}),
    ...(r.registry.trim() || r.id.trim() || r.registeredAt.trim() ? { registration: r } : {}),
  }
}

export function PlanFields({ plan, onChange }: { plan: PlanInput; onChange: (p: PlanInput) => void }) {
  const [error, setError] = React.useState<string>()
  const dec = new TextDecoder()
  return (
    <>
      <Field label="Amends an earlier issue (optional)" className="md:col-span-3">
        {plan.amends ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              Amends {plan.amends.previous.studyId} issued {plan.amends.previous.issuedAt}
              <Button size="sm" variant="ghost" className="h-6" onClick={() => onChange({ ...plan, amends: undefined })} aria-label="Remove"><X /></Button>
            </div>
            <Input value={plan.amends.summary} placeholder="What this issue changes (required)" onChange={(e) => onChange({ ...plan, amends: { ...plan.amends!, summary: e.target.value } })} />
          </div>
        ) : (
          <DropZone
            compact
            accept=".json,.zip"
            title="Drop the previous study_config.json (or protocol ZIP)"
            onFiles={async (fs) => {
              setError(undefined)
              const r = await readProtocolFile(fs[0].name, fs[0].bytes)
              if (!r.configBytes) return setError(r.errors.join(' / ') || 'No study_config.json found')
              try {
                const prev = JSON.parse(dec.decode(r.configBytes)) as StudyConfig
                onChange({ ...plan, amends: { previousBytes: r.configBytes, previous: { studyId: prev.studyId, issuedAt: prev.issuedAt }, summary: '' } })
              } catch {
                setError('The previous study_config.json is not valid JSON')
              }
            }}
          />
        )}
        <span className="text-[11px] text-muted-foreground">Records the SHA-256 of the previous issue in the new one, under the coordinator signature. Packs sealed under an earlier issue in the chain are then reported as such.</span>
      </Field>
      <Field label="Plan documents (optional)" className="md:col-span-3">
        <DropZone compact multiple title="Drop the protocol, statistical analysis plan or other plan documents" onFiles={(fs) => onChange({ ...plan, documents: [...plan.documents, ...fs.map((f) => ({ name: f.name, bytes: f.bytes, title: '' }))] })} />
        {plan.documents.map((d, n) => (
          <div key={n} className="flex items-center gap-2 text-xs">
            <span className="w-48 truncate" title={d.name}>{d.name}</span>
            <Input className="h-7" value={d.title} placeholder="Title, e.g. Statistical analysis plan v1.0 (required)" onChange={(e) => onChange({ ...plan, documents: plan.documents.map((x, i) => (i === n ? { ...x, title: e.target.value } : x)) })} />
            <Button size="sm" variant="ghost" className="h-6" onClick={() => onChange({ ...plan, documents: plan.documents.filter((_, i) => i !== n) })} aria-label="Remove"><X /></Button>
          </div>
        ))}
        <span className="text-[11px] text-muted-foreground">Shipped in the protocol ZIP under docs/ and pinned by SHA-256; sites seal them with their pack automatically. The tool hashes them and never reads their content.</span>
      </Field>
      <Field label="Registration (optional)" className="md:col-span-3">
        <div className="grid gap-2 md:grid-cols-3">
          <Input value={plan.registration.registry} placeholder="Registry, e.g. EU PAS Register" onChange={(e) => onChange({ ...plan, registration: { ...plan.registration, registry: e.target.value } })} />
          <Input value={plan.registration.id} placeholder="Registration ID" onChange={(e) => onChange({ ...plan, registration: { ...plan.registration, id: e.target.value } })} />
          <Input value={plan.registration.registeredAt} placeholder="Registered on (YYYY-MM-DD)" onChange={(e) => onChange({ ...plan, registration: { ...plan.registration, registeredAt: e.target.value } })} />
        </div>
        <span className="text-[11px] text-muted-foreground">Signed with the protocol and shown in the reports {REGISTRATION_LABEL}. Nothing is looked up.</span>
      </Field>
      {error && <div className="text-xs text-destructive md:col-span-3">{error}</div>}
    </>
  )
}
