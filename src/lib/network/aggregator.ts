/**
 * Multi-Site Aggregator: unzips StudyPacks in memory, verifies each manifest
 * (tamper detection), re-audits Strategus results, and cross-checks protocol hashes between sites.
 */
import JSZip from 'jszip'
import { SHA256_PATTERN, hashesEqual, sha256Hex } from '@/lib/integrity/hasher'
import type { AuditResult } from '@/lib/audit/cellAuditor'
import { GENERATED_PATHS, RESULTS_DIR } from '@/lib/studypack/slots'
import type { SiteAuditReport } from '@/lib/studypack/builder'
import { auditResultFiles, summarizeResultsAudit, type ResultsAuditSummary } from '@/lib/strategus/results'
import { executionSettingsMinCellCount, PROTECTED_MARKER, protectedSectionHash } from '@/lib/strategus/executeScript'
import { PROTOCOL_PATHS } from '@/lib/strategus/protocol'
import type { ProtectedSection, StudyConfig, StudyPackManifest } from '@/types/studypack'
import { summarizeDqd, type DqdSummary } from './dqd'
import { parseJws, verifyDetachedJws, type DetachedJws, type SignatureCheck } from '@/lib/security/signer'
import { judgeEvidence, type SiteEvidence } from '@/lib/studypack/evidence'

/** Artifacts every site must share. */
export const PROTOCOL_KEY_PATHS = [PROTOCOL_PATHS.analysisSpecifications, PROTOCOL_PATHS.executeAnalyses, PROTOCOL_PATHS.renvLock] as const
/** Files that may carry a site-editable block; compared on the section below the marker when it is present. */
export const SECTION_PATHS: Record<string, string> = { [PROTOCOL_PATHS.executeAnalyses]: PROTECTED_MARKER }

export type IntegrityStatus = 'verified' | 'tampered' | 'invalid'

export interface HashMismatch {
  path: string
  expected: string
  actual: string
}

export interface IntegrityReport {
  status: IntegrityStatus
  verifiedCount: number
  mismatched: HashMismatch[]
  missing: string[]
  unlisted: string[]
  errors: string[]
}

export interface LoadedSitePack {
  key: string
  fileName: string
  zipSha256: string
  rootDir: string
  siteId: string
  studyId: string
  manifest?: StudyPackManifest
  integrity: IntegrityReport
  files: Record<string, Uint8Array>
  fileHashes: Record<string, string>
  /** Protected-section hashes for SECTION_PATHS files that contain the marker. */
  sectionHashes: Record<string, string>
  auditReport?: SiteAuditReport
  /** Coordinator re-audit of every Strategus result CSV. */
  reAudit?: ResultsAuditSummary
  reAuditFiles?: Map<string, AuditResult>
  exportedMinCellCount?: number
  dqd?: DqdSummary
  /** Coordinator's receipt time (device clock). */
  receivedAt: string
  signature?: DetachedJws
  /** Cryptographic checks of manifest.jws.json against manifest.json (roster-independent). */
  signatureChecks: SignatureCheck[]
  /** The protocol the site sealed with (protocol/study_config.json), when included. */
  sealedProtocol?: StudyConfig
}

const dec = new TextDecoder()

export function validateManifest(m: unknown): string[] {
  const errs: string[] = []
  if (!m || typeof m !== 'object') return ['manifest.json is not a JSON object']
  const o = m as Record<string, unknown>
  if (o.packVersion !== '1.0.0') errs.push(`packVersion is not 1.0.0 (${String(o.packVersion)})`)
  for (const k of ['studyId', 'siteId', 'generatedAt', 'cdmVersion'] as const)
    if (typeof o[k] !== 'string' || !o[k]) errs.push(`${k} is missing`)
  if (o.roleMode !== undefined && o.roleMode !== 'site' && o.roleMode !== 'admin') errs.push('roleMode is invalid')
  if (typeof o.generatedAt === 'string' && Number.isNaN(Date.parse(o.generatedAt))) errs.push('generatedAt is not a date-time')
  if (!Array.isArray(o.files)) errs.push('files array is missing')
  else
    o.files.forEach((f: Record<string, unknown>, i) => {
      if (typeof f?.path !== 'string') errs.push(`files[${i}].path is invalid`)
      if (typeof f?.sha256 !== 'string' || !SHA256_PATTERN.test(f.sha256)) errs.push(`files[${i}].sha256 is invalid`)
      if (!Number.isInteger(f?.sizeBytes) || (f.sizeBytes as number) < 0) errs.push(`files[${i}].sizeBytes is invalid`)
      if (!['etl', 'evidence', 'definition', 'code', 'result', 'metadata'].includes(f?.role as string)) errs.push(`files[${i}].role is invalid`)
    })
  return errs
}

