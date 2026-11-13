/**
 * Protocol issuance from a Strategus study repository. The ohdsi-studies/StrategusStudyRepoTemplate
 * layout is recognised, but not required: any repository with a Strategus analysis specification,
 * an R script that calls Strategus::execute() and a renv.lock works.
 * A repository without an analysis specification is an "R script" study: one R script (e.g. CodeToRun.R)
 * that writes aggregated CSVs, pinned the same way, with renv.lock optional and standard assurance only.
 * The coordinator's repository is the source of truth; OHDSI Study Studio pins its artifacts with SHA-256
 * and distributes them to sites as <studyId>_protocol.zip.
 */
import JSZip from 'jszip'
import { sha256Hex } from '@/lib/integrity/hasher'
import type { AssuranceLevel, FrameworkName, StudyConfig } from '@/types/studypack'
import { defaultDqdPolicy, studyTablesFor } from '@/lib/audit/dqdAuditor'
import { DEFAULT_REASON_CODES } from '@/lib/network/dispositionLog'
import { addSignature, parseJws, verifyDetachedJws, type DetachedJws, type SignatureCheck, type UnlockedSigner } from '@/lib/security/signer'
import { parseAnalysisSpecification, type AnalysisSpecSummary } from './spec'
import { PROTECTED_MARKER, protectedSectionHash, suggestMarker } from './executeScript'

export const PROTOCOL_PATHS = {
  analysisSpecifications: 'definitions/analysisSpecifications.json',
  executeAnalyses: 'code/ExecuteAnalyses.R',
  renvLock: 'code/renv.lock',
} as const

export interface RepoFile {
  path: string
  bytes: Uint8Array
}

export interface StudyRepo {
  /** Strategus when an analysis specification was found, else R script. Absent = Strategus. */
  kind?: FrameworkName
  specText?: string
  executeText?: string
  renvText?: string
  studyName?: string
  /** Which repository paths were picked, for display. */
  sources: Partial<Record<keyof typeof PROTOCOL_PATHS, string>>
  errors: string[]
}

const dec = new TextDecoder()
const enc = new TextEncoder()

/** Expand a GitHub "Download ZIP" (or any ZIP) of the study repository into files. */
export async function unzipRepo(data: ArrayBuffer | Uint8Array): Promise<RepoFile[]> {
  const zip = await JSZip.loadAsync(data)
  const out: RepoFile[] = []
  for (const [p, e] of Object.entries(zip.files)) if (!e.dir && !p.includes('..')) out.push({ path: p, bytes: await e.async('uint8array') })
  return out
}

const depth = (p: string) => p.split('/').length
const shallowest = (paths: string[]) => [...paths].sort((a, b) => depth(a) - depth(b))[0]

