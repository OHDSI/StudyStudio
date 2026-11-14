/**
 * Opening untrusted ZIPs (site packs, protocols, results) in memory, with limits so that a ZIP bomb
 * fails with a message instead of exhausting the browser's memory.
 *
 * Sizes are the ones declared in the ZIP's central directory, checked before anything is
 * decompressed. JSZip rejects an entry whose decompressed size differs from its declared size, so an
 * entry cannot understate its size to slip past the limit.
 */
import JSZip from 'jszip'

export const ZIP_LIMITS = {
  maxEntries: 20_000,
  /** Total decompressed size of all entries. */
  maxTotalBytes: 1024 ** 3,
} as const

/** JSZip keeps the central-directory sizes on a private field. */
const declaredSize = (e: JSZip.JSZipObject) => (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize

export async function openZip(data: ArrayBuffer | Uint8Array, limits: { maxEntries: number; maxTotalBytes: number } = ZIP_LIMITS): Promise<JSZip> {
  const zip = await JSZip.loadAsync(data)
  const entries = Object.values(zip.files).filter((e) => !e.dir)
  if (entries.length > limits.maxEntries) throw new Error(`The ZIP has ${entries.length} files; at most ${limits.maxEntries} are accepted`)
  let total = 0
  for (const e of entries) {
    const size = declaredSize(e)
    if (size === undefined || !Number.isFinite(size) || size < 0) throw new Error(`Cannot read the size of ${e.name} in the ZIP`)
    total += size
  }
  if (total > limits.maxTotalBytes)
    throw new Error(`The ZIP expands to ${(total / 1024 ** 2).toFixed(0)} MiB; at most ${(limits.maxTotalBytes / 1024 ** 2).toFixed(0)} MiB is accepted`)
  return zip
}
