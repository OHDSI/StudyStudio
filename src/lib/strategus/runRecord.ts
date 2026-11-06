/**
 * Run record written by recordStrategusRun() (r/recordStrategusRun.R) right after Strategus::execute()
 * (requirements R5.5).
 *
 * The record lists, for each run, the SHA-256 of the analysis specification, renv.lock and the protected
 * section of the execution script, the R / package versions loaded in that session, and the SHA-256 of
 * every file the run left in the results folder. Comparing it with the files sealed into the StudyPack
 * shows whether the sealed results are the ones that run wrote, from the protocol's inputs.
 *
 * The record is written on the site's machine. It detects files that changed between the run and the
 * seal, and runs that did not use the protocol's inputs; it does not prove that the site could not have
 * produced it some other way.
 *
 * Privacy: a plain SHA-256 of a results file that was later masked would let anyone recover the masked
 * values by trying 1…(minCellCount−1). Before sealing, `redactRunRecord` withholds those hashes; the
 * manifest's salted commitment covers the original instead (R5.3).
 */
import { hashesEqual, sha256Hex } from '@/lib/integrity/hasher'
import { protectedSectionHash } from './executeScript'
import { PROTOCOL_PATHS } from './protocol'
import { normalizeResultPaths } from './results'
import { HADES_PACKAGE } from '@/lib/provenance/cdmSource'

export const RUN_RECORD_FORMAT = 'studypack-run-record/1'
export const RUN_RECORD_FILE = 'run_record.json'
/** Where the record is sealed inside the StudyPack. */
export const RUN_RECORD_PACK_PATH = 'evidence/run_record.json'
export const WITHHELD = 'masked-at-site'

export interface RunRecordFileEntry {
  /** Relative to the results folder, e.g. "CohortMethodModule/cm_result.csv". */
  path: string
  sha256?: string
  sizeBytes?: number
  /** Last modification time when the run finished (ISO with offset). */
  modifiedAt?: string
  /** The hash is withheld because the file was masked at the site before sealing. */
  withheld?: typeof WITHHELD
}

export interface RunRecordInput {
  file?: string | null
  sha256?: string | null
  /** Execution script only: SHA-256 of the section below the protected marker. */
  protectedSha256?: string | null
}

export interface RunRecordRun {
  startedAt?: string
  /** The results folder's file-system clock at the start (it can differ from the R machine's clock on a share). */
  startedAtFileSystem?: string | null
  finishedAt?: string
  status?: 'completed' | 'failed'
  errorClass?: string | null
  /** Per-module outcome returned by Strategus::execute() (no error messages). */
  modules?: { module: string; status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; skippedAsCompleted?: boolean }[] | null
  r?: string
  platform?: string
  packages?: Record<string, string>
  inputs?: { analysisSpecifications?: RunRecordInput; executionScript?: RunRecordInput; renvLock?: RunRecordInput }
  results?: RunRecordFileEntry[]
}

export interface RunRecord {
  format: typeof RUN_RECORD_FORMAT
  runs: RunRecordRun[]
}

const dec = new TextDecoder()
const enc = new TextEncoder()

export function parseRunRecord(bytes: Uint8Array): RunRecord {
  let j: unknown
  try {
    j = JSON.parse(dec.decode(bytes))
  } catch {
    throw new Error('run_record.json is not valid JSON')
  }
  const o = j as Partial<RunRecord>
  if (o?.format !== RUN_RECORD_FORMAT) throw new Error(`run_record.json has format ${JSON.stringify(o?.format)}, expected ${RUN_RECORD_FORMAT}`)
  if (!Array.isArray(o.runs) || o.runs.length === 0) throw new Error('run_record.json lists no runs')
  return o as RunRecord
}

/**
 * StudyPack path of each file a run recorded, for the files that are packed. CSV paths are normalised
 * like a dropped results folder (normalizeResultPaths), so the record still lines up when R was given a
 * parent of the Strategus results folder; executionSettings.json is the shallowest one recorded.
 */
