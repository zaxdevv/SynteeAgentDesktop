import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { getContextMenuPosition, type MenuPos } from '../../../utils/contextMenuPosition'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import { useToast } from '../../ui/Toast/Toast'
import { springHover, whileHoverListItem, whileTapListItem } from '../../../utils/motionPresets'
import '../../ui/ChatContextMenu/ChatContextMenu.css'

export interface FileTabContextMenuProps {
  tabId: string | null
  pos: MenuPos | null
  onClose: () => void
  tabsCount: number
}

// ── Контекстное меню вкладки файла в шапке (правый клик) ───────────────
// Короткое меню: закрыть, закрыть другие, открыть в проводнике, копировать путь.
export default function FileTabContextMenu({ tabId, pos, onClose, tabsCount }: FileTabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const openFileTabs = useFileTabsStore(s => s.openFileTabs)
  const closeFileTab = useFileTabsStore(s => s.closeFileTab)
  const toggleDiffMode = useFileTabsStore(s => s.toggleDiffMode)
  const workdir = useFileTabsStore(s => s.workdir)
  const addToast = useToast(s => s.add)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (!tabId || !pos) return null

  const tab = openFileTabs.find(t => t.id === tabId)
  if (!tab) return null

  const { openUp, ...menuStyle } = getContextMenuPosition(pos)

  const handleCloseTab = () => {
    closeFileTab(tabId)
    onClose()
  }

  const handleCloseOthers = () => {
    openFileTabs.forEach(t => {
      if (t.id !== tabId) closeFileTab(t.id)
    })
    onClose()
  }

  const handleCloseSaved = () => {
    openFileTabs.forEach(t => {
      if (!t.dirty) closeFileTab(t.id)
    })
    onClose()
  }

  const handleOpenInExplorer = () => {
    if (workdir) {
      // Открываем проводник с родительской папкой
      window.syntee.shell.openPath(workdir)
    }
    onClose()
  }

  const handleCopyPath = async () => {
    const fullPath = workdir ? `${workdir}\\${tab.relPath}`.replace(/\//g, '\\') : tab.relPath
    try {
      await navigator.clipboard.writeText(fullPath)
      addToast('Путь скопирован', 'success')
    } catch {
      addToast('Не удалось скопировать', 'error')
    }
    onClose()
  }

  return createPortal(
    <AnimatePresence>
      {tabId && pos && (
        <motion.div
          ref={ref}
          className="chat-ctx-menu"
          style={{ position: 'fixed', ...menuStyle, zIndex: 9999 }}
          initial={{ opacity: 0, scale: 0.95, y: openUp ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <CtxItem icon="x" label="Закрыть" onClick={handleCloseTab} />
          {tabsCount > 1 && (
            <CtxItem icon="x" label="Закрыть другие" onClick={handleCloseOthers} />
          )}
          {tabsCount > 1 && (
            <CtxItem icon="check" label="Закрыть сохранённые" onClick={handleCloseSaved} />
          )}
          <div className="ctx-divider" />
          {workdir && (
            <CtxItem
              icon="git"
              label={tab.diffMode ? 'Показать файл' : 'Открыть изменения (diff)'}
              onClick={() => { toggleDiffMode(tabId); onClose() }}
            />
          )}
          {workdir && (
            <CtxItem icon="folder" label="Открыть в проводнике" onClick={handleOpenInExplorer} />
          )}
          <CtxItem icon="copy" label="Копировать путь" onClick={handleCopyPath} />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

function CtxItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <motion.button
      className="ctx-item"
      onClick={onClick}
      whileHover={whileHoverListItem}
      whileTap={whileTapListItem}
      transition={springHover}
    >
      <AppIcon name={icon as 'x'} size="sm" />
      <span>{label}</span>
    </motion.button>
  )
}
