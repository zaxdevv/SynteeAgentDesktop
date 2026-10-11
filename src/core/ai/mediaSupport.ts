import type { Provider } from '../../shared/types'

export type MediaKind = 'video' | 'audio'
export type MediaTransport = { type: 'google'; endpoint: string } | { type: 'openai'; endpoint: string }

/** Fail closed: model names or advertised modalities alone do not prove a proxy transport. */
export function resolveMediaTransport(provider: Provider, model: string, kind: MediaKind): MediaTransport {
  let url: URL
  try { url = new URL(provider.baseUrl) } catch { throw new Error('Unsupported media transport: provider needs an explicit official HTTPS API endpoint.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Unsupported media transport: use an official HTTPS API endpoint without credentials, query or fragment.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  const googleModel = model.replace(/^models\//, '')
  if (url.hostname === 'generativelanguage.googleapis.com' && ['', '/v1', '/v1beta', '/v1beta/openai', '/v1/openai'].includes(path) && /^gemini-(?:1\.5|2\.|3[.-])[a-zA-Z0-9.-]*$/.test(googleModel)) {
    return { type: 'google', endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(googleModel)}:generateContent` }
  }
  if (kind === 'audio' && url.hostname === 'api.openai.com' && ['', '/v1'].includes(path) && /^(?:gpt-4o(?:-mini)?-audio-preview(?:-\d{4}-\d{2}-\d{2})?|gpt-audio(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?)$/.test(model)) {
    return { type: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions' }
  }
  throw new Error(`Unsupported ${kind} transport for ${model} at ${url.hostname}. Use an assigned Gemini model at generativelanguage.googleapis.com${kind === 'audio' ? ' or a known OpenAI audio-chat model at api.openai.com (WAV/MP3 only)' : ''}. Proxy media formats are not assumed; no file was uploaded.`)
}

export interface AuxiliaryMediaInput {
  kind: MediaKind
  mime: string
  base64: string
  question?: string
  task?: 'analyze' | 'transcribe'
  signal?: AbortSignal
  timeoutMs?: number
}

export async function requestMediaAnalysis(transport: MediaTransport, model: string, apiKey: string, input: AuxiliaryMediaInput): Promise<string> {
  if (input.kind === 'video' && transport.type !== 'google') throw new Error('Video requires native Google Gemini transport.')
  if (transport.type === 'openai' && !['audio/wav', 'audio/mpeg'].includes(input.mime)) throw new Error('OpenAI audio chat accepts WAV/MP3 only. Convert this file first.')
  const prompt = input.task === 'transcribe'
    ? `Transcribe the speech in this audio faithfully in its original language. Mark unclear speech as [inaudible]; do not invent words.${input.question ? `\nAdditional instructions: ${input.question}` : ''}`
    : input.question?.trim() || (input.kind === 'video' ? 'Describe the events, visible details and audible content of this video. Do not invent details.' : 'Describe the speech, sounds and other audible content of this recording. Do not invent details.')
  const body = transport.type === 'google'
    ? { contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: input.mime, data: input.base64 } }] }] }
    : { model, modalities: ['text'], messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'input_audio', input_audio: { data: input.base64, format: input.mime === 'audio/wav' ? 'wav' : 'mp3' } }] }] }
  const controller = new AbortController()
  const abort = (): void => controller.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new Error('Media analysis timed out')), Math.min(Math.max(input.timeoutMs ?? 120_000, 1000), 300_000))
  try {
    const response = await fetch(transport.endpoint, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(transport.type === 'google' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      // Never echo response bodies: a proxy/server can reflect credentials or the base64 payload.
      throw new Error(`Media provider returned HTTP ${response.status}. Check API access, assigned model and media limits.`)
    }
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>
      promptFeedback?: { blockReason?: string }
      choices?: Array<{ message?: { content?: string | null } }>
    }
    const text = transport.type === 'google'
      ? data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('\n')
      : data.choices?.[0]?.message?.content
    if (!text?.trim()) throw new Error(`Media provider returned no text${data.promptFeedback?.blockReason ? ' (prompt blocked)' : ''}. The file may be unsupported or blocked.`)
    return text.trim()
  } catch (error) {
    if (controller.signal.aborted) throw new Error(input.signal?.aborted ? 'Media analysis cancelled.' : 'Media analysis timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
  }
}
