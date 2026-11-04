import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Hash({ value, full, className }: { value?: string; full?: boolean; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn('inline-flex items-center gap-1 font-mono text-[11px]', className)} title={value}>
      {full ? value : `${value.slice(0, 12)}…`}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        onClick={async (e) => {
          e.stopPropagation()
          try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          } catch {
            /* clipboard unavailable */
          }
        }}
        aria-label="Copy hash"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </span>
  )
}