export function recordedPackPaths(entries: readonly Pick<RunRecordFileEntry, 'path'>[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const [recorded, rel] of normalizeResultPaths(entries.map((e) => e.path))) out.set(recorded, `results/${rel}`)
  const settings = entries
    .map((e) => e.path)
    .filter((p) => p.split('/').pop() === 'executionSettings.json')
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (settings) out.set(settings, 'code/executionSettings.json')
  return out
}

/**
 * Copy of the record with the hash and size of every masked results file withheld.
 * Returns undefined when nothing needs to be withheld (the record is then packed unchanged).
 */
export function redactRunRecord(bytes: Uint8Array, maskedPackPaths: Iterable<string>): { bytes: Uint8Array; withheld: number } | undefined {
  const masked = new Set(maskedPackPaths)
  if (masked.size === 0) return undefined
  let record: RunRecord
  try {
    record = parseRunRecord(bytes)
  } catch {
    return undefined
  }
  let withheld = 0
  const runs = record.runs.map((run) => {
    const paths = recordedPackPaths(run.results ?? [])
    const results = (run.results ?? []).map((f) => {
      const p = paths.get(f.path)
      if (!p || !masked.has(p) || f.withheld) return f
      withheld++
      return { path: f.path, modifiedAt: f.modifiedAt, withheld: WITHHELD }
    })
    return { ...run, results }
  })
  if (!withheld) return undefined
  return { bytes: enc.encode(JSON.stringify({ ...record, runs }, null, 2) + '\n'), withheld }
}

export interface RunRecordIssue {
  severity: 'block' | 'warn'
  code: string
  message: string
}

export interface InputCheck {
  key: 'analysisSpecifications' | 'executionScript' | 'renvLock'
  path: string
  recorded?: string
  actual?: string
  status: 'match' | 'mismatch' | 'not-recorded' | 'not-packed'
  /** Execution script only: compared as a whole file because it has no protected marker. */
  wholeFile?: boolean
}

export interface RunRecordReport {
  present: boolean
  error?: string
  runs: number
  last?: Pick<RunRecordRun, 'startedAt' | 'finishedAt' | 'status' | 'errorClass' | 'r' | 'platform' | 'modules'> & { strategus?: string }
  inputs: InputCheck[]
  results: {
    /** Files of the last run that are packed (CSV results and executionSettings.json). */
    recorded: number
    matched: number
    mismatched: string[]
    /** Packed results the run did not write. */
    notRecorded: string[]
    /** Results the run wrote that are not in the pack. */
    notPacked: string[]
    /** Hashes withheld because the file was masked at the site. */
    withheld: number
    /** Withheld although the pack does not declare the file as masked. */
    withheldUndeclared: string[]
    /** Last modified before the last run started, and not written with that content by an earlier run with the same inputs. */
    stale: string[]
  }
  environment: { checked: number; mismatches: { package: string; locked: string; loaded: string; hades: boolean }[]; rLocked?: string; rLoaded?: string }
  issues: RunRecordIssue[]
}

/**
 * Pre-specified exclusion reason for a blocking run-record issue: the run used other inputs or HADES
 * versions than the protocol (a protocol deviation), or the record does not vouch for the sealed results.
 */
export function runRecordReasonCode(issue: Pick<RunRecordIssue, 'code'>): 'PROTOCOL_DEVIATION' | 'INTEGRITY' {
  return /^input-[A-Za-z]+$/.test(issue.code) || issue.code === 'env-hades' ? 'PROTOCOL_DEVIATION' : 'INTEGRITY'
}

export interface RunRecordHashes {
  /** SHA-256 of each file as it will be (or was) sealed, keyed by StudyPack path. */
  file: Record<string, string>
  /** SHA-256 of a file before it was masked at the site (site side only). */
  original?: Record<string, string>
  /** SHA-256 of protected sections, keyed by StudyPack path (code/ExecuteAnalyses.R). */
  section?: Record<string, string>
}

