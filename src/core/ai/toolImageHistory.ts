import { readFileSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import { isImageMime, mimeFromExt } from '../../shared/mentions'
import type { ToolImagePart } from '../tools/_shared'

/** Rehydrate only explicitly saved paths, never paths inferred from old prose. */
export function hydrateToolImageContent(
  message: { content: string; imagePaths?: string[] },
  supportsVision: boolean,
): string | Array<ToolImagePart | { type: 'text'; text: string }> {
  if (!message.imagePaths?.length) return message.content
  if (!supportsVision) {
    return `${message.content}\n[History: image pixels are not attached to this text-only model. Use analyze_image with the saved path if visual analysis is needed: ${message.imagePaths.join(', ')}]`
  }
  const images: ToolImagePart[] = []
  const notes: string[] = []
  for (const path of message.imagePaths) {
    try {
      const mime = mimeFromExt(path)
      if (!isAbsolute(path) || !isImageMime(mime) || mime === 'image/svg+xml') throw new Error('unsupported saved image path')
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('not a file or exceeds 20MB')
      const data = readFileSync(path)
      if (data.length > 20 * 1024 * 1024) throw new Error('exceeds 20MB')
      images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data.toString('base64')}`, detail: 'high' } })
    } catch {
      notes.push(`[History: image unavailable: ${path}. No pixels were attached for this file; ask for a new attachment if required.]`)
    }
  }
  const text = [message.content, ...notes].join('\n')
  return images.length ? [...images, { type: 'text', text }] : text
}
