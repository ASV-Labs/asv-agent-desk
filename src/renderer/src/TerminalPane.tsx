import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

const THEME = {
  background: '#14161a',
  foreground: '#d6dae1',
  cursor: '#e8b339',
  selectionBackground: '#2c3440',
  black: '#14161a',
  red: '#e5534b',
  green: '#57ab5a',
  yellow: '#e8b339',
  blue: '#539bf5',
  magenta: '#b083f0',
  cyan: '#39c5cf',
  white: '#adbac7',
}

interface Props {
  /** The session to display. This component never creates or kills one. */
  sessionId: string
  /**
   * Inactive panes stay mounted and attached — their agents keep working and
   * their output keeps arriving. Only visibility changes.
   */
  hidden?: boolean
  onStatus?: (status: string) => void
}

/**
 * A view onto a session.
 *
 * It attaches on mount and detaches on unmount — it does not own the process.
 * That distinction is what makes remounts, hot reloads and window reopens
 * safe: the worst a view can do is stop watching.
 */
export default function TerminalPane({ sessionId, hidden, onStatus }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const refitRef = useRef<() => void>(() => {})

  // A hidden pane measures zero, so its resize is deferred until it is shown
  // again. Without this, switching sessions would resize the PTY to nothing
  // and Grok would repaint into a 0×0 terminal.
  useEffect(() => {
    if (hidden) return
    refitRef.current()
  }, [hidden])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const api = window.agentDesk.sessions

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      allowProposedApi: true,
      // Bounded: several of these are live at once from Phase 2 onward, and
      // each costs memory. Longer history lives in main's replay buffer.
      scrollback: 10_000,
      theme: THEME,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // WebGL is a large win for a TUI that repaints whole frames, but it is not
    // available on every GPU/driver combination. Canvas fallback is silent.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      onStatus?.('webgl unavailable — using canvas renderer')
    }

    fit.fit()

    let cancelled = false
    const teardown: Array<() => void> = []

    // Input goes through untouched, including mouse reports.
    teardown.push(term.onData((data) => api.write(sessionId, data)).dispose)
    teardown.push(term.onBinary((data) => api.write(sessionId, data)).dispose)

    teardown.push(
      api.onData(({ id, data }) => {
        if (id !== sessionId) return
        // Raw bytes straight to the emulator. The write callback fires once
        // the data has been parsed, which is our cue to release backpressure
        // in main. Without this the PTY outruns the renderer.
        term.write(data, () => {
          api.ack(id, new TextEncoder().encode(data).length)
        })
      }),
    )

    teardown.push(
      api.onStateChange(({ info, removed }) => {
        if (info.id !== sessionId) return
        if (removed) {
          onStatus?.('closed')
        } else if (info.state === 'exited') {
          term.write(`\r\n\x1b[2m[grok exited with code ${info.exitCode ?? 0}]\x1b[0m\r\n`)
          onStatus?.(`exited (${info.exitCode ?? 0})`)
        }
      }),
    )

    void (async () => {
      const result = await api.attach(sessionId)
      if (cancelled) return

      if (!result) {
        term.write('\x1b[2m[session no longer exists]\x1b[0m\r\n')
        onStatus?.('missing')
        return
      }

      // Replay first, then align the process to this view's geometry. Main
      // also nudges a repaint, since a TUI on the alternate screen will not
      // redraw merely because a new view showed up.
      if (result.replay) term.write(result.replay)
      api.resize(sessionId, term.cols, term.rows)

      onStatus?.(`session ${sessionId.slice(0, 8)}`)
      term.focus()
    })()

    // Resize is the most common way to corrupt a TUI: one landing mid-render
    // tears the frame. Debounce, and only notify on real dimension changes.
    let timer: number | undefined
    let lastCols = term.cols
    let lastRows = term.rows

    const syncSize = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        // Zero dimensions mean the pane is hidden. Skip entirely rather than
        // sending a degenerate size the TUI would have to repaint into.
        if (host.clientWidth === 0 || host.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          return
        }
        if (term.cols === lastCols && term.rows === lastRows) return
        lastCols = term.cols
        lastRows = term.rows
        api.resize(sessionId, term.cols, term.rows)
      }, 50)
    }

    const observer = new ResizeObserver(syncSize)
    observer.observe(host)
    window.addEventListener('resize', syncSize)
    // Lets the visibility effect above force a refit on becoming active.
    refitRef.current = syncSize

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('resize', syncSize)
      for (const off of teardown) off()
      // Detach, never close. The session keeps running without us.
      api.detach(sessionId)
      term.dispose()
    }
  }, [sessionId, onStatus])

  return (
    <div
      className={`terminal-host${hidden ? ' is-hidden' : ''}`}
      ref={hostRef}
      aria-hidden={hidden}
    />
  )
}
