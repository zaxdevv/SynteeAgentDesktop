import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

/** Variable-height long list; small lists keep their original DOM. All data remains accessible in memory. */
export default function VirtualMessageList<T extends { id: string }>({ items, scrollRef, renderItem, gap, estimatedSize, scope, pinnedRef }: {
  items: T[]
  scrollRef: RefObject<HTMLDivElement>
  renderItem: (item: T, index: number, firstMount: boolean) => ReactNode
  gap: number
  estimatedSize: number
  scope: string
  pinnedRef: RefObject<boolean>
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const seenRef = useRef(new Set<string>())
  const previousScope = useRef(scope)
  const virtual = items.length > 150
  const getKey = useCallback((index: number) => items[index].id, [items])
  const [scrollMargin, setScrollMargin] = useState(0)
  const [, mountRevision] = useState(0)
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedSize,
    getItemKey: getKey,
    overscan: 6,
    gap,
    useAnimationFrameWithResizeObserver: true,
    scrollMargin,
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    !pinnedRef.current && item.start < (instance.scrollOffset ?? 0)

  // Parent refs attach after child effects on first mount; refresh virtualizer.
  useEffect(() => { mountRevision(n => n + 1) }, [virtual])
  useLayoutEffect(() => {
    const host = hostRef.current
    const el = scrollRef.current
    if (!virtual || !host || !el) return
    const measureOffset = () => setScrollMargin(host.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop)
    measureOffset()
    const ro = new ResizeObserver(measureOffset)
    ro.observe(el)
    if (host.parentElement) ro.observe(host.parentElement)
    return () => ro.disconnect()
  }, [virtual, scope, scrollRef, items.length])
  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope
      seenRef.current.clear()
      virtualizer.measure()
    }
  }, [scope, virtualizer])
  // Preserve the bottom-pinned behavior as live messages/images grow.
  useLayoutEffect(() => {
    if (!virtual || !hostRef.current) return
    const el = scrollRef.current
    const ro = new ResizeObserver(() => { if (pinnedRef.current && el) el.scrollTop = el.scrollHeight })
    ro.observe(hostRef.current)
    return () => ro.disconnect()
  }, [virtual, scrollRef, pinnedRef])
  if (!virtual) return <>{items.map((item, index) => renderItem(item, index, true))}</>
  return <div ref={hostRef} style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative', flexShrink: 0 }}>
    {virtualizer.getVirtualItems().map(row => {
      const item = items[row.index]
      const firstMount = !seenRef.current.has(item.id)
      seenRef.current.add(item.id)
      return <div key={item.id} data-index={row.index} ref={virtualizer.measureElement}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', display: 'flex', flexDirection: 'column', transform: `translateY(${row.start - scrollMargin}px)` }}>
        {renderItem(item, row.index, firstMount)}
      </div>
    })}
  </div>
}
