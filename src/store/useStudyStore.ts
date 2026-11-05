/**
 * Single Zustand store: current role mode, site artifacts + audit state, and admin workspace.
 * Everything lives in memory only (no persistence, no network).
 */
import { create } from 'zustand'
import { auditWorkbook, remediateCsvText, remediateWorkbook, type AuditOptions, type AuditResult, type MaskStyle } from '@/lib/audit/cellAuditor'
import { redactLog } from '@/lib/audit/logAuditor'
import { sha256Hex } from '@/lib/integrity/hasher'
import { SLOT_BY_ID, type SlotId } from '@/lib/studypack/slots'
import type { FileModification } from '@/lib/studypack/builder'
import type { IssuedProtocol, ProtocolRead, StudyRepo } from '@/lib/strategus/protocol'
import { executionSettingsMinCellCount, inputMinCellCount, protectedSectionHash } from '@/lib/strategus/executeScript'
import { auditResultFiles, collectRdms, auditOptionsFor, type ResultFile } from '@/lib/strategus/results'
import { loadStudyPack, type LoadedSitePack } from '@/lib/network/aggregator'
import { DEFAULT_REASON_CODES, DispositionLog, type Actor } from '@/lib/network/dispositionLog'
import type { SignatureCheck, SignatureMeaning, SignerRoster, UnlockedSigner } from '@/lib/security/signer'
import type { RoleMode, StudyConfig } from '@/types/studypack'

export interface SlotFile {
  name: string
  bytes: Uint8Array
  sha256: string
  /** SHA-256 of the protocol-protected section (ExecuteAnalyses.R). */
  protectedSha256?: string
  size: number
  remediated: boolean
  fromProtocol: boolean
  audit?: AuditResult
  error?: string
  /** The file before masking/redaction. Stays in memory; only a salted commitment is packed. */
  original?: Uint8Array
  modification?: FileModification
}

export interface ResultsBundle {
  /** Name of the dropped ZIP or folder. */
  source: string
  /** Keyed by path relative to the results root, e.g. "CohortMethodModule/cm_result.csv". */
  files: Record<string, SlotFile>
}

/** The protocol as received at the site (sealed into the pack as-is). */
export interface ReceivedProtocol {
  bytes: Uint8Array
  signatureBytes?: Uint8Array
  signatureChecks?: SignatureCheck[]
}

export interface ActiveSigner {
  signer: UnlockedSigner
  meaning: SignatureMeaning
}

interface StudyState {
  mode: RoleMode
  siteId: string
  config?: StudyConfig
  protocol?: ReceivedProtocol
  slots: Partial<Record<SlotId, SlotFile>>
  results?: ResultsBundle
  busy: Partial<Record<SlotId | 'results', boolean>>
  /** Signing keys unlocked in this session (site: operator / PI; admin: coordinator). */
  signers: ActiveSigner[]

  // admin workspace
  repo?: StudyRepo
  issued?: IssuedProtocol
  sites: LoadedSitePack[]
  roster?: SignerRoster
  /** Who is making disposition entries in this session. */
  actor?: Actor
  log: DispositionLog
  /** Bumped on every log change so subscribers re-render. */
  logRev: number

  setMode: (m: RoleMode) => void
  setSiteId: (s: string) => void
  setConfig: (c: StudyConfig | undefined, protocolFiles?: Record<string, Uint8Array>, received?: ProtocolRead) => Promise<void>
  ingest: (slotId: SlotId, name: string, bytes: Uint8Array, opts?: { fromProtocol?: boolean; remediated?: boolean; original?: Uint8Array; modification?: FileModification }) => Promise<void>
  remove: (slotId: SlotId) => void
  ingestResults: (source: string, files: ResultFile[]) => Promise<void>
  removeResults: () => void
  remediate: (slotId: SlotId, style: MaskStyle) => Promise<void>
  remediateAll: (style: MaskStyle) => Promise<void>
  resetSite: () => void
  addSigner: (s: UnlockedSigner) => void
  removeSigner: (kid: string) => void

  setRepo: (r?: StudyRepo) => void
  setIssued: (p?: IssuedProtocol) => void
  setRoster: (r?: SignerRoster) => void
  setActor: (a?: Actor) => void
  addSitePacks: (files: { name: string; bytes: Uint8Array }[]) => Promise<string[]>
  removeSite: (key: string) => Promise<void>
  decide: (key: string, to: 'adopt' | 'exclude', recommended: 'adopt' | 'exclude', reasonCode?: string, reasonText?: string) => Promise<void>
  lockDispositions: (statement: string) => Promise<void>
  logExport: (details: Record<string, unknown>) => Promise<void>
  importLog: (jsonl: string, head?: { headHash: string; entries: number }) => Promise<void>
  clearSites: () => Promise<void>
}

