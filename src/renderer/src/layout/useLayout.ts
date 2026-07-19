import { useCallback, useEffect, useState } from 'react'

const KEY = 'asv-agent-desk.layout.v1'

export interface LayoutState {
  sidebarWidth: number
  panelWidth: number
  sidebarCollapsed: boolean
  panelCollapsed: boolean
}

const DEFAULTS: LayoutState = {
  sidebarWidth: 240,
  panelWidth: 460,
  sidebarCollapsed: false,
  // The right panel is empty until Phase 5, so it starts out of the way.
  panelCollapsed: true,
}

export const LIMITS = {
  sidebar: { min: 180, max: 420 },
  panel: { min: 320, max: 900 },
}

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LayoutState>) }
  } catch {
    return DEFAULTS
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Panel geometry, persisted across launches.
 *
 * Only widths are adjustable. Nothing here may change the *height* of the
 * terminal column — height changes resize the PTY mid-render, which is the
 * TUI corruption vector.
 */
export function useLayout(): {
  layout: LayoutState
  setSidebarWidth: (w: number) => void
  setPanelWidth: (w: number) => void
  toggleSidebar: () => void
  togglePanel: () => void
} {
  const [layout, setLayout] = useState<LayoutState>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layout))
    } catch {
      // Persistence is a convenience, never a requirement.
    }
  }, [layout])

  const setSidebarWidth = useCallback((w: number) => {
    setLayout((l) => ({ ...l, sidebarWidth: clamp(w, LIMITS.sidebar.min, LIMITS.sidebar.max) }))
  }, [])

  const setPanelWidth = useCallback((w: number) => {
    setLayout((l) => ({ ...l, panelWidth: clamp(w, LIMITS.panel.min, LIMITS.panel.max) }))
  }, [])

  const toggleSidebar = useCallback(() => {
    setLayout((l) => ({ ...l, sidebarCollapsed: !l.sidebarCollapsed }))
  }, [])

  const togglePanel = useCallback(() => {
    setLayout((l) => ({ ...l, panelCollapsed: !l.panelCollapsed }))
  }, [])

  // ⌘B / ⌘\ mirror the conventions of the editors this sits alongside.
  //
  // Capture phase, for the same reason as ⌘↩ in the rail: xterm has focus and
  // swallows keydown before it reaches window in the bubbling phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 'b') {
        e.preventDefault()
        e.stopPropagation()
        toggleSidebar()
      } else if (e.key === '\\') {
        e.preventDefault()
        e.stopPropagation()
        togglePanel()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [toggleSidebar, togglePanel])

  return { layout, setSidebarWidth, setPanelWidth, toggleSidebar, togglePanel }
}
