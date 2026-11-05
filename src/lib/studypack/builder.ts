/**
 * Assembles a site's StudyPack: computes SHA-256 for every artifact, writes
 * audit_report.json, ro-crate-metadata.json and manifest.json, then zips it all in memory.
 */
import JSZip from 'jszip'
import { sha256Hex } from '@/lib/integrity/hasher'
import type { AuditResult } from '@/lib/audit/cellAuditor'
import { GENERATED_PATHS } from './slots'
import { PACK_VERSION, type FileRole, type ManifestFileEntry, type RoleMode, type StudyPackManifest } from '@/types/studypack'

export const APP_NAME = 'OHDSI Study Studio'
export const APP_VERSION = '0.1.0'

export interface PackInputFile {
  /** Path inside the StudyPack, e.g. "code/renv.lock" or "results/CohortMethodModule/cm_result.csv". */
  path: string
  role: FileRole
  originalName: string
  bytes: Uint8Array
  /** Audit result when the file is subject to the zero-PHI / small-cell audit. */
  audit?: AuditResult
  remediated?: boolean
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
}

export interface SiteAuditReport {
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

export function buildAuditReport(p: BuildPackParams, generatedAt: string): SiteAuditReport {
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
  }
}

function buildRoCrate(p: BuildPackParams, generatedAt: string, entries: { path: string; size: number; role: FileRole }[]) {
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
        hasPart: entries.map((e) => ({ '@id': e.path })),
      },
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
export async function manifestEntries(files: { path: string; bytes: Uint8Array; role: FileRole }[]): Promise<ManifestFileEntry[]> {
  const out = await Promise.all(
    files.map(async (f) => ({ path: f.path, sha256: await sha256Hex(f.bytes), sizeBytes: f.bytes.byteLength, role: f.role })),
  )
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export async function buildStudyPack(p: BuildPackParams): Promise<BuiltPack> {
  const generatedAt = (p.now ?? new Date()).toISOString()
  const auditReport = buildAuditReport(p, generatedAt)

  const content: { path: string; bytes: Uint8Array; role: FileRole }[] = p.files.map((f) => ({ path: f.path, bytes: f.bytes, role: f.role }))
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
    files: await manifestEntries(content),
  }

  const rootDir = packRootDir(p.studyId)
  const zip = new JSZip()
  const root = zip.folder(rootDir)!
  const date = p.now ?? new Date()
  for (const c of content) root.file(c.path, c.bytes, { date })
  root.file(GENERATED_PATHS.manifest, json(manifest), { date })

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  return { zipBlob, zipName: packFileName(p.siteId, p.studyId), rootDir, manifest, auditReport }
}