export interface RunRecordCheckInput {
  bytes?: Uint8Array
  regulatory: boolean
  hashes: RunRecordHashes
  /** StudyPack paths the manifest declares as modified (with a salted commitment to the original). */
  declaredModified?: Iterable<string>
  renvLockText?: string
}

/** Same analysis specification, execution script and renv.lock (by the hashes each run recorded). */
function sameInputs(a: RunRecordRun, b: RunRecordRun): boolean {
  const keys = ['analysisSpecifications', 'executionScript', 'renvLock'] as const
  const same = (x?: string | null, y?: string | null) => !!x && !!y && hashesEqual(x, y)
  return keys.every((k) => same(a.inputs?.[k]?.sha256, b.inputs?.[k]?.sha256) || same(a.inputs?.[k]?.protectedSha256, b.inputs?.[k]?.protectedSha256))
}

function groupByPackPath(run: RunRecordRun): Map<string, RunRecordFileEntry[]> {
  const out = new Map<string, RunRecordFileEntry[]>()
  const paths = recordedPackPaths(run.results ?? [])
  for (const f of run.results ?? []) {
    const p = paths.get(f.path)
    if (p) out.set(p, [...(out.get(p) ?? []), f])
  }
  return out
}

/**
 * Whether the file was last modified during the run, on the file system's own clock when recorded
 * (2 s slack for file systems with coarse times). Unknown counts as yes.
 */
function writtenDuring(f: RunRecordFileEntry, run: RunRecordRun): boolean {
  const m = Date.parse(f.modifiedAt ?? '')
  const s = Date.parse(run.startedAtFileSystem ?? run.startedAt ?? '')
  return Number.isNaN(m) || Number.isNaN(s) || m >= s - 2000
}

const isPackedResult = (p: string) => p.startsWith('results/') && /\.csv$/i.test(p)

