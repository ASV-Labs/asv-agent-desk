import { useCallback, useEffect, useRef } from 'react'

interface Props {
  /** Which side the panel being resized sits on. */
  side: 'left' | 'right'
  onResize: (width: number) => void
  onDragEnd?: () => void
}

/**
 * A drag handle between panes.
 *
 * Pointer capture is used rather than document-level listeners so a fast drag
 * that leaves the handle keeps tracking. Note that `preventDefault` is scoped
 * strictly to the handle — the terminal must keep receiving its own mouse
 * events, or xterm's SGR mouse reporting breaks and Grok loses mouse support.
 */
export default function Splitter({ side, onResize, onDragEnd }: Props): React.JSX.Element {
  const dragging = useRef(false)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return
      const width = side === 'left' ? e.clientX : window.innerWidth - e.clientX
      onResize(width)
    },
    [side, onResize],
  )

  const stop = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    document.body.classList.remove('is-dragging')
    // Fire once at drag end so the PTY gets a final authoritative size.
    onDragEnd?.()
  }, [onDragEnd])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', stop)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', stop)
    }
  }, [onPointerMove, stop])

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault()
        dragging.current = true
        document.body.classList.add('is-dragging')
      }}
    />
  )
}
