import * as React from 'react'
import { Check, Download, History, Lock, ScrollText, UserCheck, Users, X } from 'lucide-react'
import { useStudyStore } from '@/store/useStudyStore'
import { kidFingerprint, parseEnrollmentCard, parseRoster, type EnrollmentCard, type SignerRoster } from '@/lib/security/signer'
import type { DispositionEntry } from '@/lib/network/dispositionLog'
import type { SiteRow } from '@/lib/export/regulatory'
import type { ReasonCode } from '@/types/studypack'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DropZone } from '@/features/common/DropZone'
import { SigningKeys } from '@/features/common/SigningKeys'
import { download } from '@/lib/utils'
import { safeId } from '@/lib/studypack/builder'

const dec = new TextDecoder()
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Who records decisions in this session (R6.2: user, role, organisation). */
export function ActorCard() {
  const actor = useStudyStore((s) => s.actor)
  const setActor = useStudyStore((s) => s.setActor)
  const [form, setForm] = React.useState({ name: actor?.name ?? '', role: actor?.role ?? 'Network coordinator', organization: actor?.organization ?? '' })
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm"><UserCheck className="size-4" /> Who is recording decisions</CardTitle>
        <CardDescription className="text-xs">Every receipt, adoption, exclusion and export is attributed to this person in the disposition audit trail.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {actor ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success"><Check /> {actor.name}</Badge>
            <span className="text-muted-foreground">{actor.role} · {actor.organization || '—'}</span>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setActor(undefined)}>Change</Button>
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Role"><Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /></Field>
            <Field label="Organisation"><Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} /></Field>
            <Button size="sm" className="w-fit" disabled={!form.name.trim()} onClick={() => setActor({ name: form.name.trim(), role: form.role.trim(), organization: form.organization.trim() })}>Confirm identity</Button>
          </div>
        )}
        <SigningKeys roles={['coordinator']} description="Optional: unlock the coordinator key to have your key ID recorded with each entry and to sign the disposition log when exporting." />
      </CardContent>
    </Card>
  )
}

/** Signer roster: enroll sites' public keys after verifying identity out of band (R1.5). */
export function RosterCard() {
  const config = useStudyStore((s) => s.config)
  const roster = useStudyStore((s) => s.roster)
  const setRoster = useStudyStore((s) => s.setRoster)
  const actor = useStudyStore((s) => s.actor)
  const [card, setCard] = React.useState<EnrollmentCard>()
  const [form, setForm] = React.useState({ siteId: '', method: 'Video call with government ID; fingerprint read back by the signer' })
  const [error, setError] = React.useState<string>()

  const onDrop = async (bytes: Uint8Array) => {
    setError(undefined)
    try {
      const json = JSON.parse(dec.decode(bytes))
      if (json?.format === 'studypack-signer-roster/1') return setRoster(parseRoster(json))
      setCard(await parseEnrollmentCard(json))
    } catch (e) {
      setError(errText(e))
    }
  }
  const enroll = () => {
    if (!card) return
    const base: SignerRoster = roster ?? { format: 'studypack-signer-roster/1', studyId: config?.studyId ?? '', signers: [] }
    setRoster({
      ...base,
      signers: [
        ...base.signers.filter((s) => s.kid !== card.kid),
        {
          kid: card.kid,
          name: card.signer.name,
          organization: card.signer.organization,
          role: card.signer.role,
          siteId: card.signer.role === 'coordinator' ? undefined : form.siteId.trim() || undefined,
          enrolledAt: new Date().toISOString(),
          verifiedBy: actor?.name ?? '',
          verificationMethod: form.method,
        },
      ],
    })
    setCard(undefined)
  }
  const revoke = (kid: string) =>
    roster && setRoster({ ...roster, signers: roster.signers.map((s) => (s.kid === kid && !s.revokedAt ? { ...s, revokedAt: new Date().toISOString() } : s)) })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm"><Users className="size-4" /> Signer roster</CardTitle>
        <CardDescription className="text-xs">Signatures are only trusted from enrolled keys. Drop a site's *.enrollment.json, confirm its fingerprint with the signer, then enroll. Drop a saved signer_roster.json to reuse it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {roster?.signers.map((s) => (
          <div key={s.kid} className="flex flex-wrap items-center gap-2 border-b pb-1 last:border-0">
            <span className="font-medium">{s.name}</span>
            <Badge variant="outline">{s.role}</Badge>
            {s.siteId && <Badge variant="secondary">{s.siteId}</Badge>}
            <code className="text-muted-foreground">{kidFingerprint(s.kid)}</code>
            {s.revokedAt ? <Badge variant="destructive">revoked {s.revokedAt.slice(0, 10)}</Badge> : <Button size="sm" variant="ghost" className="ml-auto h-6" onClick={() => revoke(s.kid)}>Revoke</Button>}
          </div>
        ))}
        {card ? (
          <div className="grid gap-2 rounded-md border p-2 md:grid-cols-2">
            <div className="md:col-span-2">
              <b>{card.signer.name}</b> ({card.signer.organization}, {card.signer.role}) — fingerprint <code className="font-semibold">{kidFingerprint(card.kid)}</code>
            </div>
            {card.signer.role !== 'coordinator' && <Field label="Site ID"><Input value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })} placeholder="e.g. Site_A" /></Field>}
            <Field label="Identity verified how"><Input value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} /></Field>
            <div className="flex gap-2 md:col-span-2">
              <Button size="sm" disabled={!actor || (card.signer.role !== 'coordinator' && !form.siteId.trim())} onClick={enroll}>Enroll (verified by {actor?.name ?? '— identify yourself first'})</Button>
              <Button size="sm" variant="ghost" onClick={() => setCard(undefined)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <DropZone compact accept=".json" onFiles={(fs) => onDrop(fs[0].bytes)}>
            <span className="text-xs text-muted-foreground">Drop *.enrollment.json or signer_roster.json</span>
          </DropZone>
        )}
        {roster && (
          <Button size="sm" variant="outline" className="w-fit" onClick={() => download(`${safeId(roster.studyId || 'study')}_signer_roster.json`, JSON.stringify(roster, null, 2) + '\n', 'application/json')}>
            <Download /> Save signer_roster.json
          </Button>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  )
}