const dec = new TextDecoder()
const enc = new TextEncoder()

function auditOpts(config?: StudyConfig): AuditOptions {
  return { minCellCount: config?.minCellCount ?? 5, countColumnPatterns: config?.countColumnPatterns }
}

function validate(slotId: SlotId, bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0) return 'File is empty'
  const path = SLOT_BY_ID[slotId].path
  if (path.endsWith('.json') || path.endsWith('.lock')) {
    try {
      JSON.parse(dec.decode(bytes))
    } catch {
      return 'Not valid JSON'
    }
  }
  return undefined
}

async function toSlotFile(name: string, bytes: Uint8Array, extra: Partial<SlotFile> = {}): Promise<SlotFile> {
  return { name, bytes, sha256: await sha256Hex(bytes), size: bytes.byteLength, remediated: false, fromProtocol: false, ...extra }
}

const maskingRecord = (audit: AuditResult | undefined, min: number, style: MaskStyle): FileModification => ({
  kind: 'small-cell-masking',
  rule: `Counts with 0 < n < ${min} replaced by ${style === 'negative' ? `-${min}` : style === 'lt' ? `<${min}` : 'NA'}; direct-identifier columns dropped`,
  counts: { maskedCells: audit?.smallCellCount ?? 0, droppedIdentifierColumns: audit?.identifierCount ?? 0 },
  reason: `Small-cell suppression required by the protocol (minCellCount ${min})`,
})

const meaningFor = (s: UnlockedSigner): SignatureMeaning => (s.signer.role === 'site-pi' ? 'approved-for-release' : 'sealed')

/** minCellCount the site actually exported with: executionSettings.json wins over the ExecuteAnalyses.R INPUTS block. */
export function exportedMinCellCount(slots: Partial<Record<SlotId, SlotFile>>): number | undefined {
  const es = slots.executionSettings
  if (es && !es.error) {
    try {
      const n = executionSettingsMinCellCount(JSON.parse(dec.decode(es.bytes)))
      if (n !== undefined) return n
    } catch {
      /* fall through */
    }
  }
  return slots.executeAnalyses ? inputMinCellCount(dec.decode(slots.executeAnalyses.bytes)) : undefined
}

/** StudyPack path → bytes for everything loaded at the site (input to evaluateEvidence). */
export function siteFiles(s: Pick<StudyState, 'slots' | 'results'>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const [id, f] of Object.entries(s.slots) as [SlotId, SlotFile][]) out[SLOT_BY_ID[id].path] = f.bytes
  for (const [p, f] of Object.entries(s.results?.files ?? {})) out[`results/${p}`] = f.bytes
  return out
}

