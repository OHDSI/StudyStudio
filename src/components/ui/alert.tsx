import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const alertVariants = cva('relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-3.5 [&>svg]:size-4 [&>svg~*]:pl-7', {
  variants: {
    variant: {
      default: 'bg-background text-foreground',
      destructive: 'border-destructive/50 bg-destructive/5 text-destructive [&>svg]:text-destructive',
      warning: 'border-warning/60 bg-warning/10 text-foreground [&>svg]:text-warning',
      success: 'border-success/50 bg-success/5 text-foreground [&>svg]:text-success',
    },
  },
  defaultVariants: { variant: 'default' },
})

export const Alert = ({ className, variant, ...p }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) => (
  <div role="alert" className={cn(alertVariants({ variant }), className)} {...p} />
)
export const AlertTitle = ({ className, ...p }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h5 className={cn('mb-1 font-semibold leading-none tracking-tight', className)} {...p} />
)
export const AlertDescription = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('text-sm [&_p]:leading-relaxed', className)} {...p} />
)