function parseJson<T>(bytes?: Uint8Array): T | undefined {
  if (!bytes) return undefined
  try {
    return JSON.parse(dec.decode(bytes)) as T
  } catch {
    return undefined
  }
}

export async function loadStudyPack(fileName: string, data: ArrayBuffer | Uint8Array, minCellCount = 5, now = new Date()): Promise<LoadedSitePack> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const zipSha256 = await sha256Hex(bytes)
  const errors: string[] = []
  const zip = await JSZip.loadAsync(bytes).catch((e: unknown) => {
    errors.push(`Cannot extract ZIP: ${String(e)}`)
    return undefined
  })

  const empty: LoadedSitePack = {
    key: zipSha256,
    fileName,
    zipSha256,
    rootDir: '',
    siteId: fileName.replace(/\.studypack\.zip$/i, ''),
    studyId: '',
    integrity: { status: 'invalid', verifiedCount: 0, mismatched: [], missing: [], unlisted: [], errors },
    files: {},
    fileHashes: {},
    sectionHashes: {},
    receivedAt: now.toISOString(),
    signatureChecks: [],
  }
  if (!zip) return empty

  // Locate manifest.json (at root or one directory deep: "<study>-pack/manifest.json").
  const manifestPath = Object.keys(zip.files)
    .filter((p) => !zip.files[p].dir && /(^|\/)manifest\.json$/.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length)[0]
  if (!manifestPath) {
    errors.push('manifest.json not found')
    return empty
  }
  const rootDir = manifestPath.slice(0, -'manifest.json'.length)

  const files: Record<string, Uint8Array> = {}
  for (const [p, entry] of Object.entries(zip.files)) {
    if (entry.dir || !p.startsWith(rootDir)) continue
    if (p.includes('..')) {
      errors.push(`Illegal path: ${p}`)
      continue
    }
    files[p.slice(rootDir.length)] = await entry.async('uint8array')
  }

  const fileHashes: Record<string, string> = {}
  await Promise.all(Object.entries(files).map(async ([p, b]) => (fileHashes[p] = await sha256Hex(b))))
  const sectionHashes: Record<string, string> = {}
  for (const [p, marker] of Object.entries(SECTION_PATHS)) {
    if (!files[p]) continue
    const h = await protectedSectionHash(dec.decode(files[p]), marker)
    if (h) sectionHashes[p] = h
  }

  const manifest = parseJson<StudyPackManifest>(files[GENERATED_PATHS.manifest])
  if (!manifest) errors.push('manifest.json is not valid JSON')
  else errors.push(...validateManifest(manifest))

  const mismatched: HashMismatch[] = []
  const missing: string[] = []
  let verifiedCount = 0
  const listed = new Set<string>()
  for (const f of manifest?.files ?? []) {
    listed.add(f.path)
    const actual = fileHashes[f.path]
    if (!actual) missing.push(f.path)
    else if (!hashesEqual(actual, f.sha256)) mismatched.push({ path: f.path, expected: f.sha256, actual })
    else if (files[f.path].byteLength !== f.sizeBytes) mismatched.push({ path: f.path, expected: `${f.sizeBytes} bytes`, actual: `${files[f.path].byteLength} bytes` })
    else verifiedCount++
  }
  const unlisted = Object.keys(files).filter((p) => p !== GENERATED_PATHS.manifest && p !== GENERATED_PATHS.manifestSignature && !listed.has(p))
  const status: IntegrityStatus = errors.length > 0 ? 'invalid' : mismatched.length || missing.length || unlisted.length ? 'tampered' : 'verified'

  const auditReport = parseJson<SiteAuditReport>(files[GENERATED_PATHS.auditReport])

  let signature: DetachedJws | undefined
  let signatureChecks: SignatureCheck[] = []
  const sigBytes = files[GENERATED_PATHS.manifestSignature]
  if (sigBytes) {
    try {
      signature = parseJws(parseJson(sigBytes))
      signatureChecks = await verifyDetachedJws(signature, files[GENERATED_PATHS.manifest])
    } catch (e) {
      signatureChecks = [{ kid: '?', valid: false, enrolled: false, error: e instanceof Error ? e.message : String(e) }]
    }
  }
  const resultFiles = Object.entries(files)
    .filter(([p]) => p.startsWith(RESULTS_DIR + '/') && p.endsWith('.csv'))
    .map(([p, b]) => ({ path: p.slice(RESULTS_DIR.length + 1), bytes: b }))
  const reAuditFiles = resultFiles.length ? auditResultFiles(resultFiles, { minCellCount: auditReport?.minCellCount ?? minCellCount }) : undefined

  return {
    key: zipSha256,
    fileName,
    zipSha256,
    rootDir,
    siteId: manifest?.siteId || empty.siteId,
    studyId: manifest?.studyId ?? '',
    manifest,
    integrity: { status, verifiedCount, mismatched, missing, unlisted, errors },
    files,
    fileHashes,
    sectionHashes,
    auditReport,
    reAudit: reAuditFiles ? summarizeResultsAudit(reAuditFiles) : undefined,
    reAuditFiles,
    exportedMinCellCount: executionSettingsMinCellCount(parseJson(files['code/executionSettings.json'])),
    dqd: summarizeDqd(parseJson(files['evidence/dqd_results.json'])),
    receivedAt: now.toISOString(),
    signature,
    signatureChecks,
    sealedProtocol: parseJson<StudyConfig>(files[GENERATED_PATHS.protocol]),
  }
}

