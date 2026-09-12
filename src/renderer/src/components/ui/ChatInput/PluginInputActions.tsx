/**
 * PluginInputActions — кнопки плагинов над полем ввода чата
 * (registerInputAction). Ряд компактных icon-кнопок рядом с «+».
 *
 * Клик: command → подставить "/command " в инпут (юзер может дописать args
 * и отправить); без command → IPC plugins:inputAction → событие
 * 'input-action' { id } в процесс плагина.
 */
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { useExtensionsStore } from '../../../store/extensions.store'
import { collectInputActions } from '../../../utils/pluginExtApi'
import { springHover } from '../../../utils/motionPresets'

interface PluginInputActionsProps {
  /** Подставить текст в поле ввода (для command-кнопок). */
  onInsertCommand: (text: string) => void
}

export function PluginInputActions({ onInsertCommand }: PluginInputActionsProps) {
  const pluginsList = useExtensionsStore(s => s.plugins)
  const actions = useMemo(() => collectInputActions(), [pluginsList])

  if (actions.length === 0) return null

  return (
    <div className="plugin-input-actions">
      {actions.map(a => (
        <motion.button
          key={`${a.pluginId}-${a.id}`}
          type="button"
          className="plugin-input-action-btn"
          title={a.tooltip || a.label}
          aria-label={a.tooltip || a.label}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.92 }}
          transition={springHover}
          onClick={() => {
            if (a.command) {
              onInsertCommand(`/${a.command} `)
              return
            }
            void window.syntee.plugins.inputAction({ pluginId: a.pluginId, actionId: a.id }).catch(() => {})
          }}
        >
          <AppIcon name={(a.icon as Parameters<typeof AppIcon>[0]['name']) || 'puzzle'} size="sm" />
          <span className="plugin-input-action-label">{a.label}</span>
        </motion.button>
      ))}
    </div>
  )
}