export const useStudyStore = create<StudyState>((set, get) => {
  /** Append to the disposition log; the actor defaults to the session's identified coordinator. */
  const append = async (e: Parameters<DispositionLog['append']>[0]) => {
    const codes = get().config?.adoptionPolicy?.reasonCodes ?? DEFAULT_REASON_CODES
    await get().log.append(e, codes)
    set((s) => ({ logRev: s.logRev + 1 }))
  }
  const actorOrThrow = (): Actor => {
    const a = get().actor
    if (!a?.name.trim()) throw new Error('Identify yourself (name, role, organisation) before recording decisions')
    const kid = get().signers.find((x) => x.signer.signer.role === 'coordinator')?.signer.kid
    return kid ? { ...a, kid } : a
  }

  return {
    mode: 'site',
    siteId: '',
    slots: {},
    busy: {},
    signers: [],
    sites: [],
    log: new DispositionLog(),
    logRev: 0,

    setMode: (mode) => set({ mode }),
    setSiteId: (siteId) => set({ siteId }),

    setConfig: async (config, protocolFiles, received) => {
      set({
        config,
        protocol: config && received?.configBytes ? { bytes: received.configBytes, signatureBytes: received.signatureBytes, signatureChecks: received.signatureChecks } : undefined,
      })
      // Pre-fill protocol-distributed artifacts (analysis specification, execution script, renv.lock).
      for (const [path, bytes] of Object.entries(protocolFiles ?? {})) {
        const slot = Object.values(SLOT_BY_ID).find((s) => s.path === path)
        if (slot) await get().ingest(slot.id, path.split('/').pop()!, bytes, { fromProtocol: true })
      }
      // Re-audit with the protocol's minCellCount.
      const slots = { ...get().slots }
      if (slots.scanReport) slots.scanReport = { ...slots.scanReport, audit: auditWorkbook(slots.scanReport.bytes, slots.scanReport.name, auditOpts(config)) }
      set({ slots })
      const r = get().results
      if (r) await get().ingestResults(r.source, Object.entries(r.files).map(([path, f]) => ({ path, bytes: f.bytes })))
    },

    ingest: async (slotId, name, bytes, opts = {}) => {
      set((s) => ({ busy: { ...s.busy, [slotId]: true } }))
      try {
        let error = validate(slotId, bytes)
        let audit: AuditResult | undefined
        let content = bytes
        let original = opts.original
        let modification = opts.modification
        if (!error && slotId === 'executionLog' && !original) {
          // Redact credentials/hosts/user names; the original never leaves memory (R5.2–R5.4).
          const r = redactLog(dec.decode(bytes))
          if (r.redactions.length) {
            content = enc.encode(r.text)
            original = bytes
            modification = {
              kind: 'log-redaction',
              rule: 'Passwords, JDBC URLs, server/host, user names, home-directory names, e-mail and IP addresses replaced by [REDACTED]',
              counts: r.summary,
              reason: 'Remove credentials and identifying infrastructure details before the log leaves the site',
            }
          }
        }
        if (!error && SLOT_BY_ID[slotId].audited) {
          try {
            audit = auditWorkbook(content, name, auditOpts(get().config))
          } catch (e) {
            error = `Audit failed: ${String(e)}`
          }
        }
        const section = get().config?.protectedSections?.[SLOT_BY_ID[slotId].path]
        const protectedSha256 = slotId === 'executeAnalyses' ? await protectedSectionHash(dec.decode(content), section?.marker) : undefined
        const file = await toSlotFile(name, content, { remediated: !!opts.remediated, fromProtocol: !!opts.fromProtocol, audit, error, protectedSha256, original, modification })
        set((s) => ({ slots: { ...s.slots, [slotId]: file } }))
      } finally {
        set((s) => ({ busy: { ...s.busy, [slotId]: false } }))
      }
    },

    remove: (slotId) =>
      set((s) => {
        const slots = { ...s.slots }
        delete slots[slotId]
        return { slots }
      }),

    ingestResults: async (source, files) => {
      set((s) => ({ busy: { ...s.busy, results: true } }))
      try {
        const prev = get().results?.files ?? {}
        const audits = auditResultFiles(files, auditOpts(get().config))
        const out: Record<string, SlotFile> = {}
        for (const f of files) {
          const audit = audits.get(f.path)
          const old = prev[f.path]
          const keep = !!old && old.remediated && old.bytes === f.bytes
          out[f.path] = await toSlotFile(f.path.split('/').pop()!, f.bytes, {
            audit,
            remediated: keep,
            ...(keep ? { original: old.original, modification: old.modification } : {}),
          })
        }
        set({ results: { source, files: out } })
      } finally {
        set((s) => ({ busy: { ...s.busy, results: false } }))
      }
    },

    removeResults: () => set({ results: undefined }),

    remediate: async (slotId, style) => {
      const f = get().slots[slotId]
      if (!f || slotId !== 'scanReport') return
      const min = get().config?.minCellCount ?? 5
      const fixed = new Uint8Array(remediateWorkbook(f.bytes, auditOpts(get().config), style))
      await get().ingest(slotId, f.name, fixed, { remediated: true, fromProtocol: f.fromProtocol, original: f.original ?? f.bytes, modification: maskingRecord(f.audit, min, style) })
    },

    remediateAll: async (style) => {
      const scan = get().slots.scanReport
      if (scan?.audit && !scan.audit.passed) await get().remediate('scanReport', style)
      const r = get().results
      if (!r) return
      const base = auditOpts(get().config)
      const min = base.minCellCount ?? 5
      const list = Object.entries(r.files).map(([path, f]) => ({ path, bytes: f.bytes }))
      const rdms = collectRdms(list)
      const changed = new Map<string, Pick<SlotFile, 'original' | 'modification'>>()
      const fixed = list.map((f) => {
        const old = r.files[f.path]
        if (!old.audit || old.audit.passed) return f
        changed.set(f.path, { original: old.original ?? old.bytes, modification: maskingRecord(old.audit, min, style) })
        return { path: f.path, bytes: enc.encode(remediateCsvText(dec.decode(f.bytes), auditOptionsFor(f.path, rdms, base), style)) }
      })
      await get().ingestResults(r.source, fixed)
      set((s) => {
        if (!s.results) return {}
        const files = { ...s.results.files }
        for (const [p, c] of changed) if (files[p]) files[p] = { ...files[p], remediated: true, ...c }
        for (const [p, old] of Object.entries(r.files))
          if (old.remediated && files[p] && !changed.has(p)) files[p] = { ...files[p], remediated: true, original: old.original, modification: old.modification }
        return { results: { ...s.results, files } }
      })
    },

    resetSite: () => set({ slots: {}, results: undefined }),

    addSigner: (signer) => set((s) => ({ signers: [...s.signers.filter((x) => x.signer.kid !== signer.kid), { signer, meaning: meaningFor(signer) }] })),
    removeSigner: (kid) => set((s) => ({ signers: s.signers.filter((x) => x.signer.kid !== kid) })),

    setRepo: (repo) => set({ repo, issued: undefined }),
    setIssued: (issued) => set({ issued }),
    setRoster: (roster) => set({ roster }),
    setActor: (actor) => set({ actor }),

    addSitePacks: async (files) => {
      const actor = actorOrThrow()
      const min = get().config?.minCellCount ?? 5
      const loaded = await Promise.all(files.map((f) => loadStudyPack(f.name, f.bytes, min)))
      const dupes: string[] = []
      const keys = new Set(get().sites.map((x) => x.key))
      const fresh = loaded.filter((l) => {
        if (keys.has(l.key)) {
          dupes.push(l.fileName)
          return false
        }
        keys.add(l.key)
        return true
      })
      set((s) => ({ sites: [...s.sites, ...fresh] }))
      for (const l of fresh)
        await append({
          actor,
          action: 'received',
          siteId: l.siteId,
          packSha256: l.zipSha256,
          details: { fileName: l.fileName, integrity: l.integrity.status, signatures: l.signatureChecks.filter((c) => c.valid).length, sealedAt: l.manifest?.sealedAt?.utc ?? l.manifest?.generatedAt },
        })
      return dupes
    },

    removeSite: async (key) => {
      const site = get().sites.find((x) => x.key === key)
      set((s) => ({ sites: s.sites.filter((x) => x.key !== key) }))
      if (site && get().actor) await append({ actor: actorOrThrow(), action: 'note', siteId: site.siteId, packSha256: site.zipSha256, reasonText: 'Pack removed from this session (not a disposition decision)' })
    },

    decide: async (key, to, recommended, reasonCode, reasonText) => {
      const site = get().sites.find((x) => x.key === key)
      if (!site) return
      const current = get().log.decisions().get(site.zipSha256) ?? 'undecided'
      if (current === to) return
      await append({
        actor: actorOrThrow(),
        action: to,
        siteId: site.siteId,
        packSha256: site.zipSha256,
        from: current,
        to,
        recommended,
        deviatesFromRecommendation: to !== recommended,
        reasonCode: reasonCode || undefined,
        reasonText: reasonText?.trim() || undefined,
      })
    },

    lockDispositions: async (statement) => {
      const decisions = get().log.decisions()
      await append({
        actor: actorOrThrow(),
        action: 'lock',
        reasonText: statement,
        details: { sites: get().sites.map((s) => ({ siteId: s.siteId, packSha256: s.zipSha256, decision: decisions.get(s.zipSha256) ?? 'undecided' })) },
      })
    },

    logExport: async (details) => {
      await append({ actor: actorOrThrow(), action: 'export', details })
    },

    importLog: async (jsonl, head) => {
      const log = await DispositionLog.fromJsonl(jsonl, head)
      set((s) => ({ log, logRev: s.logRev + 1 }))
    },

    clearSites: async () => {
      const removed = get().sites
      set({ sites: [] })
      if (get().actor)
        for (const site of removed) await append({ actor: actorOrThrow(), action: 'note', siteId: site.siteId, packSha256: site.zipSha256, reasonText: 'Pack removed from this session (not a disposition decision)' })
    },
  }
})
