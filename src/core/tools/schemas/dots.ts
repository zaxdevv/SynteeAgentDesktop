// ── Dots tool: manage_dots — управление always-on фоновыми агентами ──────
// Один мульти-action тул (паттерн manage_notes): create/list/get/update/
// delete/wake. Мутирующие action'ы всегда требуют подтверждения
// (Agent.ts, поверх allowlist и авто-настроек) — агент управляет
// always-on агентами только с явного согласия пользователя.
//
// Тул доступен ТОЛЬКО в normal-режиме основного чата: ask/planning/
// read-only персоны и фоновые wake-раны Dot'ов (oneShotMode:'ask') его
// не получают — иначе Dot мог бы создавать других Dot'ов (рекурсия).

export const DOTS_TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'manage_dots',
      description: 'Manage Dots — always-on background agents. A Dot sleeps in the background, wakes up by trigger (cron schedule / interval / watched file changes / webhook / manual), performs its task read-only and either reports to the user (message in its chat + notification) or stays silent. Actions: create — new Dot (name + purpose required; triggers are optional — if the user did not specify, ask which triggers they want before creating); list — all Dots with live status; get — one Dot details + recent runs (by dot_id or name); update — patch fields (schedule, rules, enabled...); delete — remove a Dot together with its chat; wake — run a Dot now. Mutating actions always require user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'get', 'update', 'delete', 'wake'],
            description: 'create — new Dot; list — all Dots; get — details + runs; update — patch config; delete — remove Dot + its chat; wake — run now.',
          },
          dot_id: {
            type: 'string',
            description: 'Dot ID (from list/get). Used by get/update/delete/wake. Alternatively pass name.',
          },
          name: {
            type: 'string',
            description: 'Dot name, e.g. «Наблюдатель». Required for create; for get/delete/wake can be used instead of dot_id.',
          },
          purpose: {
            type: 'string',
            description: 'The Dot\'s task — what it does on every wake-up (injected into its system prompt). Required for create. Write in the user\'s language.',
          },
          rules: {
            type: 'string',
            description: 'Boundaries the Dot must not cross (custom rules). Optional.',
          },
          schedule_kind: {
            type: 'string',
            enum: ['cron', 'interval'],
            description: 'Wake-up schedule type. cron — 5-field expression; interval — period in seconds (min 60).',
          },
          schedule_value: {
            type: 'string',
            description: 'Schedule value: cron expression like "0 9 * * *" (daily at 9:00) or interval in seconds like "3600" (hourly).',
          },
          watch_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Absolute folder paths to watch — file changes wake the Dot (fs-trigger).',
          },
          webhook_enabled: {
            type: 'boolean',
            description: 'Enable webhook trigger: POST http://127.0.0.1:48765/dot/{id}?secret=... wakes the Dot. The URL is returned after create.',
          },
          model_id: {
            type: 'string',
            description: 'Model for the Dot (together with model_provider). Omit both to use the global Dots model.',
          },
          model_provider: {
            type: 'string',
            description: 'Provider of model_id (e.g. "syntee-gateway"). Required if model_id is given.',
          },
          enabled: {
            type: 'boolean',
            description: 'update only: enable/disable the Dot (disabled Dot never wakes).',
          },
          icon: {
            type: 'string',
            description: 'Avatar icon name: eye, star, zap, globe, bot, radio, bell, flame, sparkle, gem, aperture, droplets, wind, shell, cpu, compass. Default: bot.',
          },
          color: {
            type: 'string',
            description: 'Blob avatar color (hex, e.g. #7c6cff). Optional — pick a fitting color.',
          },
        },
        required: ['action'],
      },
    },
  },
]
