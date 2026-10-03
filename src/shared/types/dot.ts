// ── Dots: always-on фоновые агенты (аналог OpenAI Dots, DevDay 2026) ────
//
// Dot = персональный агент, который «живёт» в приложении: спит в фоне,
// просыпается по триггеру (расписание / webhook / изменение файлов /
// ручная кнопка), выполняет свою задачу read-only-тулами и решает —
// сообщить пользователю (сообщение в свой чат + уведомление) или
// промолчать (тихий ран, только запись в dot_runs).
//
// Ключевая архитектура: Dot = отдельный чат + конфиг + планировщик.
// Чат Dot'а — обычный чат (chats.id), рендерится штатным ChatPage/
// DotChat с полным инпут-баром. Пробуждение = обычный agent-run
// (chat:send) с oneShotSkill-инъекцией персоны Dot'а и oneShotMode:'ask'
// (read-only) для фоновых запусков.

/** Чем был разбужен Dot. */
export type DotTrigger = 'cron' | 'interval' | 'webhook' | 'fs' | 'manual'

/** Живой статус Dot'а (не персистится — вычисляется DotManager'ом). */
export type DotStatus = 'sleeping' | 'running' | 'error' | 'disabled'

/** Расписание пробуждения. */
export interface DotSchedule {
  /** 'cron' — 5-полей выражение ('0 9 * * *' = каждый день в 9:00);
   *  'interval' — период в секундах, строкой ('3600' = каждый час). */
  kind: 'cron' | 'interval'
  value: string
}

/** Конфиг Dot'а (персистится в таблице dots). */
export interface DotConfig {
  id: string
  /** Имя Dot'а («Наблюдатель», «Страж папки»...). */
  name: string
  /** Иконка Dot'а — имя из AppIcon ('eye', 'star', 'zap', ...).
   *  Хранится в БД-колонке emoji (историческое имя колонки). */
  icon: string
  /** Цвет капли-аватара (hex) — анимация DotBlob. */
  color: string
  /** Предназначение Dot'а — идёт в system prompt при каждом пробуждении. */
  purpose: string
  /** Правила-границы (Custom Rules как у OpenAI): чего Dot не делает. */
  rules?: string
  /** Расписание пробуждения (cron/interval). undefined = только ручной/webhook/fs. */
  schedule?: DotSchedule
  /** Пути для fs.watch-триггера: изменение файлов будит Dot'а. */
  watchPaths?: string[]
  /** Webhook-триггер: POST http://127.0.0.1:{port}/dot/{id}?secret=... будит Dot'а. */
  webhookEnabled?: boolean
  /** Секрет webhook'а (простая защита от случайных вызовов). */
  webhookSecret?: string
  /** Модель Dot'а. null/undefined = глобальная модель Dots (dotsSettings). */
  modelId?: string | null
  modelProvider?: string | null
  /** Чат Dot'а (FK chats.id) — история его пробуждений и диалог с юзером. */
  chatId: string
  /** Dot включён (планировщик активен). */
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Живое состояние Dot'а (считается DotManager'ом, не в БД). */
export interface DotState {
  status: DotStatus
  /** Последнее пробуждение. */
  lastRunAt?: number
  lastRunTrigger?: DotTrigger
  /** Следующее плановое пробуждение (cron/interval). */
  nextRunAt?: number
  lastError?: string
  /** Последний отчёт (status='report') — превью для карточки списка
   *  и маркер unread: report новее lastSeen = «есть новое». */
  lastReport?: { at: number; summary: string }
  /** Счётчики за всё время. */
  runCount: number
  reportCount: number
  silentCount: number
  errorCount: number
}

/** Dot для UI = конфиг + живое состояние. */
export interface Dot extends DotConfig {
  state: DotState
}

/** Запись истории пробуждений (таблица dot_runs). */
export interface DotRun {
  id: string
  dotId: string
  trigger: DotTrigger
  startedAt: number
  finishedAt?: number
  /** 'running' — ран активен; 'report' — Dot сообщил; 'silent' — тихо;
   *  'error' — упал; 'cancelled' — остановлен. */
  status: 'running' | 'report' | 'silent' | 'error' | 'cancelled'
  /** Краткое резюме рана (первые ~200 симв. ответа или текст ошибки). */
  summary?: string
  promptTokens?: number
  completionTokens?: number
}

/** Глобальные настройки Dots (electron-store, ключ 'dotsSettings'). */
export interface DotSettings {
  /** Dots включены глобально (главный тумблер). */
  enabled: boolean
  /** Модель по умолчанию для всех Dot'ов (null = назначение role:'main'). */
  modelId?: string | null
  modelProvider?: string | null
  /** Показывать уведомления при пробуждении Dot'ов. */
  notify: boolean
}

export const DEFAULT_DOT_SETTINGS: DotSettings = {
  enabled: true,
  modelId: null,
  modelProvider: null,
  notify: true,
}

/** Маркер тишины: если финальный ответ Dot'а начинается с него —
 *  ран считается тихим (сообщения удаляются, только лог в dot_runs). */
export const DOT_SILENT_MARKER = '[SILENT]'

/** Дефолтные пресеты для визарда создания. */
export const DOT_ICON_PRESETS = [
  'eye', 'star', 'zap', 'globe', 'bot', 'radio', 'bell', 'flame',
  'sparkle', 'gem', 'aperture', 'droplets', 'wind', 'shell', 'cpu', 'compass',
] as const
export const DOT_COLOR_PRESETS = [
  '#7c6cff', '#4f9cff', '#39c48f', '#e8c547', '#ff9f43',
  '#ff6b6b', '#a78bfa', '#22d3ee', '#f472b6', '#94a3b8',
] as const
