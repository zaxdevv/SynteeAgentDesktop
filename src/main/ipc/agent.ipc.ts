import { ipcMain, BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { agentManager } from '../managers/AgentManager'
import { DEFAULT_AGENT_SETTINGS } from '../../shared/types'

export function registerAgentIPC(store: Store, getWindow: () => BrowserWindow | null) {
  // Инициализируем AgentManager
  agentManager.init(store)
  // Регистрируем getter окна для broadcast. Раньше тут был capture-паттерн
  // `const win = getWindow(); if (win) agentManager.registerWindow(win)`,
  // но getWindow() на момент регистрации возвращает null — mainWindow.create()
  // вызывается ПОЗЖЕ (index.ts:168 vs registerAgentIPC в index.ts:128).
  // В результате agent:update broadcast уходил в пустой Set, и live-карточки
  // суб-агентов в чате не обновлялись во время стриминга. Getter resolution
  // в момент broadcast закрывает этот race.
  agentManager.registerWindowGetter(getWindow)

  // Получить список всех агентов
  ipcMain.handle('agent:list', () => agentManager.getAll())

  // Получить конкретного агента
  ipcMain.handle('agent:get', (_e, id: string) => agentManager.get(id) ?? null)

  // Получить дочерних агентов
  ipcMain.handle('agent:children', (_e, parentId: string) => agentManager.getChildren(parentId))

  // Отменить агента (id опциональный — без id отменяем все running)
  ipcMain.handle('agent:cancel', (_e, id?: string) => {
    if (id) {
      agentManager.cancel(id)
    } else {
      agentManager.getAll()
        .filter(a => a.status === 'running')
        .forEach(a => agentManager.cancel(a.id))
    }
    return { ok: true }
  })

  // Очистить агентов чата
  ipcMain.handle('agent:clearChat', (_e, chatId: string) => {
    agentManager.clearChat(chatId)
    return { ok: true }
  })

  // Настройки агента
  ipcMain.handle('agent:getSettings', () => {
    const settings = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as Record<string, unknown>
    // Миграция: старый дефолт maxParallelSubAgents был 3, новый минимум — 5.
    // electron-store хранит персистированное значение, и новый DEFAULT_AGENT_SETTINGS
    // не перезаписывает уже сохранённый ключ. Без миграции пользователи, у которых
    // настройки уже сохранены со старым дефолтом 3, продолжат получать 3 несмотря
    // на изменение дефолта в коде.
    if (typeof settings.maxParallelSubAgents === 'number' && settings.maxParallelSubAgents < 5) {
      settings.maxParallelSubAgents = 5
      store.set('agentSettings', settings)
    }
    return settings
  })

  ipcMain.handle('agent:setSettings', (_e, settings: unknown) => {
    const current = store.get('agentSettings', DEFAULT_AGENT_SETTINGS) as Record<string, unknown>
    store.set('agentSettings', { ...current, ...(settings as Record<string, unknown>) })
    return { ok: true }
  })
}
