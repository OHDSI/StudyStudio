/**
 * Content-Security-Policy of the production build (vite.config.ts injects it). Scripts are allowed by
 * hash, not with 'unsafe-inline', so markup injected into the application or into a report it opens
 * cannot run script. Report windows opened from blob: URLs inherit this policy, so the few scripts
 * they need are listed here too.
 */

/** Added to the copy of a report opened for printing (Export Hub "PDF (print)"). */
export const PRINT_SCRIPT = "addEventListener('load',function(){print()})"

/** The "Print / Save as PDF" button handler in the generated HTML reports. */
export const PRINT_HANDLER = 'window.print()'

/** Bodies of the inline <script> elements of an HTML document, in order. */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2])
}

/** The policy, given the base64 SHA-256 of each inline script and handler it must allow. */
export function contentSecurityPolicy(scriptHashes: readonly string[], handlerHashes: readonly string[]): string {
  const src = (hashes: readonly string[]) => hashes.map((h) => `'sha256-${h}'`).join(' ')
  return [
    "default-src 'none'",
    `script-src 'self' ${src(scriptHashes)}${handlerHashes.length ? ` 'unsafe-hashes' ${src(handlerHashes)}` : ''}`,
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
}
