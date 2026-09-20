import { useEffect, useRef } from 'react'

/**
 * useOverlayHitTesting — renderer-side hit-testing для click-through overlay-окна.
 *
 * Окно в click-through режиме (setIgnoreMouseEvents(true, {forward:true}))
 * пропускает клики сквозь себя, но mousemove продолжают приходить в renderer.
 * На каждый mousemove (троттлинг через rAF — max 1 проверка на кадр) проверяем
 * document.elementFromPoint: если курсор над [data-interactive] элементом
 * (карточка уведомления, activity-виджет) — окно становится интерактивным
 * (ловит клики), иначе — обратно click-through. IPC уходит ТОЛЬКО на смену
 * состояния, не на каждый mousemove.
 *
 * Это заменяет main-процесс polling (100ms курсор + 200ms bounds):
 *  - задержка клика = 1 IPC round-trip (~1-5ms) вместо до 100ms
 *  - точный хит-тест (elementFromPoint учитывает border-radius/transform/z-index)
 *  - ноль таймеров, setIgnoreMouseEvents дёргается только на hover enter/leave
 *
 * Safety: document mouseleave (курсор ушёл со всех экранов) и unmount
 * сбрасывают в click-through.
 */
export function useOverlayHitTesting(): void {
  const interactiveRef = useRef(false)
  const rafPending = useRef(false)

  useEffect(() => {
    const setInteractive = (v: boolean): void => {
      if (v === interactiveRef.current) return
      interactiveRef.current = v
      window.syntee.notification.setInteractive(v)
    }

    const onMove = (e: MouseEvent): void => {
      if (rafPending.current) return
      rafPending.current = true
      requestAnimationFrame(() => {
        rafPending.current = false
        const el = document.elementFromPoint(e.clientX, e.clientY)
        setInteractive(!!el?.closest('[data-interactive]'))
      })
    }

    // Курсор покинул документ (ушёл со всех экранов) — сброс в click-through
    const onLeave = (): void => setInteractive(false)

    window.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseleave', onLeave)
      setInteractive(false)
    }
  }, [])
}
