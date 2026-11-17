import * as React from 'react'
import { Clock, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropZone } from '@/features/common/DropZone'
import { timeStampRequest, tsaCommand, TSQ_CONTENT_TYPE, type TimestampCheck } from '@/lib/integrity/timestamp'
import { download } from '@/lib/utils'

/** One line describing a checked token. */
export function TimestampLine({ check }: { check: TimestampCheck }) {
  if (!check.valid) return <div className="text-destructive">❌ Time-stamp token invalid: {check.error}</div>
  return (
    <div className="text-success" title={check.tsaCertSha256 ? `TSA certificate SHA-256 ${check.tsaCertSha256}` : undefined}>
      <Clock className="inline size-3" /> Time-stamped by {check.tsa ?? 'a TSA'} at {check.genTime}
    </div>
  )
}

/**
 * Obtain an RFC 3161 token without the tool sending anything: save a request, send it to a TSA with curl,
 * drop the reply back in.
 */
export function TimestampExchange({ stem, sha256, what, onReply, check }: { stem: string; sha256: string; what: string; onReply: (tsr: Uint8Array) => Promise<TimestampCheck>; check?: TimestampCheck }) {
  const [last, setLast] = React.useState<TimestampCheck>()
  const shown = check ?? last
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
      <div className="font-medium">Additional assurance (optional): RFC 3161 time-stamp</div>
      <div className="text-muted-foreground">
        FDA and EMA ask for controlled device clocks (synchronised, not changeable by users), which the study's SOPs cover; a time-stamp is not required. It adds a second, independent clock: a time-stamp authority (TSA) signs the SHA-256 of {what}. This tool sends nothing: save the request, send it from a machine with network access, and drop the reply here.
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => download(`${stem}.tsq`, timeStampRequest(sha256), TSQ_CONTENT_TYPE)}><Download /> {stem}.tsq</Button>
        <code className="break-all rounded bg-muted px-2 py-1 text-[11px]">{tsaCommand(`${stem}.tsq`, `${stem}.tsr`)}</code>
      </div>
      <div className="text-[11px] text-muted-foreground">Any RFC 3161 TSA works (e.g. your institution's or a qualified TSA); the URL above is an example. Check the TSA's certificate chain independently with <code>openssl ts -verify</code>.</div>
      <DropZone compact accept=".tsr" onFiles={async (fs) => fs[0] && setLast(await onReply(fs[0].bytes))}>
        <span className="text-muted-foreground">Drop {stem}.tsr</span>
      </DropZone>
      {shown && <TimestampLine check={shown} />}
    </div>
  )
}
