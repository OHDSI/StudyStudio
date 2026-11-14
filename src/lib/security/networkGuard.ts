/**
 * Zero-Transmission runtime guard (defence in depth on top of the CSP connect-src 'none').
 * Disables the browser APIs that can send data off the device without a navigation.
 */
export function installNetworkGuard() {
  const deny = (api: string) => () => {
    throw new Error(`[OHDSI Study Studio] ${api} is disabled: this application never transmits data.`)
  }
  const g = globalThis as unknown as Record<string, unknown>
  try {
    g.fetch = deny('fetch')
    g.XMLHttpRequest = deny('XMLHttpRequest')
    g.WebSocket = deny('WebSocket')
    g.EventSource = deny('EventSource')
    // WebRTC is not governed by CSP connect-src in most browsers.
    g.RTCPeerConnection = deny('RTCPeerConnection')
    g.webkitRTCPeerConnection = deny('RTCPeerConnection')
    if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator)
      Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: false })
  } catch {
    /* CSP still applies */
  }
}
