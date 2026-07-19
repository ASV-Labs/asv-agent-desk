#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const root = resolve(process.argv[2] || '.')
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'website-dist',
  '.vite',
  'coverage',
])

const forbiddenNames = [
  /^PHASE\d.*(?:REPORT|HANDOFF).*\.md$/i,
  /^SIGNING\.md$/i,
  /^grok-desk-plan\.md$/i,
  /^artifacts$/i,
  /^reports$/i,
  /^auth\.json$/i,
  /\.(?:pem|key|p12|pfx|mobileprovision|provisionprofile)$/i,
]

const contentRules = [
  { name: 'personal username', pattern: /charlesbonetti/gi },
  { name: 'personal macOS path', pattern: /\/Users\/charles(?:bonetti)?(?:\/|\\b)/gi },
  { name: 'private archive name', pattern: /\bGrockDesktop\b/gi },
  { name: 'private app id', pattern: /com\.charlesbonetti\.[a-z0-9.-]+/gi },
  { name: 'old preload namespace', pattern: /window\.grokdesk\b/gi },
  { name: 'old environment prefix', pattern: /\bGROKDESK_[A-Z0-9_]+\b/g },
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: 'xAI API key', pattern: /\bxai-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'OpenAI API key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'Apple app-specific password', pattern: /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/gi },
]

const textExtensions = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.plist',
  '.sh',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])

const findings = []
const files = []

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue

    const path = resolve(directory, entry.name)
    const rel = relative(root, path).split(sep).join('/')

    for (const pattern of forbiddenNames) {
      if (pattern.test(entry.name)) {
        findings.push(`${rel}: forbidden public-tree name`)
        break
      }
    }

    if (entry.isDirectory()) {
      await walk(path)
    } else if (entry.isFile()) {
      files.push({ path, rel })
    }
  }
}

await walk(root)

for (const file of files) {
  if (
    file.rel === 'scripts/verify-public-tree.mjs' ||
    file.rel === 'scripts/audit-public-media.sh' ||
    file.rel === 'scripts/audit-public-media.mjs'
  ) {
    continue
  }
  const suffix = extname(file.rel).toLowerCase()
  const info = await stat(file.path)
  if (!textExtensions.has(suffix) || info.size > 3_000_000) continue

  const body = await readFile(file.path, 'utf8')
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0
    const match = rule.pattern.exec(body)
    if (match) {
      const line = body.slice(0, match.index).split('\n').length
      findings.push(`${file.rel}:${line}: ${rule.name}`)
    }
  }
}

const brandedAssets = files.filter(({ rel }) =>
  /(?:^|\/)(?:grok|xai)[-_a-z0-9]*\.(?:png|jpe?g|webp|svg|gif|icns)$/i.test(rel),
)
for (const { rel } of brandedAssets) findings.push(`${rel}: third-party branded logo asset`)

const builder = files.find(({ rel }) => rel === 'electron-builder.yml')
if (builder) {
  const body = await readFile(builder.path, 'utf8')
  const productName = /^productName:\s*(.+)$/m.exec(body)?.[1]?.trim()
  if (!productName || productName !== 'ASV Agent Desk') {
    findings.push(`electron-builder.yml: productName must be exactly ASV Agent Desk`)
  }
  if (/\bGrok\b/i.test(productName)) {
    findings.push(`electron-builder.yml: app title contains a third-party mark`)
  }
}

const rendererIndex = files.find(({ rel }) => rel === 'src/renderer/index.html')
if (rendererIndex) {
  const body = await readFile(rendererIndex.path, 'utf8')
  const title = /<title>(.*?)<\/title>/is.exec(body)?.[1]?.trim()
  if (title !== 'ASV Agent Desk') {
    findings.push(`src/renderer/index.html: title must be exactly ASV Agent Desk`)
  }
}

if (findings.length > 0) {
  console.error(`Public-tree verification failed with ${findings.length} finding(s):`)
  for (const finding of findings.sort()) console.error(`  - ${finding}`)
  process.exit(1)
}

console.log(`Public-tree verification passed: ${files.length} files inspected, no findings.`)
