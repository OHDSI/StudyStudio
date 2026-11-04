/**
 * Zero-Transmission runtime guard (defence in depth on top of the CSP connect-src 'none').
 * Disables every browser API capable of sending data off the device.
 */
export function installNetworkGuard() {
  const deny = (api: string) => () => {
    throw new Error(`[Study Studio] ${api} is disabled: this application never transmits data.`)
  }
  const g = globalThis as unknown as Record<string, unknown>
  try {
    g.fetch = deny('fetch')
    g.XMLHttpRequest = deny('XMLHttpRequest')
    g.WebSocket = deny('WebSocket')
    g.EventSource = deny('EventSource')
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator)
      Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: false })
  } catch {
    /* CSP still applies */
  }
}
