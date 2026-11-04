import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('markdown preview parser', () => {
  it('parses the report subset', () => {
    const md = [
      '# Title — X',
      '',
      '- **Study:** demo',
      '  - ❌ `results/a.csv`: 2 small cell(s)',
      '',
      '| Site | Reasons |',
      '|---|---|',
      '| A | a \\| b |',
      '',
      '---',
      '',
      '_client-side_',
    ].join('\n')
    const b = parseMarkdown(md)
    expect(b.map((x) => x.kind)).toEqual(['heading', 'list', 'table', 'rule', 'paragraph'])
    const list = b[1] as Extract<(typeof b)[number], { kind: 'list' }>
    expect(list.items[0].content[0]).toEqual({ kind: 'strong', text: 'Study:' })
    expect(list.items[0].children[0][1]).toEqual({ kind: 'code', text: 'results/a.csv' })
    const table = b[2] as Extract<(typeof b)[number], { kind: 'table' }>
    expect(table.rows[0][1]).toEqual([{ kind: 'text', text: 'a | b' }])
    expect(b[4]).toEqual({ kind: 'paragraph', content: [{ kind: 'em', text: 'client-side' }] })
  })
  it('does not treat snake_case identifiers as emphasis', () => {
    expect(parseInline('min_cell_count and cg_cohort_count')).toEqual([{ kind: 'text', text: 'min_cell_count and cg_cohort_count' }])
  })
})