export type HashCheckStatus = 'match' | 'mismatch' | 'missing'

export interface CrossSiteResult {
  references: Record<string, { hash?: string; source: 'protocol' | 'majority' | 'none'; kind: 'file' | 'section' }>
  perSite: Record<string, Record<string, { hash?: string; status: HashCheckStatus }>>
}

/**
 * Cross-site hash comparison. The reference for each path is the protocol's expected hash
 * (study_config.json expectedHashes / protectedSections) when available, otherwise the majority among sites.
 */
export function crossCheckSites(
  sites: LoadedSitePack[],
  expected: Record<string, string> = {},
  sections: Record<string, ProtectedSection> = {},
  paths: readonly string[] = PROTOCOL_KEY_PATHS,
): CrossSiteResult {
  const references: CrossSiteResult['references'] = {}
  const kinds: Record<string, 'file' | 'section'> = {}
  const hashOf = (s: LoadedSitePack, p: string) => (kinds[p] === 'section' ? s.sectionHashes[p] : s.fileHashes[p])
  for (const p of paths) {
    // Protocol decides: a pinned section, else a pinned file; without a protocol, use the section when sites have one.
    const kind: 'file' | 'section' = sections[p] ? 'section' : expected[p] ? 'file' : SECTION_PATHS[p] && sites.some((s) => s.sectionHashes[p]) ? 'section' : 'file'
    kinds[p] = kind
    const pinned = kind === 'section' ? sections[p]?.sha256 : expected[p]
    if (pinned) {
      references[p] = { hash: pinned.toLowerCase(), source: 'protocol', kind }
      continue
    }
    const tally = new Map<string, number>()
    for (const s of sites) {
      const h = hashOf(s, p)
      if (h) tally.set(h, (tally.get(h) ?? 0) + 1)
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])
    // A strict majority is required; a tie means there is no trustworthy reference.
    if (best.length && (best.length === 1 || best[0][1] > best[1][1])) references[p] = { hash: best[0][0], source: 'majority', kind }
    else references[p] = { source: 'none', kind }
  }
  const perSite: CrossSiteResult['perSite'] = {}
  for (const s of sites) {
    perSite[s.key] = {}
    for (const p of paths) {
      const hash = hashOf(s, p)
      const ref = references[p].hash
      perSite[s.key][p] = { hash, status: !hash ? 'missing' : ref && hashesEqual(hash, ref) ? 'match' : 'mismatch' }
    }
  }
  return { references, perSite }
}

