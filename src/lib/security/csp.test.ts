import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildHtmlReport } from '@/lib/export/regulatory'
import { buildReviewersGuideHtml } from '@/lib/export/reviewersGuide'
import { contentSecurityPolicy, inlineScripts, PRINT_HANDLER } from './csp'

describe('content security policy', () => {
  it('finds inline scripts, not external ones or script-like text inside them', () => {
    const html = '<script type="module" crossorigin>const s = "<script>x<\\/script>"</script><script src="a.js"></script><script>b()</script>'
    expect(inlineScripts(html)).toEqual(['const s = "<script>x<\\/script>"', 'b()'])
  })

  it("allows scripts only by hash, without 'unsafe-inline'", () => {
    const csp = contentSecurityPolicy(['AAA'], ['BBB'])
    expect(csp).toContain("script-src 'self' 'sha256-AAA' 'unsafe-hashes' 'sha256-BBB'")
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).toContain("connect-src 'none'")
  })

  it('covers the print button of the generated reports', () => {
    const report = buildHtmlReport({ studyId: 'S', studyTitle: 'T', generatedAt: 'g', rows: [], cross: { references: {}, perSite: {} } })
    for (const html of [report, buildReviewersGuideHtml('# Guide', 'S')]) {
      const handlers = [...html.matchAll(/\son\w+="([^"]*)"/g)].map((m) => m[1])
      expect(handlers).toEqual([PRINT_HANDLER])
      expect(inlineScripts(html)).toEqual([])
    }
    expect(createHash('sha256').update(PRINT_HANDLER).digest('base64')).toHaveLength(44)
  })
})
