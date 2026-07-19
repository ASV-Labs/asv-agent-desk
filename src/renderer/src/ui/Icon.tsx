/**
 * The icon set.
 *
 * Inline SVG rather than an icon font or package: about a dozen glyphs do not
 * justify a dependency, and inlining means no flash of unstyled icons on a
 * cold start and no extra request in a packaged app.
 *
 * All icons are drawn on a 16×16 grid with a 1.5 stroke and inherit
 * `currentColor`, so they take colour from whatever they sit inside and stay
 * optically consistent at small sizes — which is where hand-picked unicode
 * characters fall apart, each one drawn to a different weight and baseline.
 */

export type IconName =
  | 'plus'
  | 'fork'
  | 'close'
  | 'chevron-right'
  | 'chevron-down'
  | 'back'
  | 'forward'
  | 'reload'
  | 'stop'
  | 'external'
  | 'globe'
  | 'diff'
  | 'folder'
  | 'terminal'
  | 'panel-right'
  | 'sidebar'
  | 'search'

const PATHS: Record<IconName, React.ReactNode> = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  fork: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="11.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <path d="M4.5 5v6M11.5 5v1.5a3 3 0 0 1-3 3H4.5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  'chevron-right': <path d="M6 3.5L10.5 8 6 12.5" />,
  'chevron-down': <path d="M3.5 6L8 10.5 12.5 6" />,
  back: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  forward: <path d="M6 3.5L10.5 8 6 12.5" />,
  reload: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v2.5h-2.5" />,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1" />,
  external: <path d="M9.5 3.5H12.5V6.5M12.5 3.5L7.5 8.5M11 9.5v3h-8v-8h3" />,
  globe: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.7 2.4 3.6 2.4 5.5S9.6 12.3 8 13.5C6.4 12.3 5.6 10 5.6 8S6.4 4.2 8 2.5z" />
    </>
  ),
  diff: <path d="M4.5 3v10M4.5 6.5h5M11.5 3v10M14 8h-5" />,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3l1.2 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  terminal: <path d="M3.5 4.5L7 8l-3.5 3.5M8.5 11.5h4" />,
  'panel-right': (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M10 3v10" />
    </>
  ),
  sidebar: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6 3v10" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
}

interface Props {
  name: IconName
  size?: number
  className?: string
}

export default function Icon({ name, size = 14, className }: Props): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
