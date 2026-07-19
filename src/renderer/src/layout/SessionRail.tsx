import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../ui/Icon'
import type { SessionInfo } from '../../../shared/ipc'
import type { ActivityState } from '../../../shared/hooks'

interface Props {
  sessions: SessionInfo[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
}

const GLYPH: Record<ActivityState, string> = {
  'needs-you': '●',
  working: '◐',
  idle: '✓',
  failed: '✗',
  exited: '○',
}

/** Time in the current state, which is the number that actually matters. */
function elapsed(since: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function label(s: SessionInfo): string {
  return s.cwd.split('/').filter(Boolean).pop() || s.cwd
}

/**
 * The session rail: an attention queue, not a tab bar.
 *
 * With several agents running in parallel the bottleneck is not switching
 * between them, it is noticing that one has been blocked on you for minutes.
 * So each tab leads with state and time-in-state, waiting sessions sort first,
 * and ⌘↩ jumps to whoever has waited longest.
 */
export default function SessionRail({
  sessions,
  activeId,
  onSelect,
  onClose,
}: Props): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  const railRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const waiting = sessions
    .filter((s) => s.activity === 'needs-you')
    .sort((a, b) => a.activitySince - b.activitySince)

  // ⌘↩ — go to whoever has waited longest. One key, no scanning.
  //
  // Registered in the CAPTURE phase: xterm owns keyboard focus whenever a
  // terminal is visible and consumes keydown before it bubbles to window, so a
  // normal listener never fires. Capture runs on the way down instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.key !== 'Enter') return
      if (waiting.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const next = waiting.find((s) => s.id !== activeId) ?? waiting[0]
      onSelect(next.id)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [waiting, activeId, onSelect])

  // Waiting sessions bubble left; everything else keeps creation order.
  const ordered = [...sessions].sort((a, b) => {
    const aw = a.activity === 'needs-you' ? 0 : 1
    const bw = b.activity === 'needs-you' ? 0 : 1
    if (aw !== bw) return aw - bw
    return a.createdAt - b.createdAt
  })

  const updateScrollState = useCallback(() => {
    const rail = railRef.current
    if (!rail) return
    setCanScrollLeft(rail.scrollLeft > 1)
    setCanScrollRight(rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const frame = requestAnimationFrame(updateScrollState)
    const onResize = (): void => updateScrollState()
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
    }
  }, [sessions.length, updateScrollState])

  const scroll = useCallback((direction: -1 | 1) => {
    const rail = railRef.current
    if (!rail) return
    // One rich tab plus its gap. Keep the step stable so repeated presses are
    // predictable even when labels have different lengths.
    rail.scrollBy({ left: direction * 190, behavior: 'smooth' })
  }, [])

  if (sessions.length === 0) return null

  return (
    <div className="rail-shell">
      <button
        className="rail-scroll is-left"
        title="Earlier sessions"
        disabled={!canScrollLeft}
        onClick={() => scroll(-1)}
      >
        <Icon name="back" size={13} />
      </button>

      <div className="rail" ref={railRef} onScroll={updateScrollState}>
        {ordered.map((s) => (
          <div
            key={s.id}
            className={`rail-tab is-${s.activity}${s.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(s.id)}
            title={s.cwd}
          >
            <span className="rail-glyph">{GLYPH[s.activity]}</span>
            <div className="rail-body">
              <div className="rail-name">{label(s)}</div>
              <div className="rail-meta">
                {s.activity === 'needs-you' && `waiting ${elapsed(s.activitySince, now)}`}
                {s.activity === 'working' &&
                  (s.subagents > 0
                    ? `${s.subagents} subagent${s.subagents > 1 ? 's' : ''}`
                    : (s.lastTool ?? elapsed(s.activitySince, now)))}
                {s.activity === 'idle' && 'idle'}
                {s.activity === 'failed' && 'failed'}
                {s.activity === 'exited' && `exited ${s.exitCode ?? 0}`}
              </div>
            </div>
            <button
              className="rail-close"
              title="Close session"
              onClick={(e) => {
                e.stopPropagation()
                onClose(s.id)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}

        {waiting.length > 0 && (
          <div className="rail-queue" title="⌘↩ jumps to the longest wait">
            {waiting.length} waiting
            <kbd className="kbd">⌘↩</kbd>
          </div>
        )}
      </div>

      <button
        className="rail-scroll is-right"
        title="Later sessions"
        disabled={!canScrollRight}
        onClick={() => scroll(1)}
      >
        <Icon name="forward" size={13} />
      </button>
    </div>
  )
}
