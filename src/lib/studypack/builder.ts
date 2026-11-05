/**
 * Assembles a site's StudyPack: computes SHA-256 for every artifact, writes
 * audit_report.json, ro-crate-metadata.json and manifest.json, then zips it all in memory.
 */
import JSZip from 'jszip'
import { sha256Hex, sha256OfBlob } from '@/lib/integrity/hasher'
import { commit } from '@/lib/integrity/commitment'
import type { AuditResult } from '@/lib/audit/cellAuditor'
import type { DqdFinding } from '@/lib/audit/dqdAuditor'
import type { LogMessage } from '@/lib/audit/logAuditor'
import type { ProvenanceReport } from '@/lib/provenance/cdmSource'
import type { Timeline } from '@/lib/provenance/timeline'
import { deviceNow } from '@/lib/provenance/timeline'
import { addSignature, type DetachedJws, type SignatureMeaning, type UnlockedSigner } from '@/lib/security/signer'
import { judgeEvidence, type SiteEvidence } from './evidence'
import { GENERATED_PATHS } from './slots'
import { PACK_VERSION, type AssuranceLevel, type FileRole, type GateSeverity, type ManifestFileEntry, type RoleMode, type SourcedTime, type StudyPackManifest } from '@/types/studypack'

export const APP_NAME = 'OHDSI Study Studio'
export const APP_VERSION = '0.1.0'

/** Why and how a file differs from what the site produced (R5.2). */
export interface FileModification {
  kind: 'small-cell-masking' | 'log-redaction'
  rule: string
  /** e.g. { maskedCells, droppedIdentifierColumns } or redactions per kind. */
  counts: Record<string, number>
  reason: string
}

export interface PackInputFile {
  /** Path inside the StudyPack, e.g. "code/renv.lock" or "results/CohortMethodModule/cm_result.csv". */
  path: string
  role: FileRole
  originalName: string
  bytes: Uint8Array
  /** Audit result when the file is subject to the zero-PHI / small-cell audit. */
  audit?: AuditResult
  remediated?: boolean
  /** The file before masking/redaction. Never packed: only a salted commitment to it is (R5.3). */
  original?: Uint8Array
  modification?: FileModification
}

export interface ProtocolCheck {
  path: string
  /** 'file' = whole-file hash, 'section' = protected-section hash. */
  kind: 'file' | 'section'
  expected: string
  actual?: string
  match: boolean
}

export interface BuildPackParams {
  studyId: string
  studyTitle?: string
  siteId: string
  cdmVersion: string
  minCellCount: number
  exportedMinCellCount?: number
  roleMode?: RoleMode
  files: PackInputFile[]
  protocolChecks?: ProtocolCheck[]
  now?: Date
  assurance?: AssuranceLevel
  /** study_config.json exactly as received, and the coordinator's signature over it, if any. */
  protocolBytes?: Uint8Array
  protocolSignatureBytes?: Uint8Array
  evidence?: SiteEvidence
  /** Each unlocked key signs manifest.json with the given meaning. */
  signers?: { signer: UnlockedSigner; meaning: SignatureMeaning }[]
}

export interface ModificationRecord extends FileModification {
  path: string
  originalCommitment: string
}

export interface SiteAuditReportSections {
  assurance?: AssuranceLevel
  sealedAt?: SourcedTime
  modifications?: ModificationRecord[]
  dataQuality?: {
    policySource: 'protocol' | 'derived'
    policyVersion: string
    policySha256: string
    studyTables: string[]
    present: boolean
    checksEvaluated: number
    counts: Record<GateSeverity, number>
    findings: DqdFinding[]
    metadata: SiteEvidence['dqdGate']['metadata']
  }
  provenance?: ProvenanceReport
  executionLog?: {
    lines: number
    entries: number
    firstTimestamp?: string
    lastTimestamp?: string
    counts: Record<string, number>
    errors: LogMessage[]
    warningCount: number
    minCellCounts: number[]
  }
  timeline?: Timeline
  signers?: { kid: string; name: string; organization: string; role: string; meaning: SignatureMeaning }[]
}

