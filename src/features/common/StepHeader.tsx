import { cn } from '@/lib/utils'

export function StepHeader({ n, title, description, done }: { n: number; title: string; description?: string; done?: boolean }) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold', done ? 'bg-success text-success-foreground' : 'bg-primary text-primary-foreground')}>{n}</div>
      <div>
        <h2 className="text-base font-semibold leading-7">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  )
}
