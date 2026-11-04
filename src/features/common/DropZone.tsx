import * as React from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DroppedFile {
  name: string
  bytes: Uint8Array
}

/** Files keep their relative path as name when they come from a folder (picker or drag & drop). */
async function readAll(list: FileList | File[]): Promise<DroppedFile[]> {
  return Promise.all(
    Array.from(list).map(async (f) => ({ name: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  )
}

type Entry = FileSystemEntry
const isFile = (e: Entry): e is FileSystemFileEntry => e.isFile
const isDir = (e: Entry): e is FileSystemDirectoryEntry => e.isDirectory

async function walk(entry: Entry): Promise<DroppedFile[]> {
  if (isFile(entry)) {
    const file = await new Promise<File>((res, rej) => entry.file(res, rej))
    return [{ name: entry.fullPath.replace(/^\//, ''), bytes: new Uint8Array(await file.arrayBuffer()) }]
  }
  if (isDir(entry)) {
    const reader = entry.createReader()
    const children: Entry[] = []
    // readEntries returns results in batches until it yields an empty array.
    for (;;) {
      const batch = await new Promise<Entry[]>((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      children.push(...batch)
    }
    return (await Promise.all(children.map(walk))).flat()
  }
  return []
}

/** Read a drop, descending into dropped folders. */
async function readDrop(dt: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter((e): e is Entry => !!e)
  if (entries.some((e) => e.isDirectory)) return (await Promise.all(entries.map(walk))).flat()
  return readAll(dt.files)
}

/** Drag & drop / click-to-browse. Files are read into memory with File.arrayBuffer() — never uploaded. */
export function DropZone({
  onFiles,
  accept,
  multiple,
  directory,
  title,
  hint,
  compact,
  className,
  children,
}: {
  onFiles: (files: DroppedFile[]) => void | Promise<void>
  accept?: string
  multiple?: boolean
  /** Let the browse dialog pick a whole folder (drag & drop of folders works either way). */
  directory?: boolean
  title?: string
  hint?: string
  compact?: boolean
  className?: string
  children?: React.ReactNode
}) {
  const [over, setOver] = React.useState(false)
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        if (e.dataTransfer.files.length) await onFiles(await readDrop(e.dataTransfer))
      }}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-center transition-colors',
        compact ? 'p-3' : 'p-6',
        over ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/50 hover:bg-muted/40',
        className,
      )}
    >
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple || directory}
        {...(directory ? { webkitdirectory: '', directory: '' } : {})}
        onChange={async (e) => {
          if (e.target.files?.length) await onFiles(await readAll(e.target.files))
          e.target.value = ''
        }}
      />
      {children ?? (
        <>
          <Upload className={cn('text-muted-foreground', compact ? 'size-4' : 'size-6')} />
          {title && <div className="text-sm font-medium">{title}</div>}
          {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        </>
      )}
    </div>
  )
}