/** Kept at the site, never sent: lets the site prove later which originals it held (R5.4). */
export interface RetentionReceipt {
  format: 'studypack-retention-receipt/1'
  notice: string
  studyId: string
  siteId: string
  packFileName: string
  packSha256: string
  manifestSha256: string
  sealedAt: SourcedTime
  originals: { path: string; kind: FileModification['kind']; originalSha256: string; commitment: string; salt: string }[]
}

export interface SiteAuditReport extends SiteAuditReportSections {
  reportVersion: '1.0.0'
  tool: { name: string; version: string }
  studyId: string
  siteId: string
  generatedAt: string
  minCellCount: number
  exportedMinCellCount?: number
  rule: string
  passed: boolean
  files: {
    path: string
    originalName: string
    passed: boolean
    smallCellCount: number
    identifierCount: number
    scannedCells: number
    countColumns: string[]
    countColumnSource: string
    remediationApplied: boolean
  }[]
  protocolChecks: ProtocolCheck[]
}

export interface BuiltPack {
  zipBlob: Blob
  zipName: string
  rootDir: string
  manifest: StudyPackManifest
  auditReport: SiteAuditReport
  signature?: DetachedJws
  retention: RetentionReceipt
}

export function safeId(s: string): string {
  return (s || 'unknown').trim().replace(/[^A-Za-z0-9._-]+/g, '_')
}

export function packFileName(siteId: string, studyId: string): string {
  return `${safeId(siteId)}_${safeId(studyId)}.studypack.zip`
}

export function packRootDir(studyId: string): string {
  return `${safeId(studyId)}-pack`
}

const enc = new TextEncoder()
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2) + '\n')

