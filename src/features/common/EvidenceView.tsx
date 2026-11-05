import { AlertTriangle, CheckCircle2, Clock, Database, FileText, Gauge, XCircle } from 'lucide-react'
import { describeCheck } from '@/lib/audit/dqdAuditor'
import type { SiteEvidence } from '@/lib/studypack/evidence'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const SEV = {
  block: { icon: XCircle, cls: 'text-destructive', label: 'Block' },
  warn: { icon: AlertTriangle, cls: 'text-amber-700', label: 'Warn' },
} as const

function Issue({ severity, regulatory, children }: { severity: 'block' | 'warn'; regulatory: boolean; children: React.ReactNode }) {
  // In standard assurance nothing blocks; show it as a warning.
  const s = SEV[severity === 'block' && regulatory ? 'block' : 'warn']
  return (
    <div className={cn('flex items-start gap-1', s.cls)}>
      <s.icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}

function Section({ icon: Icon, title, ok, children }: { icon: typeof Gauge; title: string; ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-3">
      <div className="flex items-center gap-1.5 font-medium">
        <Icon className="size-4 text-muted-foreground" /> {title}
        {ok ? <CheckCircle2 className="ml-auto size-4 text-success" /> : <AlertTriangle className="ml-auto size-4 text-amber-600" />}
      </div>
      {children}
    </div>
  )
}

const Row = ({ k, v }: { k: string; v?: React.ReactNode }) => (
  <div className="flex gap-2"><span className="w-36 shrink-0 text-muted-foreground">{k}</span><span className="min-w-0 break-words">{v ?? '—'}</span></div>
)

/** Data quality, provenance, execution log and time evidence for one site (requirements R2–R5). */
export function EvidenceView({ evidence: e }: { evidence: SiteEvidence }) {
  const regulatory = e.assurance === 'regulatory'
  const g = e.dqdGate
  const p = e.provenance
  const cs = p.cdmSource
  return (
    <div className="grid gap-3 text-xs lg:grid-cols-2">
      <Section icon={Gauge} title="Data-quality gate (DQD)" ok={g.counts.block === 0 && g.counts.warn === 0}>
        <Row k="Policy" v={<>{e.dqdPolicy.policyVersion} <Badge variant="outline" className="text-[10px]">{e.dqdPolicySource === 'protocol' ? 'pinned by protocol' : 'derived from analysis spec'}</Badge></>} />
        <Row k="Study tables" v={e.dqdPolicy.studyTables.join(', ')} />
        <Row k="Checks evaluated" v={g.present ? `${g.checksEvaluated.toLocaleString()} (DQD ${g.metadata.dqdVersion ?? '?'})` : 'DQD results not loaded'} />
        <div className="flex gap-1.5">
          <Badge variant={g.counts.block ? 'destructive' : 'outline'}>block {g.counts.block}</Badge>
          <Badge variant={g.counts.warn ? 'warning' : 'outline'}>warn {g.counts.warn}</Badge>
          <Badge variant="outline">info {g.counts.info}</Badge>
        </div>
        {g.findings.filter((f) => f.severity !== 'info').slice(0, 12).map((f, i) => (
          <Issue key={i} severity={f.severity as 'block' | 'warn'} regulatory={regulatory}>
            {f.check ? describeCheck(f.check) : f.rationale}
          </Issue>
        ))}
      </Section>

      <Section icon={Database} title="CDM, vocabulary and software provenance" ok={p.issues.length === 0}>
        <Row k="CDM source" v={cs ? `${cs.cdmSourceName ?? '—'}${cs.databaseId ? ` (${cs.databaseId})` : ''}` : undefined} />
        <Row k="CDM / vocabulary" v={cs ? `CDM ${cs.cdmVersion ?? '?'} · ${cs.vocabularyVersion ?? '?'}` : undefined} />
        <Row k="Source / CDM release" v={cs ? `${cs.sourceReleaseDate ?? '—'} / ${cs.cdmReleaseDate ?? '—'}` : undefined} />
        <Row k="DQD ran on" v={p.dqd ? `${p.dqd.cdmSourceName ?? '—'} · ${p.dqd.vocabularyVersion ?? '—'}` : undefined} />
        <Row k="R / HADES" v={p.software.r || Object.keys(p.software.packages).length ? `R ${p.software.r ?? '?'} · ${Object.entries(p.software.packages).map(([k, v]) => `${k} ${v}`).join(', ')}` : undefined} />
        <Row k="Modules with results" v={p.modules.expected.length ? `${p.modules.expected.length - p.modules.missing.length}/${p.modules.expected.length}` : p.modules.present.join(', ')} />
        {p.issues.map((i) => <Issue key={i.code} severity={i.severity} regulatory={regulatory}>{i.message}</Issue>)}
      </Section>

      <Section icon={FileText} title="Execution log" ok={!!e.log && e.log.counts.ERROR + e.log.counts.FATAL === 0}>
        {e.log ? (
          <>
            <Row k="Entries" v={`${e.log.entries.toLocaleString()} timestamped lines (${e.log.firstTimestamp ?? '?'} → ${e.log.lastTimestamp ?? '?'})`} />
            <Row k="Levels" v={`ERROR ${e.log.counts.ERROR + e.log.counts.FATAL} · WARN ${e.log.counts.WARN} · INFO ${e.log.counts.INFO}`} />
            {e.log.minCellCounts.length > 0 && <Row k="minCellCount in log" v={e.log.minCellCounts.join(', ')} />}
            {e.log.errors.slice(0, 5).map((m) => <Issue key={m.line} severity="warn" regulatory={regulatory}>line {m.line}: {m.text}</Issue>)}
          </>
        ) : (
          <Issue severity="block" regulatory={regulatory}>No Strategus execution log loaded (logs/execution.log)</Issue>
        )}
      </Section>

      <Section icon={Clock} title="Time evidence" ok={e.timeline.issues.length === 0}>
        {e.timeline.events.map((t) => (
          <Row key={t.key} k={t.label} v={<>{t.at} <span className="text-muted-foreground">({t.source}{t.zoneKnown ? '' : ', local time'})</span></>} />
        ))}
        {e.timeline.trustedWindow && (
          <div className="text-muted-foreground">
            Without a trusted clock offline, the seal time is only bounded by the protocol issue time{e.timeline.trustedWindow.to ? ' and the coordinator receipt time' : ''}.
          </div>
        )}
        {e.timeline.issues.map((i, n) => <Issue key={n} severity={i.severity} regulatory={regulatory}>{i.message}</Issue>)}
      </Section>
    </div>
  )
}
