/**
 * Protocol issuance from a Strategus study repository. The ohdsi-studies/StrategusStudyRepoTemplate
 * layout is recognised, but not required: any repository with a Strategus analysis specification,
 * an R script that calls Strategus::execute() and a renv.lock works.
 * The coordinator's repository is the source of truth; OHDSI Study Studio pins its artifacts with SHA-256
 * and distributes them to sites as <studyId>_protocol.zip.
 */
import JSZip from 'jszip'
import { sha256Hex } from '@/lib/integrity/hasher'
import type { StudyConfig } from '@/types/studypack'
import { parseAnalysisSpecification, type AnalysisSpecSummary } from './spec'
import { PROTECTED_MARKER, protectedSectionHash } from './executeScript'

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
  const execute =
    shallowest(paths.filter((p) => /(^|\/)ExecuteAnalyses\.R$/i.test(p) && notVendored(p))) ??
    shallowest(paths.filter((p) => /\.R$/i.test(p) && notVendored(p) && /Strategus::execute\s*\(/.test(text0(p))))
  const renv = shallowest(paths.filter((p) => /(^|\/)renv\.lock$/i.test(p) && notVendored(p)))
  const config = shallowest(paths.filter((p) => /(^|\/)config\.yml$/i.test(p) && notVendored(p)))
  const text = (p?: string) => (p ? dec.decode(files.find((f) => f.path === p)!.bytes) : undefined)

  const errors: string[] = []
  if (!spec) errors.push('analysisSpecifications.json not found (expected inst/analysisSpecifications.json)')
  if (!execute) errors.push('No execution script found (ExecuteAnalyses.R or an .R file calling Strategus::execute())')
  if (!renv) errors.push('renv.lock not found')
  const studyName = text(config)?.match(/^\s*studyName:\s*["']?([^"'\n#]+?)["']?\s*(#.*)?$/m)?.[1]?.trim()
  return {
    specText: text(spec),
    executeText: text(execute),
    renvText: text(renv),
    studyName,
    sources: { analysisSpecifications: spec, executeAnalyses: execute, renvLock: renv },
    errors,
  }
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
}

export interface IssuedProtocol {
  config: StudyConfig
  files: Record<string, Uint8Array>
  summary: AnalysisSpecSummary
}

export async function issueProtocol(repo: StudyRepo, meta: ProtocolMeta): Promise<IssuedProtocol> {
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
  return { config, files, summary }
}

export async function protocolZip(p: IssuedProtocol): Promise<Blob> {
  const zip = new JSZip()
  zip.file('study_config.json', JSON.stringify(p.config, null, 2) + '\n')
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

/** Read a protocol (either a bare study_config.json or a protocol zip). */
export async function readProtocolFile(name: string, data: ArrayBuffer | Uint8Array): Promise<{ config?: StudyConfig; files: Record<string, Uint8Array>; errors: string[] }> {
  const files: Record<string, Uint8Array> = {}
  let configText: string | undefined
  if (/\.zip$/i.test(name)) {
    const zip = await JSZip.loadAsync(data)
    for (const [p, e] of Object.entries(zip.files)) {
      if (e.dir) continue
      const rel = p.replace(/^[^/]+_protocol\//, '')
      if (/(^|\/)study_config\.json$/.test(rel)) configText = await e.async('string')
      else if ((Object.values(PROTOCOL_PATHS) as string[]).includes(rel)) files[rel] = await e.async('uint8array')
    }
    if (!configText) return { files, errors: ['study_config.json not found in the ZIP'] }
  } else {
    configText = dec.decode(data)
  }
  try {
    const { config, errors } = validateStudyConfig(JSON.parse(configText))
    return { config, files, errors }
  } catch (e) {
    return { files, errors: [`Cannot parse JSON: ${String(e)}`] }
  }
}
