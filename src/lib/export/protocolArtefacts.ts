/**
 * The protocol artefacts shipped in the submission package (assessment C1), so that every protocol hash
 * in a site manifest resolves to a file inside the package: study_config.json and its coordinator
 * signature, the pinned analysis specification, renv.lock and execution script, and the signer roster.
 *
 * Each pinned file is re-hashed against the protocol (expectedHashes, or the protected section) before it
 * is included. A file that does not match is never shipped; in a regulatory study it refuses the export.
 * Nothing new is asked of anyone: the files come from what the coordinator already loaded (the protocol
 * ZIP, the roster) or, for whole-file-pinned files, from an adopted site's sealed copy with the same hash.
 */
import { hashesEqual, sha256Hex } from '@/lib/integrity/hasher'
import { parseJws, verifyDetachedJws } from '@/lib/security/signer'
import { protectedSectionHash } from '@/lib/strategus/executeScript'
import { PROTOCOL_PATHS, PROTOCOL_SIGNATURE_FILE } from '@/lib/strategus/protocol'
import type { LoadedSitePack } from '@/lib/network/aggregator'
import type { StudyConfig } from '@/types/studypack'

/** What the coordinator loaded as the verification reference. */
export interface ProtocolSource {
  /** study_config.json exactly as issued (the bytes the coordinator signature covers). */
  configBytes?: Uint8Array
  signatureBytes?: Uint8Array
  /** Pinned files from the protocol ZIP, keyed by StudyPack path (e.g. definitions/analysisSpecifications.json). */
  files?: Record<string, Uint8Array>
}

export interface RosterSource {
  bytes: Uint8Array
  signatureBytes?: Uint8Array
}

export interface IncludedArtefact {
  path: string
  sha256: string
  /** How the file was checked before it was included. */
  check: string
}

export interface ProtocolArtefacts {
  files: { path: string; bytes: Uint8Array }[]
  included: IncludedArtefact[]
  /** Files that did not match the protocol (never shipped; refuse the export in a regulatory study). */
  mismatched: { path: string; reason: string }[]
  /** Pinned files the coordinator did not have (e.g. only study_config.json was loaded, not the protocol ZIP). */
  unavailable: string[]
}

/** Where each pinned StudyPack path goes in the submission package. */
export const PACKAGE_PATHS: Record<string, string> = {
  [PROTOCOL_PATHS.analysisSpecifications]: 'protocol/analysisSpecifications.json',
  [PROTOCOL_PATHS.renvLock]: 'protocol/renv.lock',
  [PROTOCOL_PATHS.executeAnalyses]: 'protocol/ExecuteAnalyses.R',
}

const dec = new TextDecoder()

export async function collectProtocolArtefacts(p: { config?: StudyConfig; protocol?: ProtocolSource; roster?: RosterSource; adopted: LoadedSitePack[] }): Promise<ProtocolArtefacts> {
  const out: ProtocolArtefacts = { files: [], included: [], mismatched: [], unavailable: [] }
  const { config, protocol } = p
  if (!config) return out
  const add = async (path: string, bytes: Uint8Array, check: string) => {
    out.files.push({ path, bytes })
    out.included.push({ path, sha256: await sha256Hex(bytes), check })
  }

  if (protocol?.configBytes) {
    let reason: string | undefined
    try {
      const parsed = JSON.parse(dec.decode(protocol.configBytes)) as Partial<StudyConfig>
      if (parsed.studyId !== config.studyId || parsed.issuedAt !== config.issuedAt) reason = 'is not the protocol issue used as the verification reference'
    } catch {
      reason = 'is not valid JSON'
    }
    let signed = false
    if (!reason && protocol.signatureBytes) {
      try {
        const checks = await verifyDetachedJws(parseJws(JSON.parse(dec.decode(protocol.signatureBytes))), protocol.configBytes)
        if (!checks.length || checks.some((c) => !c.valid)) reason = 'has an invalid coordinator signature'
        else signed = true
      } catch {
        reason = 'has an unreadable coordinator signature'
      }
    }
    if (reason) out.mismatched.push({ path: 'protocol/study_config.json', reason: `study_config.json ${reason}` })
    else {
      await add('protocol/study_config.json', protocol.configBytes, signed ? 'coordinator signature verified' : 'as loaded (unsigned)')
      if (protocol.signatureBytes) await add(`protocol/${PROTOCOL_SIGNATURE_FILE}`, protocol.signatureBytes, 'verifies over protocol/study_config.json')
    }
  }

  const pinned = [...new Set([...Object.keys(config.expectedHashes ?? {}), ...Object.keys(config.protectedSections ?? {})])].filter((x) => PACKAGE_PATHS[x])
  for (const path of pinned) {
    const section = config.protectedSections?.[path]
    const expected = section ? undefined : config.expectedHashes[path]
    const fromProtocol = protocol?.files?.[path]
    // A whole-file-pinned file is identical at every site, so an adopted site's sealed copy is the same file.
    // A file pinned below a marker is not: the site's copy carries its own INPUTS block, so only the protocol's copy is used.
    const fromSite = !fromProtocol && expected ? p.adopted.map((s) => s.files[path]).find((b) => b) : undefined
    const bytes = fromProtocol ?? fromSite
    if (!bytes) {
      out.unavailable.push(PACKAGE_PATHS[path])
      continue
    }
    const source = fromProtocol ? 'protocol ZIP' : 'an adopted site’s sealed copy'
    if (section) {
      const h = await protectedSectionHash(dec.decode(bytes), section.marker)
      if (!h || !hashesEqual(h, section.sha256)) out.mismatched.push({ path: PACKAGE_PATHS[path], reason: `${path.split('/').pop()} (protected section) does not match the protocol hash` })
      else await add(PACKAGE_PATHS[path], bytes, `protected section matches the protocol (${source})`)
    } else if (expected) {
      const h = await sha256Hex(bytes)
      if (!hashesEqual(h, expected)) out.mismatched.push({ path: PACKAGE_PATHS[path], reason: `${path.split('/').pop()} does not match the protocol hash` })
      else await add(PACKAGE_PATHS[path], bytes, `SHA-256 matches the protocol (${source})`)
    }
  }

  // P2: plan documents, pinned by SHA-256 in study_config.documents; shipped under protocol/docs/, never parsed.
  for (const d of config.documents ?? []) {
    const pkgPath = `protocol/${d.path}`
    const fromProtocol = protocol?.files?.[d.path]
    const bytes = fromProtocol ?? p.adopted.map((s) => s.files[d.path]).find((b) => b)
    if (!bytes) {
      out.unavailable.push(pkgPath)
      continue
    }
    if (!hashesEqual(await sha256Hex(bytes), d.sha256)) out.mismatched.push({ path: pkgPath, reason: `${d.path} (${d.title}) does not match the protocol hash` })
    else await add(pkgPath, bytes, `SHA-256 matches the protocol (${fromProtocol ? 'protocol ZIP' : 'an adopted site’s sealed copy'}) — ${d.title}`)
  }

  if (p.roster) {
    await add('roster/signer_roster.json', p.roster.bytes, 'as loaded by the coordinator')
    if (p.roster.signatureBytes) await add('roster/signer_roster.jws.json', p.roster.signatureBytes, 'as loaded by the coordinator')
  }
  return out
}
