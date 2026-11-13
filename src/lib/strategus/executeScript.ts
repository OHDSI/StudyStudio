/**
 * ExecuteAnalyses.R (StrategusStudyRepoTemplate): sites edit the INPUTS block at the top,
 * everything after the "DO NOT MODIFY BELOW THIS POINT" marker must be identical everywhere.
 * We therefore pin and compare the SHA-256 of that protected section only.
 */
import { sha256Hex } from '@/lib/integrity/hasher'

export const PROTECTED_MARKER = 'DO NOT MODIFY BELOW THIS POINT'

const normalize = (s: string) =>
  s
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim() + '\n'

/** Text after the marker line (normalized line endings / trailing whitespace), or undefined if absent. */
export function protectedSection(text: string, marker = PROTECTED_MARKER): string | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const i = lines.findIndex((l) => l.includes(marker))
  if (i < 0) return undefined
  return normalize(lines.slice(i + 1).join('\n'))
}

export async function protectedSectionHash(text: string, marker = PROTECTED_MARKER): Promise<string | undefined> {
  const s = protectedSection(text, marker)
  return s === undefined ? undefined : sha256Hex(s)
}

/** The minCellCount a site entered in its INPUTS block (e.g. `minCellCount <- 5`). */
export function inputMinCellCount(text: string): number | undefined {
  const m = text.match(/^\s*minCellCount\s*(?:<-|=)\s*(\d+)/m)
  return m ? Number(m[1]) : undefined
}

/** minCellCount recorded in executionSettings.json (written by ExecuteAnalyses.R into the results folder). */
export function executionSettingsMinCellCount(json: unknown): number | undefined {
  const v = (json as Record<string, unknown> | undefined)?.minCellCount
  const n = Array.isArray(v) ? Number(v[0]) : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Comment lines of an R script, as candidate markers for the protected section (trimmed, in order). */
export function commentLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => /^#/.test(l) && /[a-z0-9]/i.test(l) && all.indexOf(l) === i)
}

const BOUNDARY = /(starts?\s+here|begins?\s+here|start\s+of\s+(the\s+)?(analysis|script|study)|do\s+not\s+(modify|edit|change)|below\s+this|end\s+of\s+(the\s+)?(settings|config|configuration|setup|inputs?|connection))/i

/**
 * The marker to pin an R script with: the template marker when present, else a comment line that reads
 * like the boundary between site settings and the analysis (e.g. "# --- script starts here ----").
 * Undefined means no boundary was found, so the whole script is pinned.
 */
export function suggestMarker(text: string): string | undefined {
  if (protectedSection(text) !== undefined) return PROTECTED_MARKER
  return commentLines(text).find((l) => BOUNDARY.test(l) && protectedSection(text, l)?.trim())
}
