import { cn } from '@/lib/utils'

export function Progress({ value, className, indicatorClassName }: { value: number; className?: string; indicatorClassName?: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <div role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/15', className)}>
      <div className={cn('h-full bg-primary transition-all', indicatorClassName)} style={{ width: `${v}%` }} />
    </div>
  )
}
