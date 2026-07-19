/**
 * Turn whatever someone typed into the URL bar into a URL.
 *
 * Kept pure and in shared so it can be unit-tested without a browser. The
 * rules are biased toward a developer's address bar: bare hosts and ports are
 * common, so `localhost:3000` must become a URL rather than a web search.
 */
export function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''

  // An explicit scheme is honoured, but "scheme" has to mean `foo://` or one
  // of the known slashless schemes. A bare `^word:` test is not enough:
  // `localhost:3000` matches it, and the most common thing typed into this
  // bar would have been passed through as a nonsense scheme.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (/^(about|mailto|data|blob|chrome|devtools|view-source|file):/i.test(value)) return value

  const looksLikeHost =
    // localhost, optionally with a port and path
    /^localhost(:\d+)?(\/|$)/i.test(value) ||
    // an IP, optionally with a port
    /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(value) ||
    // something.tld with no spaces
    (!/\s/.test(value) && /^[^/\s]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(value))

  if (looksLikeHost) {
    // Local addresses are almost never https in development, and defaulting
    // them to https produces a confusing certificate error instead of a page.
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(value)
    return `${isLocal ? 'http' : 'https'}://${value}`
  }

  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}

/** Protocol gate for anything handed to the operating system. */
export function isAllowedExternalUrl(input: string): boolean {
  try {
    const protocol = new URL(input).protocol
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/** Short label for a tab: the host, or the last path segment for files. */
export function displayTitle(url: string, title?: string): string {
  if (title?.trim()) return title.trim()
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return parsed.pathname.split('/').filter(Boolean).pop() || 'file'
    }
    return parsed.host || url
  } catch {
    return url || 'New tab'
  }
}