export interface SiteVerdict {
  recommended: 'adopt' | 'exclude'
  reasons: string[]
  /** Pre-specified reason codes (dispositionLog DEFAULT_REASON_CODES) the reasons fall under. */
  codes: string[]
}

export interface VerdictContext {
  config?: StudyConfig
  evidence?: SiteEvidence
  /** Signature checks with roster enrollment applied. */
  signatures?: SignatureCheck[]
}

export function siteVerdict(site: LoadedSitePack, cross: CrossSiteResult, expectedStudyId?: string, allSites: LoadedSitePack[] = [], ctx: VerdictContext = {}): SiteVerdict {
  const reasons: string[] = []
  const codes = new Set<string>()
  const add = (code: string, reason: string) => {
    reasons.push(reason)
    codes.add(code)
  }
  if (allSites.filter((s) => s.siteId === site.siteId).length > 1) add('DUPLICATE', `Duplicate Site ID (${site.siteId}) — only one package per site can be adopted`)
  if (site.integrity.status === 'invalid') add('INTEGRITY', 'Invalid manifest')
  if (site.integrity.status === 'tampered') add('INTEGRITY', 'Tampering detected (hash mismatch)')
  if (expectedStudyId && site.studyId !== expectedStudyId) add('PROTOCOL_DEVIATION', `Study ID mismatch (${site.studyId || '—'})`)
  const cfg = ctx.config
  if (cfg && site.sealedProtocol && (site.sealedProtocol.issuedAt !== cfg.issuedAt || site.sealedProtocol.studyId !== cfg.studyId))
    add('PROTOCOL_DEVIATION', `Sealed with a different protocol issue (${site.sealedProtocol.issuedAt ?? '—'})`)
  for (const [p, r] of Object.entries(cross.perSite[site.key] ?? {})) {
    const name = p.split('/').pop()
    if (r.status === 'mismatch') add('PROTOCOL_DEVIATION', `${name} ${cross.references[p]?.kind === 'section' ? 'protected section' : 'definition'} mismatch`)
    if (r.status === 'missing') add('PROTOCOL_DEVIATION', `${name} missing`)
  }
  if (!site.reAudit) add('INTEGRITY', 'No Strategus results')
  else if (!site.reAudit.passed) add('PRIVACY', `${site.reAudit.smallCellCount + site.reAudit.identifierCount} small-cell/identifier finding(s) in ${site.reAudit.failing.length} result file(s)`)

  const sigs = ctx.signatures ?? site.signatureChecks
  for (const s of sigs.filter((x) => !x.valid)) add('INTEGRITY', `Invalid signature${s.signer ? ` by ${s.signer.name}` : ''}${s.error ? ` (${s.error})` : ''}`)
  if (cfg?.assurance === 'regulatory') {
    if (!sigs.some((s) => s.valid && s.enrolled)) add('INTEGRITY', sigs.some((s) => s.valid) ? `No signature by an enrolled signer (${sigs.map((s) => s.enrollmentIssue).filter(Boolean).join('; ')})` : 'Not signed')
    if (ctx.evidence) {
      for (const b of judgeEvidence(ctx.evidence).blockers) add(b.startsWith('Data quality') ? 'DATA_QUALITY' : b.startsWith('Provenance') && /requires|version/.test(b) ? 'CDM_REQUIREMENT' : 'PROTOCOL_DEVIATION', b)
    }
  }
  return { recommended: reasons.length ? 'exclude' : 'adopt', reasons, codes: [...codes] }
}
