import { flushSync } from 'react-dom'

/** Chromium captures composited pixels, not a cloned/re-laid-out DOM tree.
 * The actual page unmounts in the update callback (including its portals).
 * Only the named content area participates; dock/right panel remain live.
 */
let active: ViewTransition | undefined
let deadline: ReturnType<typeof setTimeout> | undefined
let generation = 0

export function transitionMainPage(update: () => void, closing: boolean): void {
  const current = ++generation
  active?.skipTransition()
  active = undefined
  if (deadline !== undefined) clearTimeout(deadline)
  deadline = undefined

  const doc = typeof document !== 'undefined' ? document : undefined
  const root = doc?.documentElement
  const clear = () => {
    if (current !== generation) return
    active = undefined
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
    root?.removeAttribute('data-syntee-page-transition')
    root?.removeAttribute('data-syntee-page-capture')
  }
  let committed = false
  const commit = () => {
    // A skipped transition may still run its update callback later.
    if (committed || current !== generation) return
    committed = true
    // Capture OLD page only. Capturing the incoming chat/page would exclude
    // its live DOM from hit-testing for the duration of the native transition.
    root?.removeAttribute('data-syntee-page-capture')
    flushSync(update)
  }

  const surface = doc?.querySelector('.rp-chat-area')
  if (!doc || !root || !surface || typeof doc.startViewTransition !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    commit()
    clear()
    return
  }

  const focused = doc.activeElement
  if (focused instanceof HTMLElement && surface.contains(focused)) focused.blur()
  root.setAttribute('data-syntee-page-transition', closing ? 'close' : 'open')
  root.setAttribute('data-syntee-page-capture', '')
  try {
    const transition = doc.startViewTransition(commit)
    active = transition
    // Capture can be skipped (hidden window, resize, duplicate names, etc.).
    // None of those failures may prevent navigation or leave an overlay.
    void transition.ready.catch(() => {})
    void transition.updateCallbackDone.catch(() => {})
    const finish = () => {
      // Even an aborted capture must commit the latest requested navigation.
      commit()
      clear()
    }
    void transition.finished.then(finish, finish)
    deadline = setTimeout(() => {
      if (current !== generation) return
      transition.skipTransition()
      commit()
      clear()
    }, 600)

    // Cleanup is owned by finished or the independent deadline.
  } catch {
    commit()
    clear()
  }
}
