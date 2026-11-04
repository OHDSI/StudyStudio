/**
 * SHA-256 hashing via the browser-native Web Crypto API.
 * Nothing leaves the device: crypto.subtle runs entirely in-memory.
 */
export type Hashable = ArrayBuffer | Uint8Array | string

function toBytes(input: Hashable): Uint8Array<ArrayBuffer> {
  if (typeof input === 'string') return new TextEncoder().encode(input)
  if (input instanceof Uint8Array) return new Uint8Array(input) as Uint8Array<ArrayBuffer>
  return new Uint8Array(input)
}

export function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(input: Hashable): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is unavailable. Open this page via HTTPS, localhost or file://.')
  }
  return bytesToHex(await subtle.digest('SHA-256', toBytes(input)))
}

export async function sha256OfBlob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer())
}

export const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/

export function hashesEqual(a?: string, b?: string): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}