export function checkRunRecord(input: RunRecordCheckInput): RunRecordReport {
  const issues: RunRecordIssue[] = []
  const sev = (block: boolean): 'block' | 'warn' => (block && input.regulatory ? 'block' : 'warn')
  const empty: RunRecordReport = {
    present: !!input.bytes,
    runs: 0,
    inputs: [],
    results: { recorded: 0, matched: 0, mismatched: [], notRecorded: [], notPacked: [], withheld: 0, withheldUndeclared: [], stale: [] },
    environment: { checked: 0, mismatches: [] },
    issues,
  }
  if (!input.bytes) {
    if (input.regulatory) issues.push({ severity: 'block', code: 'missing', message: 'Run record is missing (run_record.json, written by recordStrategusRun() in ExecuteAnalyses.R)' })
    return empty
  }
  let record: RunRecord
  try {
    record = parseRunRecord(input.bytes)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    issues.push({ severity: sev(true), code: 'invalid', message: error })
    return { ...empty, error }
  }

  const run = record.runs[record.runs.length - 1]
  const report: RunRecordReport = {
    ...empty,
    runs: record.runs.length,
    last: { startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, errorClass: run.errorClass, modules: run.modules, r: run.r, platform: run.platform, strategus: run.packages?.Strategus },
  }
  const notDone = (run.modules ?? []).filter((m) => m.status === 'FAILED' || (m.status === 'SKIPPED' && !m.skippedAsCompleted)).map((m) => `${m.module} ${m.status.toLowerCase()}`)
  if (run.status !== 'completed' || notDone.length)
    issues.push({ severity: sev(true), code: 'run-failed', message: `The last recorded run did not complete (${run.status ?? 'no status'}${run.errorClass ? `, ${run.errorClass}` : ''}${notDone.length ? `: ${notDone.join(', ')}` : ''})` })
  // Strategus::execute() loads the Strategus namespace; a "run" without it did not execute the study.
  if (!run.packages?.Strategus) issues.push({ severity: sev(true), code: 'no-strategus', message: 'Strategus was not loaded in the last recorded run, so it did not call Strategus::execute()' })

  // Inputs: what the run read vs. what is sealed (the protocol's copies).
  const h = input.hashes
  const inputCheck = (key: InputCheck['key'], path: string, recorded: string | null | undefined, actual: string | undefined): InputCheck => ({
    key,
    path,
    recorded: recorded ?? undefined,
    actual,
    status: !recorded ? 'not-recorded' : !actual ? 'not-packed' : hashesEqual(recorded, actual) ? 'match' : 'mismatch',
  })
  // A script without the protected marker is pinned as a whole file, so the whole file is compared.
  const wholeScript = !h.section?.[PROTOCOL_PATHS.executeAnalyses] && !!h.file[PROTOCOL_PATHS.executeAnalyses]
  report.inputs = [
    inputCheck('analysisSpecifications', PROTOCOL_PATHS.analysisSpecifications, run.inputs?.analysisSpecifications?.sha256, h.file[PROTOCOL_PATHS.analysisSpecifications]),
    !wholeScript
      ? inputCheck('executionScript', PROTOCOL_PATHS.executeAnalyses, run.inputs?.executionScript?.protectedSha256, h.section?.[PROTOCOL_PATHS.executeAnalyses])
      : { ...inputCheck('executionScript', PROTOCOL_PATHS.executeAnalyses, run.inputs?.executionScript?.sha256, h.file[PROTOCOL_PATHS.executeAnalyses]), wholeFile: true },
    inputCheck('renvLock', PROTOCOL_PATHS.renvLock, run.inputs?.renvLock?.sha256, h.file[PROTOCOL_PATHS.renvLock]),
  ]
  for (const c of report.inputs) {
    const name = c.path.split('/').pop()
    if (c.status === 'mismatch') issues.push({ severity: sev(true), code: `input-${c.key}`, message: `The run used a different ${c.key === 'executionScript' && !wholeScript ? `${name} (protected section)` : name} than the one sealed in the pack` })
    if (c.status === 'not-recorded') issues.push({ severity: sev(true), code: `input-${c.key}-unrecorded`, message: `The run record has no hash for ${name}${c.key === 'executionScript' ? (wholeScript ? ' (script path not found)' : ' (script path or protected marker not found)') : ''}` })
  }

  // Results: every packed results file must be one the run wrote, unchanged.
  const declared = new Set(input.declaredModified ?? [])
  const r = report.results
  // Group by StudyPack path: a folder given to R that also holds other outputs can map two entries to one path.
  // A file left by an earlier run is fine when an earlier run with the same inputs wrote it with this content.
  // That run need not have completed: with skipCompletedTasks, Strategus skips the modules a failed run finished.
  const earlier = record.runs.slice(0, -1).filter((x) => sameInputs(x, run)).map((x) => Object.assign(groupByPackPath(x), { run: x }))
  const byPackPath = groupByPackPath(run)
  for (const [p, entries] of byPackPath) {
    const packed = h.file[p]
    if (!packed) {
      if (isPackedResult(p)) r.notPacked.push(p)
      continue
    }
    r.recorded++
    if (entries.some((f) => f.withheld)) {
      r.withheld++
      if (!declared.has(p) && !h.original?.[p]) r.withheldUndeclared.push(p)
      continue
    }
    const actual = h.original?.[p] ?? packed
    const hit = entries.find((f) => f.sha256 && hashesEqual(f.sha256, actual))
    if (!hit) {
      r.mismatched.push(p)
      continue
    }
    r.matched++
    // Only result CSVs: ExecuteAnalyses.R saves executionSettings.json just before it calls the wrapper.
    if (isPackedResult(p) && !writtenDuring(hit, run) && !earlier.some((e) => e.get(p)?.some((f) => f.sha256 && hashesEqual(f.sha256, actual) && writtenDuring(f, e.run)))) r.stale.push(p)
  }
  r.notRecorded = Object.keys(h.file).filter((p) => isPackedResult(p) && !byPackPath.has(p))
  const list = (ps: string[]) => ps.slice(0, 5).join(', ') + (ps.length > 5 ? ` and ${ps.length - 5} more` : '')
  if (r.mismatched.length) issues.push({ severity: sev(true), code: 'results-changed', message: `${r.mismatched.length} file(s) differ from what the run wrote: ${list(r.mismatched)}` })
  if (r.notRecorded.length) issues.push({ severity: sev(true), code: 'results-unrecorded', message: `${r.notRecorded.length} packed result file(s) were not written by the recorded run: ${list(r.notRecorded)}` })
  if (r.withheldUndeclared.length) issues.push({ severity: sev(true), code: 'withheld-undeclared', message: `Hashes withheld for files the manifest does not declare as masked: ${list(r.withheldUndeclared)}` })
  if (r.stale.length) issues.push({ severity: sev(true), code: 'results-stale', message: `${r.stale.length} file(s) were not written by the last run, nor by an earlier run with the same inputs: ${list(r.stale)}` })
  if (r.notPacked.length) issues.push({ severity: 'warn', code: 'results-not-packed', message: `${r.notPacked.length} result file(s) the run wrote are not in the pack: ${list(r.notPacked)}` })

  // Environment: packages loaded in the run vs. renv.lock.
  if (input.renvLockText && run.packages) {
    try {
      const lock = JSON.parse(input.renvLockText) as { R?: { Version?: string }; Packages?: Record<string, { Version?: string }> }
      const env = report.environment
      env.rLocked = lock.R?.Version
      env.rLoaded = run.r
      for (const [name, p] of Object.entries(lock.Packages ?? {})) {
        const loaded = run.packages[name]
        if (!loaded || !p.Version) continue
        env.checked++
        if (loaded !== p.Version) env.mismatches.push({ package: name, locked: p.Version, loaded, hades: HADES_PACKAGE.test(name) })
      }
      const hades = env.mismatches.filter((m) => m.hades)
      const other = env.mismatches.filter((m) => !m.hades)
      const fmt = (ms: typeof env.mismatches) => ms.map((m) => `${m.package} ${m.loaded} (renv.lock ${m.locked})`).join(', ')
      if (hades.length) issues.push({ severity: sev(true), code: 'env-hades', message: `HADES packages loaded in the run differ from renv.lock: ${fmt(hades)}` })
      if (other.length) issues.push({ severity: 'warn', code: 'env-other', message: `${other.length} other package(s) differ from renv.lock: ${fmt(other.slice(0, 5))}${other.length > 5 ? ', …' : ''}` })
      if (env.rLocked && env.rLoaded && env.rLocked !== env.rLoaded) issues.push({ severity: 'warn', code: 'env-r', message: `The run used R ${env.rLoaded}; renv.lock records R ${env.rLocked}` })
    } catch {
      /* renv.lock problems are reported by the protocol checks */
    }
  }
  return report
}

/** Hashes for checkRunRecord from files keyed by StudyPack path (and, at the site, the masked originals). */
export async function runRecordHashes(files: Record<string, Uint8Array>, originals: Record<string, Uint8Array> = {}): Promise<RunRecordHashes> {
  const file: Record<string, string> = {}
  const original: Record<string, string> = {}
  for (const [p, b] of Object.entries(files)) file[p] = await sha256Hex(b)
  for (const [p, b] of Object.entries(originals)) original[p] = await sha256Hex(b)
  const script = files[PROTOCOL_PATHS.executeAnalyses]
  const section = script ? await protectedSectionHash(dec.decode(script)) : undefined
  return { file, original, section: section ? { [PROTOCOL_PATHS.executeAnalyses]: section } : {} }
}
