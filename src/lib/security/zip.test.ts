import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { openZip } from './zip'

async function zipOf(files: Record<string, string>) {
  const z = new JSZip()
  for (const [p, t] of Object.entries(files)) z.file(p, t)
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

/** Rewrite the declared uncompressed size of every entry (local headers and central directory). */
function understate(bytes: Uint8Array, size: number) {
  const out = bytes.slice()
  const v = new DataView(out.buffer)
  for (let i = 0; i + 4 <= out.length; i++) {
    const sig = v.getUint32(i, true)
    if (sig === 0x04034b50) v.setUint32(i + 22, size, true)
    else if (sig === 0x02014b50) v.setUint32(i + 24, size, true)
  }
  return out
}

describe('openZip', () => {
  it('opens a ZIP within the limits', async () => {
    const zip = await openZip(await zipOf({ 'a.txt': 'hello', 'b/c.txt': 'world' }))
    expect(await zip.file('b/c.txt')!.async('string')).toBe('world')
  })

  it('refuses too many entries or too many bytes before decompressing', async () => {
    const bytes = await zipOf({ 'a.txt': 'x'.repeat(10_000), 'b.txt': 'y' })
    await expect(openZip(bytes, { maxEntries: 1, maxTotalBytes: 1e9 })).rejects.toThrow(/at most 1 are accepted/)
    await expect(openZip(bytes, { maxEntries: 10, maxTotalBytes: 5_000 })).rejects.toThrow(/MiB is accepted/)
  })

  it('cannot be bypassed by understating an entry size', async () => {
    const zip = await openZip(understate(await zipOf({ 'bomb.txt': '0'.repeat(100_000) }), 10), { maxEntries: 10, maxTotalBytes: 1_000 })
    await expect(zip.file('bomb.txt')!.async('uint8array')).rejects.toThrow()
  })
})