/** Locate the protocol artifacts inside a study repository. */
export function locateStudyRepo(files: RepoFile[]): StudyRepo {
  const paths = files.map((f) => f.path)
  const notVendored = (p: string) => !/(^|\/)(renv|extras|\.git)\//.test(p)
  const spec =
    shallowest(paths.filter((p) => /(^|\/)inst\/analysisSpecifications?\.json$/i.test(p))) ??
    shallowest(paths.filter((p) => /analysisSpecifications?\.json$/i.test(p) && !/(^|\/)es[A-Z_]?/i.test(p.split('/').pop()!) && notVendored(p)))
  const text0 = (p: string) => dec.decode(files.find((f) => f.path === p)!.bytes)
  const rScripts = paths.filter((p) => /\.R$/i.test(p) && notVendored(p))
  const execute =
    shallowest(paths.filter((p) => /(^|\/)ExecuteAnalyses\.R$/i.test(p) && notVendored(p))) ??
    shallowest(rScripts.filter((p) => /Strategus::execute\s*\(/.test(text0(p)))) ??
    // No Strategus: an R script study runs CodeToRun.R, or the repository's only top-level script.
    (spec ? undefined : shallowest(rScripts.filter((p) => /(^|\/)CodeToRun\.R$/i.test(p))) ?? onlyTopLevel(rScripts))
  const renv = shallowest(paths.filter((p) => /(^|\/)renv\.lock$/i.test(p) && notVendored(p)))
  const config = shallowest(paths.filter((p) => /(^|\/)config\.yml$/i.test(p) && notVendored(p)))
  const text = (p?: string) => (p ? dec.decode(files.find((f) => f.path === p)!.bytes) : undefined)

  const studyName = text(config)?.match(/^\s*studyName:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m)?.[1]?.trim()
  const executeText = text(execute)
  const kind: FrameworkName = spec || !executeText || /Strategus::execute\s*\(/.test(executeText) ? 'Strategus' : 'R script'
  const repo = { kind, specText: text(spec), executeText, renvText: text(renv) }
  return {
    ...repo,
    studyName,
    sources: { analysisSpecifications: spec, executeAnalyses: execute, renvLock: renv },
    errors: repoErrors(repo),
  }
}

function onlyTopLevel(paths: string[]): string | undefined {
  const top = paths.filter((p) => depth(p) === Math.min(...paths.map(depth)))
  return top.length === 1 ? top[0] : undefined
}

/** What is still missing before a protocol can be issued from these artifacts. */
export function repoErrors(r: Pick<StudyRepo, 'kind' | 'specText' | 'executeText' | 'renvText'>): string[] {
  if (r.kind === 'R script') return r.executeText ? [] : ['No R script found (CodeToRun.R, or a single .R file at the top of the repository)']
  const errors: string[] = []
  if (!r.specText) errors.push('analysisSpecifications.json not found (expected inst/analysisSpecifications.json)')
  if (!r.executeText) errors.push('No execution script found (ExecuteAnalyses.R or an .R file calling Strategus::execute())')
  if (!r.renvText) errors.push('renv.lock not found')
  return errors
}

export interface ProtocolMeta {
  studyId: string
  studyTitle: string
  description?: string
  principalInvestigator?: string
  sponsor?: string
  cdmVersion: string
  minCellCount: number
  now?: Date
  /** Defaults to standard. Regulatory pins the data-quality gate and reason codes and requires signatures. */
  assurance?: AssuranceLevel
  /** Exact vocabulary version every site must use (optional). */
  vocabularyVersion?: string
  /** Coordinator key: signs study_config.json so sites can verify who issued it. */
  signer?: UnlockedSigner
  /**
   * R script studies: the comment line below which the script is pinned. Undefined picks
   * suggestMarker(); null pins the whole file. Strategus studies always use the template marker.
   */
  marker?: string | null
}

export interface IssuedProtocol {
  config: StudyConfig
  /** study_config.json exactly as distributed (the bytes the signature covers). */
  configBytes: Uint8Array
  signature?: DetachedJws
  files: Record<string, Uint8Array>
  summary: AnalysisSpecSummary
}

export const PROTOCOL_SIGNATURE_FILE = 'study_config.jws.json'

export async function issueProtocol(repo: StudyRepo, meta: ProtocolMeta): Promise<IssuedProtocol> {
  if (repo.kind === 'R script') return issueRScriptProtocol(repo, meta)
  if (!repo.specText || !repo.executeText || !repo.renvText) throw new Error(repo.errors.join('; ') || 'Incomplete study repository')
  const summary = parseAnalysisSpecification(repo.specText)
  try {
    JSON.parse(repo.renvText)
  } catch {
    throw new Error('renv.lock is not valid JSON')
  }
  // With the template's marker, only the code below it is pinned (sites fill in the INPUTS block above).
  // Without it, the whole script is pinned, so sites must configure it without editing (e.g. env vars / config.yml).
  const sectionHash = await protectedSectionHash(repo.executeText)

  const files: Record<string, Uint8Array> = {
    [PROTOCOL_PATHS.analysisSpecifications]: enc.encode(repo.specText),
    [PROTOCOL_PATHS.executeAnalyses]: enc.encode(repo.executeText),
    [PROTOCOL_PATHS.renvLock]: enc.encode(repo.renvText),
  }
  const config: StudyConfig = {
    configVersion: '1.0.0',
    studyId: meta.studyId,
    studyTitle: meta.studyTitle || meta.studyId,
    description: meta.description || undefined,
    principalInvestigator: meta.principalInvestigator || undefined,
    sponsor: meta.sponsor || undefined,
    cdmVersion: meta.cdmVersion,
    issuedAt: (meta.now ?? new Date()).toISOString(),
    minCellCount: meta.minCellCount,
    framework: { name: 'Strategus', modules: summary.modules },
    cohorts: summary.cohorts.map((c) => ({ cohortId: c.cohortId, cohortName: c.cohortName, roles: c.roles })),
    expectedHashes: {
      [PROTOCOL_PATHS.analysisSpecifications]: await sha256Hex(files[PROTOCOL_PATHS.analysisSpecifications]),
      [PROTOCOL_PATHS.renvLock]: await sha256Hex(files[PROTOCOL_PATHS.renvLock]),
      ...(sectionHash ? {} : { [PROTOCOL_PATHS.executeAnalyses]: await sha256Hex(files[PROTOCOL_PATHS.executeAnalyses]) }),
    },
    protectedSections: sectionHash ? { [PROTOCOL_PATHS.executeAnalyses]: { marker: PROTECTED_MARKER, sha256: sectionHash } } : {},
  }
  if (meta.assurance === 'regulatory') {
    // Pre-specify the data-quality gate and the exclusion reasons before any site runs (R4.2, R6.1).
    config.assurance = 'regulatory'
    config.dataQuality = defaultDqdPolicy(studyTablesFor(summary.cohorts.map((c) => c.expression).filter(Boolean), summary.modules))
    config.adoptionPolicy = { reasonCodes: DEFAULT_REASON_CODES }
    config.cdmRequirements = { cdmVersion: meta.cdmVersion, ...(meta.vocabularyVersion?.trim() ? { vocabularyVersion: meta.vocabularyVersion.trim() } : {}) }
  } else if (meta.vocabularyVersion?.trim()) {
    config.cdmRequirements = { vocabularyVersion: meta.vocabularyVersion.trim() }
  }
  const configBytes = enc.encode(JSON.stringify(config, null, 2) + '\n')
  const signature = meta.signer ? await addSignature(undefined, configBytes, meta.signer, 'protocol-issued', meta.now) : undefined
  return { config, configBytes, signature, files, summary }
}

/** Shared fields of study_config.json. */
function baseConfig(meta: ProtocolMeta): Omit<StudyConfig, 'framework' | 'cohorts' | 'expectedHashes' | 'protectedSections'> {
  return {
    configVersion: '1.0.0',
    studyId: meta.studyId,
    studyTitle: meta.studyTitle || meta.studyId,
    description: meta.description || undefined,
    principalInvestigator: meta.principalInvestigator || undefined,
    sponsor: meta.sponsor || undefined,
    cdmVersion: meta.cdmVersion,
    issuedAt: (meta.now ?? new Date()).toISOString(),
    minCellCount: meta.minCellCount,
  }
}

/**
 * An R script study: the script is pinned below its marker (or whole), renv.lock is pinned when present.
 * Without Strategus there is no run record or data-quality gate, so only standard assurance is offered.
 */
async function issueRScriptProtocol(repo: StudyRepo, meta: ProtocolMeta): Promise<IssuedProtocol> {
  if (!repo.executeText) throw new Error(repoErrors(repo).join('; '))
  if (meta.assurance === 'regulatory') throw new Error('Regulatory assurance needs a Strategus study (run record, data-quality gate); R script studies use standard assurance')
  if (repo.renvText) {
    try {
      JSON.parse(repo.renvText)
    } catch {
      throw new Error('renv.lock is not valid JSON')
    }
  }
  const marker = meta.marker === undefined ? suggestMarker(repo.executeText) : meta.marker ?? undefined
  const sectionHash = marker ? await protectedSectionHash(repo.executeText, marker) : undefined
  if (marker && !sectionHash) throw new Error(`The marker line "${marker}" is not in the script`)
  const files: Record<string, Uint8Array> = { [PROTOCOL_PATHS.executeAnalyses]: enc.encode(repo.executeText) }
  if (repo.renvText) files[PROTOCOL_PATHS.renvLock] = enc.encode(repo.renvText)
  const config: StudyConfig = {
    ...baseConfig(meta),
    framework: { name: 'R script', modules: [] },
    cohorts: [],
    expectedHashes: {
      ...(files[PROTOCOL_PATHS.renvLock] ? { [PROTOCOL_PATHS.renvLock]: await sha256Hex(files[PROTOCOL_PATHS.renvLock]) } : {}),
      ...(sectionHash ? {} : { [PROTOCOL_PATHS.executeAnalyses]: await sha256Hex(files[PROTOCOL_PATHS.executeAnalyses]) }),
    },
    protectedSections: sectionHash && marker ? { [PROTOCOL_PATHS.executeAnalyses]: { marker, sha256: sectionHash } } : {},
  }
  if (meta.vocabularyVersion?.trim()) config.cdmRequirements = { vocabularyVersion: meta.vocabularyVersion.trim() }
  const configBytes = enc.encode(JSON.stringify(config, null, 2) + '\n')
  const signature = meta.signer ? await addSignature(undefined, configBytes, meta.signer, 'protocol-issued', meta.now) : undefined
  return { config, configBytes, signature, files, summary: { modules: [], cohorts: [], negativeControlOutcomes: 0 } }
}

export async function protocolZip(p: IssuedProtocol): Promise<Blob> {
  const zip = new JSZip()
  zip.file('study_config.json', p.configBytes)
  if (p.signature) zip.file(PROTOCOL_SIGNATURE_FILE, JSON.stringify(p.signature, null, 2) + '\n')
  for (const [path, bytes] of Object.entries(p.files)) zip.file(path, bytes)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

export function validateStudyConfig(v: unknown): { config?: StudyConfig; errors: string[] } {
  const errors: string[] = []
  if (!v || typeof v !== 'object') return { errors: ['study_config.json is not a JSON object'] }
  const o = v as Partial<StudyConfig> & { configVersion?: string }
  if (!o.studyId) errors.push('studyId is missing')
  if (!o.cdmVersion) errors.push('cdmVersion is missing')
  if (o.configVersion && !String(o.configVersion).startsWith('1.')) errors.push(`Unsupported configVersion ${o.configVersion} (expected 1.x)`)
  if (o.minCellCount !== undefined && !(Number(o.minCellCount) >= 1)) errors.push('minCellCount is invalid')
  if (o.expectedHashes && typeof o.expectedHashes !== 'object') errors.push('expectedHashes is invalid')
  if (errors.length) return { errors }
  return {
    errors,
    config: {
      configVersion: '1.0.0',
      studyTitle: o.studyId!,
      issuedAt: new Date().toISOString(),
      framework: { name: 'Strategus', modules: [] },
      cohorts: [],
      expectedHashes: {},
      protectedSections: {},
      ...o,
      minCellCount: Number(o.minCellCount ?? 5),
    } as StudyConfig,
  }
}

export interface ProtocolRead {
  config?: StudyConfig
  /** study_config.json bytes as received (sealed into the StudyPack). */
  configBytes?: Uint8Array
  signatureBytes?: Uint8Array
  /** Coordinator signature checks over the received bytes. */
  signatureChecks?: SignatureCheck[]
  files: Record<string, Uint8Array>
  errors: string[]
}

/** Read a protocol (either a bare study_config.json or a protocol zip). */
export async function readProtocolFile(name: string, data: ArrayBuffer | Uint8Array): Promise<ProtocolRead> {
  const files: Record<string, Uint8Array> = {}
  let configBytes: Uint8Array | undefined
  let signatureBytes: Uint8Array | undefined
  if (/\.zip$/i.test(name)) {
    const zip = await JSZip.loadAsync(data)
    for (const [p, e] of Object.entries(zip.files)) {
      if (e.dir) continue
      const rel = p.replace(/^[^/]+_protocol\//, '')
      if (/(^|\/)study_config\.json$/.test(rel)) configBytes = await e.async('uint8array')
      else if (rel.endsWith(PROTOCOL_SIGNATURE_FILE)) signatureBytes = await e.async('uint8array')
      else if ((Object.values(PROTOCOL_PATHS) as string[]).includes(rel)) files[rel] = await e.async('uint8array')
    }
    if (!configBytes) return { files, errors: ['study_config.json not found in the ZIP'] }
  } else {
    configBytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  }
  try {
    const { config, errors } = validateStudyConfig(JSON.parse(dec.decode(configBytes)))
    let signatureChecks: SignatureCheck[] | undefined
    if (signatureBytes) {
      try {
        signatureChecks = await verifyDetachedJws(parseJws(JSON.parse(dec.decode(signatureBytes))), configBytes)
      } catch (e) {
        signatureChecks = [{ kid: '?', valid: false, enrolled: false, error: e instanceof Error ? e.message : String(e) }]
      }
      if (signatureChecks.some((c) => !c.valid)) errors.push('The coordinator signature on study_config.json is invalid — the protocol may have been altered')
    } else if (config?.assurance === 'regulatory') {
      errors.push('This regulatory protocol is not signed by the coordinator (study_config.jws.json missing)')
    }
    return { config, configBytes, signatureBytes, signatureChecks, files, errors }
  } catch (e) {
    return { files, errors: [`Cannot parse JSON: ${String(e)}`] }
  }
}