/** Adopt / exclude with a pre-specified reason (R6.1). */
export function DecisionCell({ row, reasonCodes, locked, canDecide }: { row: SiteRow; reasonCodes: ReasonCode[]; locked: boolean; canDecide: boolean }) {
  const decide = useStudyStore((s) => s.decide)
  const [pending, setPending] = React.useState<'adopt' | 'exclude'>()
  const [code, setCode] = React.useState('')
  const [text, setText] = React.useState('')
  const [error, setError] = React.useState<string>()
  const rec = row.verdict.recommended

  const start = async (to: 'adopt' | 'exclude') => {
    setError(undefined)
    // Following the recommendation to adopt needs no reason; anything else does.
    if (to === 'adopt' && rec === 'adopt') return decide(row.site.key, to, rec).catch((e) => setError(errText(e)))
    setPending(to)
    setCode(to === 'exclude' ? row.verdict.codes[0] ?? '' : '')
    setText('')
  }
  const submit = async () => {
    try {
      await decide(row.site.key, pending!, rec, code, text)
      setPending(undefined)
    } catch (e) {
      setError(errText(e))
    }
  }

  const status = row.decision ? (
    <Badge variant={row.decision === 'adopt' ? 'success' : 'destructive'}>{row.decision === 'adopt' ? 'Adopted' : 'Excluded'}</Badge>
  ) : (
    <Badge variant="outline">Undecided</Badge>
  )
  if (locked || !canDecide) return status
  return (
    <div className="flex min-w-40 flex-col gap-1">
      <div className="flex items-center gap-1">
        {status}
        <Button size="sm" variant={row.decision === 'adopt' ? 'secondary' : 'ghost'} className="h-6 px-1.5" onClick={() => start('adopt')} aria-label="Adopt"><Check /></Button>
        <Button size="sm" variant={row.decision === 'exclude' ? 'secondary' : 'ghost'} className="h-6 px-1.5" onClick={() => start('exclude')} aria-label="Exclude"><X /></Button>
      </div>
      {pending && (
        <div className="flex flex-col gap-1 rounded border bg-background p-1.5">
          <div className="text-[10px] text-muted-foreground">{pending !== rec ? `Against the recommendation (${rec}) — a reason and justification are required` : 'Reason (pre-specified)'}</div>
          <Select className="h-7 text-xs" value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Select a reason…</option>
            {reasonCodes.map((r) => <option key={r.code} value={r.code}>{r.code} — {r.label}</option>)}
          </Select>
          <Input className="h-7 text-xs" placeholder="Justification" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-1">
            <Button size="sm" className="h-6" onClick={submit}>Record {pending}</Button>
            <Button size="sm" variant="ghost" className="h-6" onClick={() => setPending(undefined)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <div className="text-[10px] text-destructive">{error}</div>}
    </div>
  )
}

const LOCK_STATEMENT = 'I lock the site dispositions. Comparative results between exposure groups were not viewed when making them (ICH M14 §4.2).'

/** Lock dispositions before any comparative results are produced (R6.3). */
export function LockCard({ rows, regulatory }: { rows: SiteRow[]; regulatory: boolean }) {
  const log = useStudyStore((s) => s.log)
  useStudyStore((s) => s.logRev)
  const lock = useStudyStore((s) => s.lockDispositions)
  const actor = useStudyStore((s) => s.actor)
  const [attest, setAttest] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const undecided = rows.filter((r) => !r.decision)
  const lockEntry = log.entries.find((e) => e.action === 'lock')
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm"><Lock className="size-4" /> Lock dispositions</CardTitle>
        <CardDescription className="text-xs">
          Decide every site before any comparative result is generated. {regulatory ? 'Required before the submission package in a regulatory study.' : 'Recommended.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {lockEntry ? (
          <Alert variant="success"><AlertDescription>Locked by {lockEntry.actor.name} at {lockEntry.at}. Later changes can only be recorded as notes.</AlertDescription></Alert>
        ) : (
          <>
            {undecided.length > 0 && <div className="text-amber-700">Undecided: {undecided.map((r) => r.site.siteId).join(', ')}</div>}
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5" />
              <span>{LOCK_STATEMENT}</span>
            </label>
            <Button
              size="sm"
              className="w-fit"
              disabled={!attest || !actor || rows.length === 0 || undecided.length > 0}
              onClick={() => lock(LOCK_STATEMENT).catch((e) => setError(errText(e)))}
            >
              <Lock /> Lock {rows.length} site disposition(s)
            </Button>
          </>
        )}
        {error && <div className="text-destructive">{error}</div>}
      </CardContent>
    </Card>
  )
}

