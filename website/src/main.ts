import './styles.css'

function markCopied(button: HTMLButtonElement): void {
  const original = button.textContent || 'Copy'
  button.textContent = 'Copied'
  button.dataset.copied = 'true'
  window.setTimeout(() => {
    button.textContent = original
    delete button.dataset.copied
  }, 1_800)
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      markCopied(button)
    } catch {
      const selection = window.getSelection()
      const code = button.parentElement?.querySelector('code')
      if (!selection || !code) return
      const range = document.createRange()
      range.selectNodeContents(code)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  })
}

const links = new Map(
  [...document.querySelectorAll<HTMLAnchorElement>('[data-chapter-link]')].map((link) => [
    link.dataset.chapterLink,
    link,
  ]),
)

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) return
      for (const link of links.values()) link.removeAttribute('aria-current')
      links.get(visible.target.id)?.setAttribute('aria-current', 'step')
    },
    { rootMargin: '-25% 0px -55%', threshold: [0.1, 0.35, 0.7] },
  )

  for (const chapter of document.querySelectorAll<HTMLElement>('[data-chapter]')) {
    observer.observe(chapter)
  }
}

