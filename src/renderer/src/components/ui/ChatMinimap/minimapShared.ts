import type { Message } from '../../../../../shared/types'

/** Псевдо-сообщения (live-пузырь стрима, compacting-индикатор) — не точки. */
export const PSEUDO_IDS = new Set([
  'live-streaming-bubble',
  'compacting-indicator',
  'split-live-streaming-bubble'
])

/** Очистка markdown для сниппета (как cleanPreview в сайдбаре, короче). */
export function snippet(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, '[код]')
    .replace(/`[^`]+`/g, '[код]')
    .replace(/#{1,6}\s/g, '')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 140)
}

export function roleLabel(role: Message['role']): string {
  if (role === 'user') return 'Вы'
  if (role === 'assistant') return 'Syntee'
  return 'Система'
}

export function formatTime(ts: number): string {
  if (!ts || ts < 1000000) return ''
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
}
