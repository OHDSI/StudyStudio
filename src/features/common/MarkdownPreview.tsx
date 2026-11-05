import * as React from 'react'
import { parseMarkdown, type Inline } from '@/lib/export/markdown'
import { cn } from '@/lib/utils'

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'strong' ? <strong key={i}>{p.text}</strong>
        : p.kind === 'em' ? <em key={i}>{p.text}</em>
        : p.kind === 'code' ? <code key={i} className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{p.text}</code>
        : <React.Fragment key={i}>{p.text}</React.Fragment>,
      )}
    </>
  )
}

const HEADING = ['text-xl font-semibold', 'mt-6 border-b pb-1 text-base font-semibold', 'mt-4 text-sm font-semibold', 'text-sm font-semibold', 'text-sm font-semibold', 'text-sm font-semibold']

/** Renders a OHDSI Study Studio generated Markdown report (see parseMarkdown for the supported subset). */
export function MarkdownPreview({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = React.useMemo(() => parseMarkdown(markdown), [markdown])
  return (
    // The outer div takes the caller's sizing (e.g. max-h + overflow-auto). Blocks are not flex items of a
    // height-constrained container: the overflow-x-auto table wrappers would otherwise shrink to zero height.
    <div className={cn('text-sm leading-relaxed', className)}>
      <div className="flex flex-col gap-2 [&>*]:shrink-0">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const Tag = `h${b.level}` as 'h1'
            return <Tag key={i} className={HEADING[b.level - 1]}><Inlines parts={b.content} /></Tag>
          }
          case 'rule':
            return <hr key={i} className="my-2" />
          case 'paragraph':
            return <p key={i}><Inlines parts={b.content} /></p>
          case 'list':
            return (
              <ul key={i} className="ml-5 list-disc space-y-0.5">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inlines parts={it.content} />
                    {it.children.length > 0 && (
                      <ul className="ml-5 list-[circle] space-y-0.5">
                        {it.children.map((c, k) => <li key={k}><Inlines parts={c} /></li>)}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )
          case 'table':
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr>{b.header.map((c, j) => <th key={j} className="border bg-muted/50 px-2 py-1 text-left align-top font-medium"><Inlines parts={c} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, k) => <td key={k} className="border px-2 py-1 align-top"><Inlines parts={c} /></td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      })}
      </div>
    </div>
  )
}
