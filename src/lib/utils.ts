import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { saveAs } from 'file-saver'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function shortHash(h?: string, n = 12): string {
  return h ? `${h.slice(0, n)}…` : '—'
}

/** Save in-memory content to the user's disk (no network involved). */
export function download(name: string, data: Blob | string | Uint8Array, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type })
  saveAs(blob, name)
}
