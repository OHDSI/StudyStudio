/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { contentSecurityPolicy, inlineScripts, PRINT_HANDLER, PRINT_SCRIPT } from './src/lib/security/csp'

/**
 * Zero-Transmission enforcement: in production builds a strict CSP is injected that forbids every
 * network connection (fetch / XHR / WebSocket / beacon) and allows only the inline scripts of the
 * built page, by hash (src/lib/security/csp.ts). It runs after vite-plugin-singlefile has inlined the
 * bundle, so the hashes cover the final scripts. The dev server is left without it so HMR keeps working.
 */
const zeroTransmissionCsp = (): Plugin => ({
  name: 'study-studio-zero-transmission-csp',
  apply: 'build',
  enforce: 'post',
  // Same stage as vite-plugin-singlefile's inlining, which is listed earlier and so runs first.
  generateBundle: { order: 'post', handler(_options, bundle) {
    const page = bundle['index.html']
    if (page?.type !== 'asset' || typeof page.source !== 'string') throw new Error('CSP: index.html not found in the bundle')
    const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64')
    const scripts = inlineScripts(page.source)
    if (!scripts.length) throw new Error('CSP: no inline scripts found; is vite-plugin-singlefile still inlining the bundle?')
    const csp = contentSecurityPolicy([...scripts, PRINT_SCRIPT].map(sha256), [PRINT_HANDLER].map(sha256))
    const marker = '<meta charset="UTF-8" />'
    if (!page.source.includes(marker)) throw new Error('CSP: charset meta not found in index.html')
    page.source = page.source.replace(marker, `${marker}\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`)
  } },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile(), zeroTransmissionCsp()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
