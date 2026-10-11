import { open } from 'fs/promises'
import { extname } from 'path'
import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import type { MediaKind } from '../ai/mediaSupport'
import { resolveToolPath, type ToolResult } from './_shared'

export interface MediaToolArgs { path: string; question?: string; task?: 'analyze' | 'transcribe' }
export interface MediaToolOptions { signal?: AbortSignal; timeoutMs?: number; modelRole?: 'main' | 'subagent' }
const MAX_MEDIA_BYTES = 14 * 1024 * 1024 // base64 + JSON remains below Gemini's 20MB inline request limit
const AUDIO_MIMES: Record<string, string> = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.aiff': 'audio/aiff', '.aif': 'audio/aiff' }
const VIDEO_MIMES: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg' }

function matchesHeader(data: Buffer, ext: string): boolean {
  const tag = (start: number, end: number): string => data.toString('ascii', start, end)
  if (ext === '.wav') return tag(0, 4) === 'RIFF' && tag(8, 12) === 'WAVE'
  if (ext === '.aiff' || ext === '.aif') return tag(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(tag(8, 12))
  if (ext === '.flac') return tag(0, 4) === 'fLaC'
  if (ext === '.ogg') return tag(0, 4) === 'OggS'
  if (ext === '.mp3') return tag(0, 3) === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0 && (data[1] & 0x06) !== 0)
  if (ext === '.aac') return data[0] === 0xff && (data[1] & 0xf6) === 0xf0
  if (ext === '.mp4' || ext === '.mov') return tag(4, 8) === 'ftyp' || (ext === '.mov' && ['moov', 'mdat', 'wide'].includes(tag(4, 8)))
  if (ext === '.webm') return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && data.subarray(0, 4096).includes(Buffer.from('webm'))
  if (ext === '.mpeg' || ext === '.mpg') return data[0] === 0 && data[1] === 0 && data[2] === 1 && [0xba, 0xb3].includes(data[3])
  return false
}

async function analyzeMediaFile(kind: MediaKind, args: MediaToolArgs, store: Store, workdir?: string, opts: MediaToolOptions = {}): Promise<ToolResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    opts.signal?.throwIfAborted()
    if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('A local file path is required.')
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(args.path)) throw new Error('Only local files are accepted; URLs and hosted media are not supported.')
    if (args.question !== undefined && (typeof args.question !== 'string' || args.question.length > 16000)) throw new Error('Question must be a string of at most 16000 characters.')
    if (args.task !== undefined && !['analyze', 'transcribe'].includes(args.task)) throw new Error('Audio task must be analyze or transcribe.')
    const path = resolveToolPath(args.path, workdir)
    const ext = extname(path).toLowerCase()
    const mime = (kind === 'audio' ? AUDIO_MIMES : VIDEO_MIMES)[ext]
    if (!mime) throw new Error(`Unsupported ${kind} file type ${ext || '(none)'}. Supported: ${Object.keys(kind === 'audio' ? AUDIO_MIMES : VIDEO_MIMES).join(', ')}. No automatic conversion is performed.`)
    const client = new AIClient(store)
    client.validateMediaAssignment(kind, opts.modelRole)
    handle = await open(path, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Path must refer to a regular local file.')
    if (stat.size === 0 || stat.size > MAX_MEDIA_BYTES) throw new Error(`Media must be non-empty and at most 14 MiB (inline request limit). File size: ${stat.size} bytes. Split or convert the file first.`)
    // Bounded read on the same handle prevents file-growth races from bypassing the size limit.
    const data = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < data.length) {
      opts.signal?.throwIfAborted()
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw new Error('Media file changed while being read. Retry with a stable file.')
      offset += bytesRead
    }
    if ((await handle.stat()).size !== stat.size) throw new Error('Media file changed while being read. Retry with a stable file.')
    if (!matchesHeader(data, ext)) throw new Error('File header does not match its media extension. Convert to a supported format; renaming a file is not conversion.')
    opts.signal?.throwIfAborted()
    const output = await client.analyzeMedia({ kind, mime, base64: data.toString('base64'), question: args.question, task: args.task, signal: opts.signal, timeoutMs: opts.timeoutMs, modelRole: opts.modelRole })
    return { success: true, output }
  } catch (error) {
    return { success: false, output: '', error: opts.signal?.aborted ? 'Media analysis cancelled.' : error instanceof Error ? error.message : String(error) }
  } finally {
    await handle?.close()
  }
}

/** Auxiliary text result only; does not attach native media to the primary model. */
export function analyzeVideoFile(args: Omit<MediaToolArgs, 'task'>, store: Store, workdir?: string, opts?: MediaToolOptions): Promise<ToolResult> {
  return analyzeMediaFile('video', args, store, workdir, opts)
}
export function analyzeAudioFile(args: MediaToolArgs, store: Store, workdir?: string, opts?: MediaToolOptions): Promise<ToolResult> {
  return analyzeMediaFile('audio', args, store, workdir, opts)
}