function mimeOf(path: string): string {
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.csv')) return 'text/csv'
  if (path.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (path.endsWith('.R')) return 'text/x-r-source'
  if (path.endsWith('.lock')) return 'application/json'
  return 'application/octet-stream'
}

export function buildAuditReport(p: BuildPackParams, generatedAt: string, sections: SiteAuditReportSections = {}): SiteAuditReport {
  const files = p.files
    .filter((f) => f.audit)
    .map((f) => {
      const a = f.audit!
      return {
        path: f.path,
        originalName: f.originalName,
        passed: a.passed,
        smallCellCount: a.smallCellCount,
        identifierCount: a.identifierCount,
        scannedCells: a.scannedCells,
        countColumns: [...new Set(a.sheets.flatMap((s) => s.countColumns))],
        countColumnSource: [...new Set(a.sheets.map((s) => s.countColumnSource))].join('+'),
        remediationApplied: !!f.remediated,
      }
    })
  return {
    reportVersion: '1.0.0',
    tool: { name: APP_NAME, version: APP_VERSION },
    studyId: p.studyId,
    siteId: p.siteId,
    generatedAt,
    minCellCount: p.minCellCount,
    exportedMinCellCount: p.exportedMinCellCount,
    rule: `Aggregate counts with 0 < n < ${p.minCellCount} must be suppressed (HADES convention: -${p.minCellCount}). Direct identifier columns must not be included.`,
    passed: files.every((f) => f.passed),
    files,
    protocolChecks: p.protocolChecks ?? [],
    ...sections,
  }
}

async function evidenceSections(e: SiteEvidence): Promise<SiteAuditReportSections> {
  const g = e.dqdGate
  return {
    dataQuality: {
      policySource: e.dqdPolicySource,
      policyVersion: e.dqdPolicy.policyVersion,
      policySha256: await sha256Hex(JSON.stringify(e.dqdPolicy)),
      studyTables: e.dqdPolicy.studyTables,
      present: g.present,
      checksEvaluated: g.checksEvaluated,
      counts: g.counts,
      findings: g.findings.filter((f) => f.severity !== 'info'),
      metadata: g.metadata,
    },
    provenance: e.provenance,
    executionLog: e.log && {
      lines: e.log.lines,
      entries: e.log.entries,
      firstTimestamp: e.log.firstTimestamp,
      lastTimestamp: e.log.lastTimestamp,
      counts: e.log.counts,
      errors: e.log.errors.slice(0, 20),
      warningCount: e.log.counts.WARN,
      minCellCounts: e.log.minCellCounts,
    },
    timeline: e.timeline,
  }
}

function buildRoCrate(p: BuildPackParams, generatedAt: string, entries: { path: string; size: number; role: FileRole }[]) {
  const people = (p.signers ?? []).map(({ signer: s }) => ({ '@id': `#signer-${s.kid}`, '@type': 'Person', name: s.signer.name, affiliation: s.signer.organization, identifier: s.kid, jobTitle: s.signer.role }))
  return {
    '@context': 'https://w3id.org/ro/crate/1.1/context',
    '@graph': [
      {
        '@id': 'ro-crate-metadata.json',
        '@type': 'CreativeWork',
        conformsTo: { '@id': 'https://w3id.org/ro/crate/1.1' },
        about: { '@id': './' },
      },
      {
        '@id': './',
        '@type': 'Dataset',
        identifier: p.studyId,
        name: p.studyTitle || p.studyId,
        description: `StudyPack for study ${p.studyId} produced at site ${p.siteId} (OMOP CDM ${p.cdmVersion}, OHDSI Strategus).`,
        datePublished: generatedAt,
        sourceOrganization: { '@id': `#site-${safeId(p.siteId)}` },
        ...(people.length ? { author: people.map((x) => ({ '@id': x['@id'] })) } : {}),
        hasPart: entries.map((e) => ({ '@id': e.path })),
      },
      ...people,
      { '@id': `#site-${safeId(p.siteId)}`, '@type': 'Organization', name: p.siteId },
      { '@id': `#${safeId(APP_NAME)}`, '@type': 'SoftwareApplication', name: APP_NAME, version: APP_VERSION },
      ...entries.map((e) => ({
        '@id': e.path,
        '@type': 'File',
        name: e.path.split('/').pop(),
        encodingFormat: mimeOf(e.path),
        contentSize: String(e.size),
        additionalType: e.role,
      })),
    ],
  }
}

/** Produce manifest entries (sorted by path) for a set of path → bytes. */
export async function manifestEntries(files: { path: string; bytes: Uint8Array; role: FileRole; originalCommitment?: string }[]): Promise<ManifestFileEntry[]> {
  const out = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      sha256: await sha256Hex(f.bytes),
      sizeBytes: f.bytes.byteLength,
      role: f.role,
      ...(f.originalCommitment ? { originalCommitment: f.originalCommitment } : {}),
    })),
  )
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/** Thrown when a pack must not be sealed. The UI disables the button too; this is the authoritative check. */
export class SealRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(`StudyPack not sealed: ${reasons.join('; ')}`)
    this.name = 'SealRefused'
  }
}

/**
 * Conditions that make a pack unsealable regardless of how it is requested (UI, script or test):
 * small cells or identifiers left in audited files, and — in regulatory studies — a missing signature,
 * missing protocol / coordinator signature, missing evidence, or evidence that blocks.
 */
export function sealRefusals(p: BuildPackParams): string[] {
  const reasons: string[] = []
  for (const f of p.files)
    if (f.audit && !f.audit.passed) reasons.push(`${f.path}: ${f.audit.smallCellCount} small cell(s) / ${f.audit.identifierCount} identifier column(s) remain`)
  if (p.assurance === 'regulatory') {
    if (!p.signers?.length) reasons.push('regulatory studies must be signed')
    if (!p.protocolBytes) reasons.push('regulatory studies must seal the protocol as received')
    if (!p.protocolSignatureBytes) reasons.push('regulatory studies need the coordinator signature on the protocol')
    if (!p.evidence) reasons.push('regulatory studies must include the data-quality and provenance evidence')
    else reasons.push(...judgeEvidence(p.evidence).blockers)
  }
  return reasons
}

