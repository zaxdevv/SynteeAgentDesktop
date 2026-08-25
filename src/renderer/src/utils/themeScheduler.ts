import type { ThemeSchedule } from '../store/ui.store'
import type { CustomTheme } from '../../../shared/types'
import { isBuiltinTheme } from './builtinThemes'

function parseTimeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function getActiveThemeFromSchedule(schedule: ThemeSchedule, now: Date = new Date()): string | null {
  if (!schedule.enabled) return null
  const minutes = now.getHours() * 60 + now.getMinutes()
  const day = parseTimeToMinutes(schedule.dayTime)
  const night = parseTimeToMinutes(schedule.nightTime)
  if (day <= night) {
    return minutes >= day && minutes < night ? schedule.dayTheme : schedule.nightTheme
  } else {
    return minutes >= day || minutes < night ? schedule.dayTheme : schedule.nightTheme
  }
}

export function startThemeScheduler(
  getSchedule: () => ThemeSchedule,
  getCustomThemes: () => CustomTheme[],
  onTheme: (theme: string, customTheme?: CustomTheme) => void
): () => void {
  let lastApplied: string | null = null
  const tick = () => {
    const schedule = getSchedule()
    if (!schedule.enabled) { lastApplied = null; return }
    const target = getActiveThemeFromSchedule(schedule)
    if (!target) return
    const customThemes = getCustomThemes()
    const isCustom = !isBuiltinTheme(target)
    const custom = isCustom ? customThemes.find(t => t.id === target) : undefined
    const key = custom ? `custom:${custom.id}` : target
    if (key === lastApplied) return
    lastApplied = key
    onTheme(target, custom)
  }
  tick()
  const id = window.setInterval(() => {
    // Не тикаем когда окно свёрнуто — тема переключится при возврате.
    if (document.hidden) return
    tick()
  }, 60_000)
  return () => clearInterval(id)
}
