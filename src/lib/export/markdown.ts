/**
 * Minimal Markdown parser for previewing the reports Study Studio generates itself
 * (headings, bullet lists with one nesting level, pipe tables, rules, paragraphs;
 * inline **bold**, _italic_ and `code`). It returns a plain AST so the UI can render
 * React elements without innerHTML. It is not a general CommonMark implementation.
 */

export type Inline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string }

export interface ListItem {
  content: Inline[]
  children: Inline[][]
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'rule' }
  | { kind: 'paragraph'; content: Inline[] }

/** Split a table row on unescaped pipes, dropping the outer ones and unescaping `\|`. */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|'
      i++
    } else if (ch === '|') {
      cells.push(cur)
      cur = ''
    } else cur += ch
  }
  cells.push(cur)
  if (cells[0].trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim())
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isDivider = (l: string) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l)

export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  const re = /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w])_(.+?)_(?![\w])/g
  let last = 0
  for (let m; (m = re.exec(s)); ) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ kind: 'strong', text: m[2] })
    else out.push({ kind: 'em', text: m[3] })
    last = re.lastIndex
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) })
  return out
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: 'heading', level: h[1].length as 1, content: parseInline(h[2]) })
      i++
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const header = splitRow(line).map(parseInline)
      const rows: Inline[][][] = []
      i += 2
      while (i < lines.length && isTableRow(lines[i])) rows.push(splitRow(lines[i++]).map(parseInline))
      blocks.push({ kind: 'table', header, rows })
      continue
    }
    if (/^- /.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length && /^(\s+)?- /.test(lines[i])) {
        const nested = lines[i].match(/^\s+- (.*)$/)
        if (nested && items.length) items[items.length - 1].children.push(parseInline(nested[1]))
        else items.push({ content: parseInline(lines[i].replace(/^\s*- /, '')), children: [] })
        i++
      }
      blocks.push({ kind: 'list', items })
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|- |\s*\|)/.test(lines[i])) para.push(lines[i++].trim())
    if (para.length === 0) para.push(lines[i++].trim())
    blocks.push({ kind: 'paragraph', content: parseInline(para.join(' ')) })
  }
  return blocks
}
