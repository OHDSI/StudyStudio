/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'

/**
 * Zero-Transmission enforcement: in production builds a strict CSP is injected
 * that forbids every network connection (fetch / XHR / WebSocket / beacon).
 * The dev server is left without it so Vite HMR keeps working.
 */
const zeroTransmissionCsp = (): Plugin => ({
  name: 'study-studio-zero-transmission-csp',
  apply: 'build',
  transformIndexHtml(html) {
    const csp = [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "object-src 'none'",
    ].join('; ')
    return html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
    )
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), zeroTransmissionCsp(), viteSingleFile()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
