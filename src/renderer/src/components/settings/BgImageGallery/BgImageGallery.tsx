/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore, type BgImage } from '../../../store/ui.store'
import { invalidateBgImageCache } from '../../../App'
import { useToast } from '../../ui/Toast/Toast'
import Popover from '../../ui/Popover/Popover'
import ColorPickerPopover from '../../ui/ColorPicker/ColorPickerPopover'
import AppIcon from '../../ui/AppIcon/AppIcon'
import Toggle from '../../ui/Toggle/Toggle'
import './BgImageGallery.css'

interface BgImageItem { src: string; name: string; size: number; mtime: number }

export default function BgImageGallery({ onSet }: { onSet: (k: string, v: unknown) => void }) {
  const [items, setItems] = useState<BgImageItem[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [gearOpen, setGearOpen] = useState(false)
  const [tintPickerOpen, setTintPickerOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const gearRef = useRef<HTMLButtonElement>(null)
  const tintSwatchRef = useRef<HTMLButtonElement>(null)
  const { add: toast } = useToast()

  const { bgImage, bgImageEnabled, setBgImage } = useUIStore(useShallow(s => ({
    bgImage: s.bgImage,
    bgImageEnabled: s.bgImageEnabled,
    setBgImage: s.setBgImage,
  })))
  // Debounce таймер для записи bgImage в config.json. Раньше каждый тик
  // слайдера блюра/тинта/прозрачности триггерил onSet → settings:set IPC →
  // синхронную сериализацию config.json в electron-store. Теперь визуал
  // применяется мгновенно через Zustand (setBgImage) + CSS-only патч в
  // applyBgImageToDOM, а персист в config.json — debounce ~300мс.
  const persistTimerRef = useRef<number | null>(null)

  const reloadList = useCallback(async () => {
    setLoading(true)
    const list = await window.syntee.bgImage.list()
    setItems(list)
    setLoading(false)
  }, [])

  useEffect(() => { reloadList() }, [reloadList])

  // Загрузка превью для всех картинок (dataURL кешируется в state)
  useEffect(() => {
    let cancelled = false
    Promise.all(items.map(async (item) => {
      if (previews[item.src]) return [item.src, previews[item.src]] as const
      const url = await window.syntee.bgImage.load(item.src)
      return [item.src, url || ''] as const
    })).then(results => {
      if (cancelled) return
      const next: Record<string, string> = { ...previews }
      for (const [src, url] of results) if (url && !next[src]) next[src] = url
      setPreviews(next)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items])

  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    e.target.value = ''
    let lastSrc: string | null = null
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
      const buf = await file.arrayBuffer()
      const savedPath = await window.syntee.bgImage.save(new Uint8Array(buf), ext)
      if (savedPath) lastSrc = savedPath
    }
    if (!lastSrc) {
      toast('Не удалось сохранить картинку фона', 'error')
      return
    }
    await reloadList()
    // Делаем последнюю загруженную активной
    const current = useUIStore.getState().bgImage
    const newBg: BgImage = {
      src: lastSrc,
      blur: current?.blur ?? 8,
      opacity: current?.opacity ?? 40,
      tint: current?.tint ?? '#000000',
      tintStrength: current?.tintStrength ?? 30,
      scale: current?.scale ?? 'cover',
    }
    onSet('bgImage', newBg)
  }

  const onSelect = (src: string) => {
    const current = useUIStore.getState().bgImage
    const newBg: BgImage = {
      src,
      blur: current?.blur ?? 8,
      opacity: current?.opacity ?? 40,
      tint: current?.tint ?? '#000000',
      tintStrength: current?.tintStrength ?? 30,
      scale: current?.scale ?? 'cover',
    }
    onSet('bgImage', newBg)
  }

  const onDelete = async (src: string) => {
    const ok = await window.syntee.bgImage.delete(src)
    if (!ok) { toast('Не удалось удалить', 'error'); return }
    // Инвалидируем кэш dataURL удалённой картинки в App.tsx.
    invalidateBgImageCache(src)
    // Если удалили активную — сбрасываем
    if (bgImage?.src === src) {
      onSet('bgImage', null)
    }
    await reloadList()
  }

  const patchBg = (patch: Partial<BgImage>) => {
    if (!bgImage) return
    const next = { ...bgImage, ...patch }
    // Мгновенный визуал: Zustand → useEffect в App.tsx → applyBgImageToDOM
    // (теперь CSS-only патч существующего узла, без перечитывания файла).
    setBgImage(next)
    // Персист в config.json — debounce, чтобы не долбить electron-store
    // синхронной записью на каждый пиксель слайдера.
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      onSet('bgImage', next)
      persistTimerRef.current = null
    }, 300)
  }

  return (
    <div className="bg-gallery">
      <div className="bg-gallery-header">
        <Toggle
          value={!!bgImageEnabled}
          onChange={v => onSet('bgImageEnabled', v)}
        />
        <span className="bg-gallery-header-label">Включить фон</span>
        <button
          ref={gearRef}
          className={`bg-gallery-gear${gearOpen ? ' bg-gallery-gear--active' : ''}`}
          onClick={() => setGearOpen(v => !v)}
          title="Параметры фона"
          disabled={!bgImage}
        >
          <AppIcon name="settings" size="sm" />
        </button>
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={onPickFiles} style={{ display: 'none' }} />

      <div className="bg-gallery-grid">
        <AnimatePresence>
          {items.map(item => (
            <motion.div
              key={item.src}
              className={`bg-gallery-tile${bgImage?.src === item.src ? ' bg-gallery-tile--active' : ''}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              onClick={() => onSelect(item.src)}
            >
              {previews[item.src] ? (
                <img src={previews[item.src]} alt="" className="bg-gallery-thumb" />
              ) : (
                <div className="bg-gallery-thumb-placeholder" />
              )}
              {bgImage?.src === item.src && (
                <div className="bg-gallery-tile-check">
                  <AppIcon name="check" size="xs" tone="accent" />
                </div>
              )}
              <button
                className="bg-gallery-tile-delete"
                onClick={(e) => { e.stopPropagation(); onDelete(item.src) }}
                title="Удалить"
              >
                <AppIcon name="x" size="xs" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        <motion.button
          className="bg-gallery-tile bg-gallery-tile--add"
          onClick={() => fileInputRef.current?.click()}
          whileTap={{ scale: 0.95 }}
          whileHover={{ y: -2 }}
          title="Добавить картинки"
        >
          <AppIcon name="plus" size="md" tone="muted" />
        </motion.button>
        {loading && items.length === 0 && (
          <div className="bg-gallery-empty">Загрузка…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="bg-gallery-empty">Нет картинок. Нажмите + чтобы добавить.</div>
        )}
      </div>

      {/* Гирька — панель параметров картинки фона */}
      <Popover open={gearOpen} onClose={() => setGearOpen(false)} anchorRef={gearRef} side="auto" align="end">
        <div className="bg-gear-panel">
          <div className="bg-gear-title">Параметры фона</div>
          <label className="bg-gear-row">
            <span>Прозрачность: {bgImage?.opacity ?? 0}%</span>
            <input type="range" min={0} max={100} value={bgImage?.opacity ?? 40}
              onChange={e => { patchBg({ opacity: Number(e.target.value) }) }} className="settings-slider" />
          </label>
          <label className="bg-gear-row">
            <span>Размытие: {bgImage?.blur ?? 0}px</span>
            <input type="range" min={0} max={40} value={bgImage?.blur ?? 8}
              onChange={e => { patchBg({ blur: Number(e.target.value) }) }} className="settings-slider" />
          </label>
          <div className="bg-gear-row bg-gear-tint">
            <span>Цвет тинта</span>
            <button
              ref={tintPickerOpen ? tintSwatchRef : undefined}
              className="bg-gear-tint-swatch"
              style={{ background: bgImage?.tint || '#000000' }}
              onClick={() => setTintPickerOpen(v => !v)}
            />
            <ColorPickerPopover
              open={tintPickerOpen}
              onClose={() => setTintPickerOpen(false)}
              anchorRef={tintSwatchRef}
              value={bgImage?.tint || '#000000'}
              onChange={(c) => patchBg({ tint: c })}
              onCommit={(c) => patchBg({ tint: c })}
            />
          </div>
          <label className="bg-gear-row">
            <span>Сила тинта: {bgImage?.tintStrength ?? 0}%</span>
            <input type="range" min={0} max={100} value={bgImage?.tintStrength ?? 30}
              onChange={e => { patchBg({ tintStrength: Number(e.target.value) }) }} className="settings-slider" />
          </label>
          <label className="bg-gear-row">
            <span>Масштаб</span>
            <select
              className="settings-select"
              value={typeof bgImage?.scale === 'number' ? 'pct' : (bgImage?.scale || 'cover')}
              onChange={e => {
                const v = e.target.value
                if (v === 'cover' || v === 'contain') patchBg({ scale: v })
                else if (v === 'pct') patchBg({ scale: 100 })
              }}
            >
              <option value="cover">Заполнить (cover)</option>
              <option value="contain">Вместить (contain)</option>
              <option value="pct">100%</option>
            </select>
          </label>
          {typeof bgImage?.scale === 'number' && (
            <label className="bg-gear-row">
              <span>Масштаб: {bgImage.scale}%</span>
              <input type="range" min={20} max={200} value={bgImage.scale}
                onChange={e => { patchBg({ scale: Number(e.target.value) }) }} className="settings-slider" />
            </label>
          )}
        </div>
      </Popover>
    </div>
  )
}
