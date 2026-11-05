import * as React from 'react'
import { KeyRound, Loader2, PenLine, Plus, Trash2 } from 'lucide-react'
import { useStudyStore } from '@/store/useStudyStore'
import {
  MIN_PASSPHRASE_LENGTH,
  createKeyFile,
  enrollmentCard,
  kidFingerprint,
  parseKeyFile,
  unlockKeyFile,
  type KeyFile,
  type SignerRole,
} from '@/lib/security/signer'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/input'
import { DropZone } from '@/features/common/DropZone'
import { download } from '@/lib/utils'
import { safeId } from '@/lib/studypack/builder'

const ROLE_LABEL: Record<SignerRole, string> = { operator: 'Operator (seals the pack)', 'site-pi': 'Site PI (approves release)', coordinator: 'Network coordinator' }
const dec = new TextDecoder()

/**
 * Unlock (or create) passphrase-protected signing keys for this session (requirements R1).
 * Keys are only held in memory; closing the page forgets them.
 */
export function SigningKeys({ roles, description }: { roles: SignerRole[]; description: string }) {
  const signers = useStudyStore((s) => s.signers).filter((x) => roles.includes(x.signer.signer.role))
  const addSigner = useStudyStore((s) => s.addSigner)
  const removeSigner = useStudyStore((s) => s.removeSigner)
  const [file, setFile] = React.useState<KeyFile>()
  const [pass, setPass] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [creating, setCreating] = React.useState(false)

  const unlock = async () => {
    if (!file) return
    setBusy(true)
    setError(undefined)
    try {
      if (!roles.includes(file.signer.role)) throw new Error(`This key is for the ${file.signer.role} role; this step needs ${roles.join(' or ')}`)
      addSigner(await unlockKeyFile(file, pass))
      setFile(undefined)
      setPass('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm"><PenLine className="size-4" /> Electronic signature</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs">
        {signers.map(({ signer: s, meaning }) => (
          <div key={s.kid} className="flex flex-wrap items-center gap-2 rounded-md border bg-success/5 p-2">
            <KeyRound className="size-4 text-success" />
            <span className="font-medium">{s.signer.name}</span>
            <span className="text-muted-foreground">{s.signer.organization}</span>
            <Badge variant="outline">{s.signer.role}</Badge>
            <Badge variant="secondary">{s.signer.role === 'coordinator' ? 'signs: protocol, roster, disposition log' : `signs as: ${meaning}`}</Badge>
            <code className="text-muted-foreground" title={s.kid}>{kidFingerprint(s.kid)}</code>
            <Button size="icon" variant="ghost" className="ml-auto" onClick={() => removeSigner(s.kid)} aria-label="Lock key"><Trash2 /></Button>
          </div>
        ))}
        {!file ? (
          <DropZone
            compact
            accept=".json"
            onFiles={async (fs) => {
              setError(undefined)
              try {
                setFile(parseKeyFile(JSON.parse(dec.decode(fs[0].bytes))))
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            <span className="text-xs text-muted-foreground">Drop your signing key file (*.key.json) to unlock it</span>
          </DropZone>
        ) : (
          <div className="flex flex-wrap items-end gap-2 rounded-md border p-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{file.signer.name} <span className="text-muted-foreground">· {file.signer.role} · {kidFingerprint(file.kid)}</span></div>
              <Input type="password" autoFocus placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} className="mt-1 h-8" />
            </div>
            <Button size="sm" onClick={unlock} disabled={busy || !pass}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Unlock</Button>
            <Button size="sm" variant="ghost" onClick={() => setFile(undefined)}>Cancel</Button>
          </div>
        )}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {creating ? <CreateKey roles={roles} onDone={() => setCreating(false)} /> : (
          <Button size="sm" variant="ghost" className="w-fit" onClick={() => setCreating(true)}><Plus /> Create a signing key</Button>
        )}
      </CardContent>
    </Card>
  )
}

function CreateKey({ roles, onDone }: { roles: SignerRole[]; onDone: () => void }) {
  const [form, setForm] = React.useState({ name: '', organization: '', role: roles[0], pass: '', pass2: '' })
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [created, setCreated] = React.useState<KeyFile>()

  const create = async () => {
    setError(undefined)
    if (form.pass !== form.pass2) return setError('Passphrases do not match')
    setBusy(true)
    try {
      const k = await createKeyFile({ name: form.name, organization: form.organization, role: form.role }, form.pass)
      const base = `${safeId(form.name)}_${k.kid.slice(0, 8)}`
      download(`${base}.key.json`, JSON.stringify(k, null, 2) + '\n', 'application/json')
      download(`${base}.enrollment.json`, JSON.stringify(enrollmentCard(k), null, 2) + '\n', 'application/json')
      setCreated(k)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (created)
    return (
      <Alert variant="success">
        <AlertDescription>
          <p>Saved <b>*.key.json</b> (keep it yourself; never send it) and <b>*.enrollment.json</b> (send it to the coordinator).</p>
          <p className="mt-1">Read this fingerprint to the coordinator by phone or video so they can verify the enrollment card: <code className="font-semibold">{kidFingerprint(created.kid)}</code></p>
          <Button size="sm" variant="outline" className="mt-2" onClick={onDone}>Done</Button>
        </AlertDescription>
      </Alert>
    )

  return (
    <div className="grid gap-2 rounded-md border p-3 md:grid-cols-2">
      <Field label="Full name (printed on signatures)"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
      <Field label="Organisation"><Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} /></Field>
      <Field label="Role">
        <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as SignerRole })}>
          {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </Select>
      </Field>
      <div />
      <Field label={`Passphrase (≥ ${MIN_PASSPHRASE_LENGTH} characters)`}><Input type="password" value={form.pass} onChange={(e) => setForm({ ...form, pass: e.target.value })} /></Field>
      <Field label="Repeat passphrase"><Input type="password" value={form.pass2} onChange={(e) => setForm({ ...form, pass2: e.target.value })} /></Field>
      <p className="text-[11px] text-muted-foreground md:col-span-2">The key is generated in this browser. Only an encrypted copy is saved; there is no way to recover a forgotten passphrase — create a new key and have it enrolled.</p>
      {error && <Alert variant="destructive" className="md:col-span-2"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex gap-2 md:col-span-2">
        <Button size="sm" onClick={create} disabled={busy || !form.name.trim() || form.pass.length < MIN_PASSPHRASE_LENGTH}>{busy ? <Loader2 className="animate-spin" /> : <KeyRound />} Create and save key</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  )
}
