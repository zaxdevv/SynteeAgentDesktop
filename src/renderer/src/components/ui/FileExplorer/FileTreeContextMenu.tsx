import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { getContextMenuPosition, type MenuPos } from '../../../utils/contextMenuPosition'
import { useFileTabsStore } from '../../../store/fileTabs.store'
import { useToast } from '../Toast/Toast'
import { springHover, whileHoverListItem, whileTapListItem } from '../../../utils/motionPresets'
import '../ChatContextMenu/ChatContextMenu.css'

export interface FileTreeContextMenuProps {
  relPath: string | null
  workdir: string | null
  pos: MenuPos | null
  onClose: () => void
}

// ── Контекстное меню файла в дереве FileExplorer (правый клик) ─────────
// Пункты: открыть в просмотре, открыть в проводнике, копировать путь.
export default function FileTreeContextMenu({ relPath, workdir, pos, onClose }: FileTreeContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const addToast = useToast(s => s.add)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  if (!relPath || !pos || !workdir) return null

  const { openUp, ...menuStyle } = getContextMenuPosition(pos)

  const handleOpenInViewer = () => {
    void useFileTabsStore.getState().openFile(relPath, workdir)
    onClose()
  }

  const handleOpenDiff = () => {
    void useFileTabsStore.getState().openFileDiff(relPath, workdir)
    onClose()
  }

  const handleOpenInExplorer = () => {
    window.syntee.shell.openPath(workdir)
    onClose()
  }

  const handleCopyPath = async () => {
    const fullPath = workdir.replace(/[\\/]+$/, '') + '\\' + relPath.replace(/\//g, '\\')
    try {
      await navigator.clipboard.writeText(fullPath)
      addToast('Путь скопирован', 'success')
    } catch {
      addToast('Не удалось скопировать', 'error')
    }
    onClose()
  }

  const handleCopyRelPath = async () => {
    try {
      await navigator.clipboard.writeText(relPath)
      addToast('Относительный путь скопирован', 'success')
    } catch {
      addToast('Не удалось скопировать', 'error')
    }
    onClose()
  }

  return createPortal(
    <AnimatePresence>
      {relPath && pos && (
        <motion.div
          ref={ref}
          className="chat-ctx-menu"
          style={{ position: 'fixed', ...menuStyle, zIndex: 9999 }}
          initial={{ opacity: 0, scale: 0.95, y: openUp ? 6 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
        >
          <CtxItem icon="filePen" label="Открыть в редакторе" onClick={handleOpenInViewer} />
          <CtxItem icon="git" label="Открыть изменения (diff)" onClick={handleOpenDiff} />
          <div className="ctx-divider" />
          <CtxItem icon="folder" label="Открыть в проводнике" onClick={handleOpenInExplorer} />
          <CtxItem icon="copy" label="Копировать путь" onClick={handleCopyPath} />
          <CtxItem icon="copy" label="Копировать отн. путь" onClick={handleCopyRelPath} />
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
      <AppIcon name={icon as 'eye'} size="sm" />
      <span>{label}</span>
    </motion.button>
  )
}
