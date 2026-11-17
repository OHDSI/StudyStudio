/**
 * Detect a device clock that runs behind (requirements R2.2; FDA Q&A 2024 Q14 asks that a date or time
 * discrepancy be detected and reported to the system administrator).
 *
 * The browser cannot read the clock's synchronisation state, but it does see each dropped file's
 * modification time. A file modified later than "now" means this device's clock is behind the clock that
 * wrote the file. Files on a network share are stamped by the share's clock, which can differ, so this is
 * a warning for the user to check, never a blocker.
 */
export interface ClockDiscrepancy {
  file: string
  /** File modification time (ISO-8601 UTC). */
  modifiedAt: string
  /** This device's time when the file was dropped (ISO-8601 UTC). */
  observedAt: string
  behindMinutes: number
}

/** Ordinary drift and coarse file-system times are not reported. */
export const CLOCK_TOLERANCE_MS = 5 * 60 * 1000

export function clockDiscrepancy(files: readonly { name: string; lastModified?: number }[], now = Date.now()): ClockDiscrepancy | undefined {
  const latest = files.filter((f) => Number.isFinite(f.lastModified)).sort((a, b) => b.lastModified! - a.lastModified!)[0]
  if (!latest || latest.lastModified! - now <= CLOCK_TOLERANCE_MS) return undefined
  return {
    file: latest.name,
    modifiedAt: new Date(latest.lastModified!).toISOString(),
    observedAt: new Date(now).toISOString(),
    behindMinutes: Math.round((latest.lastModified! - now) / 60000),
  }
}

export function clockDiscrepancyMessage(d: ClockDiscrepancy): string {
  return `This device's clock appears to be about ${d.behindMinutes} minute(s) behind: ${d.file} was modified at ${d.modifiedAt}, after the device's time when it was loaded (${d.observedAt}). Unless the file came from a share with its own clock, ask the system administrator to correct the clock before sealing.`
}