const ACTION_VARIANT: Record<DispositionEntry['action'], 'success' | 'destructive' | 'secondary' | 'outline' | 'default'> = {
  received: 'secondary',
  adopt: 'success',
  exclude: 'destructive',
  lock: 'default',
  export: 'default',
  note: 'outline',
}

/** The append-only disposition audit trail (R6.2, R6.4). */
export function DispositionLogCard() {
  const log = useStudyStore((s) => s.log)
  useStudyStore((s) => s.logRev)
  const importLog = useStudyStore((s) => s.importLog)
  const config = useStudyStore((s) => s.config)
  const [error, setError] = React.useState<string>()
  const [head, setHead] = React.useState<{ headHash: string; entries: number }>()
  const id = safeId(config?.studyId ?? 'study')

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2 pb-2">
        <div className="mr-auto flex flex-col gap-1">
          <CardTitle className="text-sm"><History className="size-4" /> Disposition audit trail ({log.size})</CardTitle>
          <CardDescription className="text-xs">Append-only; each entry carries the SHA-256 of the previous one. Head <code>{log.headHash.slice(0, 16)}…</code></CardDescription>
        </div>
        <Button size="sm" variant="outline" disabled={!log.size} onClick={() => download(`${id}_disposition_log.jsonl`, log.toJsonl(), 'application/x-ndjson')}><ScrollText /> Save log</Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-xs">
        {log.size === 0 && (
          <DropZone
            compact
            multiple
            accept=".jsonl,.json"
            onFiles={async (fs) => {
              setError(undefined)
              try {
                const h = fs.find((f) => f.name.endsWith('.json'))
                const headJson = h ? JSON.parse(dec.decode(h.bytes)) : head
                if (h) setHead(headJson)
                const l = fs.find((f) => f.name.endsWith('.jsonl'))
                if (l) await importLog(dec.decode(l.bytes), headJson ? { headHash: headJson.headHash, entries: headJson.entries } : undefined)
              } catch (e) {
                setError(errText(e))
              }
            }}
          >
            <span className="text-xs text-muted-foreground">Continue an earlier session: drop disposition_log.jsonl (and its disposition_head.json to check for truncation)</span>
          </DropZone>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {log.size > 0 && (
          <div className="max-h-72 overflow-auto rounded border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>#</TableHead><TableHead>When (UTC)</TableHead><TableHead>Who</TableHead><TableHead>Action</TableHead><TableHead>Site</TableHead><TableHead>Change</TableHead><TableHead>Reason</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {[...log.entries].reverse().map((e) => (
                  <TableRow key={e.seq} className="text-[11px]">
                    <TableCell>{e.seq}</TableCell>
                    <TableCell className="whitespace-nowrap">{e.at.replace('T', ' ').slice(0, 19)}</TableCell>
                    <TableCell>{e.actor.name}{e.actor.kid && <span className="text-muted-foreground"> · {kidFingerprint(e.actor.kid)}</span>}</TableCell>
                    <TableCell><Badge variant={ACTION_VARIANT[e.action]}>{e.action}</Badge></TableCell>
                    <TableCell>{e.siteId ?? '—'}</TableCell>
                    <TableCell>{e.to ? `${e.from ?? '—'} → ${e.to}${e.deviatesFromRecommendation ? ' (against recommendation)' : ''}` : '—'}</TableCell>
                    <TableCell>{[e.reasonCode, e.reasonText].filter(Boolean).join(': ') || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
