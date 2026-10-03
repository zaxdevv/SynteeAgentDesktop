import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { MainPage } from '../../../store/nav.store'

/** The browser transitions rendered pixels; never clone or retain a React page.
 * Real descendants keep their own layout/animations. On navigation the outgoing
 * page and all its portals unmount normally, independent of nested motion exits.
 */
export default function PageTransitionHost({ page, chat, children }: {
  page: MainPage; chat: ReactNode; children: ReactNode
}) {
  const chatRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = chatRef.current
    if (!host) return
    if (page !== 'chat' && host.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur()
    }
    host.inert = page !== 'chat'
    return () => { host.inert = false }
  }, [page])

  return (
    <>
      <div ref={chatRef} className={`page-host ${page === 'chat' ? '' : 'page-host--hidden'}`}
        aria-hidden={page !== 'chat' || undefined}>
        {chat}
      </div>
      {page !== 'chat' && (
        <div key={page} className="page-motion-host">
          {children}
        </div>
      )}
    </>
  )
}
