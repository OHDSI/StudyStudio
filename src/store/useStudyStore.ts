/**
 * Single Zustand store: current role mode, site artifacts + audit state, and admin workspace.
 * Everything lives in memory only (no persistence, no network).
 */
import { create } from 'zustand'
import { auditWorkbook, remediateCsvText, remediateWorkbook, type AuditOptions, type AuditResult, type MaskStyle } from '@/lib/audit/cellAuditor'
import { sha256Hex } from '@/lib/integrity/hasher'
import { SLOT_BY_ID, type SlotId } from '@/lib/studypack/slots'
import type { IssuedProtocol, StudyRepo } from '@/lib/strategus/protocol'
import { executionSettingsMinCellCount, inputMinCellCount, protectedSectionHash } from '@/lib/strategus/executeScript'
import { auditResultFiles, collectRdms, auditOptionsFor, type ResultFile } from '@/lib/strategus/results'
import { loadStudyPack, type LoadedSitePack } from '@/lib/network/aggregator'
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
}

export interface ResultsBundle {
  /** Name of the dropped ZIP or folder. */
  source: string
  /** Keyed by path relative to the results root, e.g. "CohortMethodModule/cm_result.csv". */
  files: Record<string, SlotFile>
}

interface StudyState {
  mode: RoleMode
  siteId: string
  config?: StudyConfig
  slots: Partial<Record<SlotId, SlotFile>>
  results?: ResultsBundle
  busy: Partial<Record<SlotId | 'results', boolean>>

  // admin workspace
  repo?: StudyRepo
  issued?: IssuedProtocol
  sites: LoadedSitePack[]
  /** Manual adopt/exclude override per site key. undefined = follow recommendation. */
  adoptOverride: Record<string, boolean | undefined>

  setMode: (m: RoleMode) => void
  setSiteId: (s: string) => void
  setConfig: (c: StudyConfig | undefined, protocolFiles?: Record<string, Uint8Array>) => Promise<void>
  ingest: (slotId: SlotId, name: string, bytes: Uint8Array, opts?: { fromProtocol?: boolean; remediated?: boolean }) => Promise<void>
  remove: (slotId: SlotId) => void
  ingestResults: (source: string, files: ResultFile[]) => Promise<void>
  removeResults: () => void
  remediate: (slotId: SlotId, style: MaskStyle) => Promise<void>
  remediateAll: (style: MaskStyle) => Promise<void>
  resetSite: () => void

  setRepo: (r?: StudyRepo) => void
  setIssued: (p?: IssuedProtocol) => void
  addSitePacks: (files: { name: string; bytes: Uint8Array }[]) => Promise<string[]>
  removeSite: (key: string) => void
  setAdopt: (key: string, v: boolean | undefined) => void
  clearSites: () => void
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

export const useStudyStore = create<StudyState>((set, get) => ({
  mode: 'site',
  siteId: '',
  slots: {},
  busy: {},
  sites: [],
  adoptOverride: {},

  setMode: (mode) => set({ mode }),
  setSiteId: (siteId) => set({ siteId }),

  setConfig: async (config, protocolFiles) => {
    set({ config })
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
      if (!error && SLOT_BY_ID[slotId].audited) {
        try {
          audit = auditWorkbook(bytes, name, auditOpts(get().config))
        } catch (e) {
          error = `Audit failed: ${String(e)}`
        }
      }
      const section = get().config?.protectedSections?.[SLOT_BY_ID[slotId].path]
      const protectedSha256 = slotId === 'executeAnalyses' ? await protectedSectionHash(dec.decode(bytes), section?.marker) : undefined
      const file = await toSlotFile(name, bytes, { remediated: !!opts.remediated, fromProtocol: !!opts.fromProtocol, audit, error, protectedSha256 })
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
        out[f.path] = await toSlotFile(f.path.split('/').pop()!, f.bytes, { audit, remediated: !!old && old.remediated && old.bytes === f.bytes })
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
    const fixed = new Uint8Array(remediateWorkbook(f.bytes, auditOpts(get().config), style))
    await get().ingest(slotId, f.name, fixed, { remediated: true, fromProtocol: f.fromProtocol })
  },

  remediateAll: async (style) => {
    const scan = get().slots.scanReport
    if (scan?.audit && !scan.audit.passed) await get().remediate('scanReport', style)
    const r = get().results
    if (!r) return
    const base = auditOpts(get().config)
    const list = Object.entries(r.files).map(([path, f]) => ({ path, bytes: f.bytes }))
    const rdms = collectRdms(list)
    const remediated = new Set<string>()
    const fixed = list.map((f) => {
      const a = r.files[f.path].audit
      if (!a || a.passed) return f
      remediated.add(f.path)
      return { path: f.path, bytes: enc.encode(remediateCsvText(dec.decode(f.bytes), auditOptionsFor(f.path, rdms, base), style)) }
    })
    await get().ingestResults(r.source, fixed)
    set((s) => {
      if (!s.results) return {}
      const files = { ...s.results.files }
      for (const p of remediated) if (files[p]) files[p] = { ...files[p], remediated: true }
      for (const [p, old] of Object.entries(r.files)) if (old.remediated && files[p]) files[p] = { ...files[p], remediated: true }
      return { results: { ...s.results, files } }
    })
  },

  resetSite: () => set({ slots: {}, results: undefined }),

  setRepo: (repo) => set({ repo, issued: undefined }),
  setIssued: (issued) => set({ issued }),

  addSitePacks: async (files) => {
    const min = get().config?.minCellCount ?? 5
    const loaded = await Promise.all(files.map((f) => loadStudyPack(f.name, f.bytes, min)))
    const dupes: string[] = []
    set((s) => {
      const keys = new Set(s.sites.map((x) => x.key))
      const fresh = loaded.filter((l) => {
        if (keys.has(l.key)) {
          dupes.push(l.fileName)
          return false
        }
        keys.add(l.key)
        return true
      })
      return { sites: [...s.sites, ...fresh] }
    })
    return dupes
  },
  removeSite: (key) => set((s) => ({ sites: s.sites.filter((x) => x.key !== key) })),
  setAdopt: (key, v) => set((s) => ({ adoptOverride: { ...s.adoptOverride, [key]: v } })),
  clearSites: () => set({ sites: [], adoptOverride: {} }),
}))