export async function buildStudyPack(p: BuildPackParams): Promise<BuiltPack> {
  const refusals = sealRefusals(p)
  if (refusals.length) throw new SealRefused(refusals)
  const now = p.now ?? new Date()
  const generatedAt = now.toISOString()
  const sealedAt = deviceNow(now)

  // Salted commitments to every original that was masked or redacted (R5.3).
  const commitments = new Map<string, { commitment: string; salt: string; originalSha256: string; kind: FileModification['kind'] }>()
  for (const f of p.files) {
    if (!f.original || !f.modification) continue
    const c = await commit(f.original)
    commitments.set(f.path, { ...c, originalSha256: await sha256Hex(f.original), kind: f.modification.kind })
  }
  const modifications: ModificationRecord[] = p.files
    .filter((f) => f.modification && commitments.has(f.path))
    .map((f) => ({ path: f.path, ...f.modification!, originalCommitment: commitments.get(f.path)!.commitment }))

  const sections: SiteAuditReportSections = {
    assurance: p.assurance ?? 'standard',
    sealedAt,
    modifications,
    ...(p.evidence ? await evidenceSections(p.evidence) : {}),
    signers: (p.signers ?? []).map(({ signer: s, meaning }) => ({ kid: s.kid, name: s.signer.name, organization: s.signer.organization, role: s.signer.role, meaning })),
  }
  const auditReport = buildAuditReport(p, generatedAt, sections)

  const content: { path: string; bytes: Uint8Array; role: FileRole; originalCommitment?: string }[] = p.files.map((f) => ({
    path: f.path,
    bytes: f.bytes,
    role: f.role,
    originalCommitment: commitments.get(f.path)?.commitment,
  }))
  if (p.protocolBytes) content.push({ path: GENERATED_PATHS.protocol, bytes: p.protocolBytes, role: 'definition' })
  if (p.protocolSignatureBytes) content.push({ path: GENERATED_PATHS.protocolSignature, bytes: p.protocolSignatureBytes, role: 'definition' })
  content.push({ path: GENERATED_PATHS.auditReport, bytes: json(auditReport), role: 'evidence' })

  const roCrate = buildRoCrate(p, generatedAt, content.map((c) => ({ path: c.path, size: c.bytes.byteLength, role: c.role })))
  content.push({ path: GENERATED_PATHS.roCrate, bytes: json(roCrate), role: 'metadata' })

  const manifest: StudyPackManifest = {
    packVersion: PACK_VERSION,
    studyId: p.studyId,
    siteId: p.siteId,
    roleMode: p.roleMode ?? 'site',
    generatedAt,
    cdmVersion: p.cdmVersion,
    assurance: p.assurance ?? 'standard',
    tool: { name: APP_NAME, version: APP_VERSION },
    sealedAt,
    files: await manifestEntries(content),
  }
  const manifestBytes = json(manifest)

  // Each signature covers the exact manifest bytes, which list the SHA-256 of every other file (R1.2).
  let signature: DetachedJws | undefined
  for (const s of p.signers ?? []) signature = await addSignature(signature, manifestBytes, s.signer, s.meaning, now)

  const rootDir = packRootDir(p.studyId)
  const zip = new JSZip()
  const root = zip.folder(rootDir)!
  for (const c of content) root.file(c.path, c.bytes, { date: now })
  root.file(GENERATED_PATHS.manifest, manifestBytes, { date: now })
  if (signature) root.file(GENERATED_PATHS.manifestSignature, json(signature), { date: now })

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const zipName = packFileName(p.siteId, p.studyId)
  const retention: RetentionReceipt = {
    format: 'studypack-retention-receipt/1',
    notice:
      'Keep this file at the site with the unmasked originals for the retention period. It is not part of the StudyPack and must not be sent: the salts let anyone holding the originals prove they match the commitments in manifest.json.',
    studyId: p.studyId,
    siteId: p.siteId,
    packFileName: zipName,
    packSha256: await sha256OfBlob(zipBlob),
    manifestSha256: await sha256Hex(manifestBytes),
    sealedAt,
    originals: [...commitments.entries()].map(([path, c]) => ({ path, kind: c.kind, originalSha256: c.originalSha256, commitment: c.commitment, salt: c.salt })),
  }
  return { zipBlob, zipName, rootDir, manifest, auditReport, signature, retention }
}

export function retentionFileName(siteId: string, studyId: string): string {
  return `${safeId(siteId)}_${safeId(studyId)}.retention.json`
}
