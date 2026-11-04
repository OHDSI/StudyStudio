import * as React from 'react'
import { cn } from '@/lib/utils'

const Ctx = React.createContext<{ value: string; setValue: (v: string) => void }>({ value: '', setValue: () => {} })

export function Tabs({ value, onValueChange, defaultValue, className, children }: {
  value?: string
  onValueChange?: (v: string) => void
  defaultValue?: string
  className?: string
  children: React.ReactNode
}) {
  const [inner, setInner] = React.useState(defaultValue ?? '')
  const v = value ?? inner
  const setValue = (x: string) => (onValueChange ? onValueChange(x) : setInner(x))
  return (
    <Ctx.Provider value={{ value: v, setValue }}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  )
}

export const TabsList = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div role="tablist" className={cn('inline-flex h-10 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground', className)} {...p} />
)

export function TabsTrigger({ value, className, children, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const ctx = React.useContext(Ctx)
  const active = ctx.value === value
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      data-state={active ? 'active' : 'inactive'}
      onClick={() => ctx.setValue(value)}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all [&_svg]:size-4',
        active ? 'bg-background text-foreground shadow' : 'hover:text-foreground',
        className,
      )}
      {...p}
    >
      {children}
    </button>
  )
}

/** Content stays mounted (hidden when inactive) so in-progress form state survives tab switches. */
export function TabsContent({ value, className, ...p }: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const ctx = React.useContext(Ctx)
  return <div role="tabpanel" hidden={ctx.value !== value} className={cn('mt-4', className)} {...p} />
}
