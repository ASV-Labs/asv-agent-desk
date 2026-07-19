import { readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createWorker, OEM } from 'tesseract.js'
import language from '@tesseract.js-data/eng'
import exifr from 'exifr'

const root = path.resolve(process.argv[2] ?? '.')
const scanRoots = [path.join(root, 'docs'), path.join(root, 'website', 'public')]
const rasterExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp'])

const rules = [
  ['personal username', /charlesbonetti/i],
  ['macOS home path', /\/Users\/[A-Za-z0-9._-]+/i],
  ['internal repository name', /GrockDesktop/i],
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  [
    'session UUID',
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i
  ],
  ['XAI credential', /\bxai-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI credential', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['GitHub credential', /\b(?:github_pat_|ghp_)[A-Za-z0-9_]{16,}\b/]
]

async function walk(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute)))
    } else if (entry.isFile() && rasterExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolute)
    }
  }
  return files
}

function firstMatchingRule(text) {
  return rules.find(([, expression]) => expression.test(text))?.[0]
}

const files = (await Promise.all(scanRoots.map(walk))).flat().sort()
if (files.length === 0) {
  console.error('No public raster media found.')
  process.exit(2)
}

const worker = await createWorker('eng', OEM.LSTM_ONLY, {
  langPath: language.langPath,
  gzip: language.gzip,
  cacheMethod: 'none'
})

const findings = []
try {
  for (const file of files) {
    const relative = path.relative(root, file)
    const metadata = await exifr.parse(file, {
      tiff: true,
      exif: true,
      gps: true,
      iptc: true,
      xmp: true,
      icc: false
    })
    const metadataRule = firstMatchingRule(JSON.stringify(metadata ?? {}))
    if (metadataRule) {
      findings.push(`${relative}: metadata matched ${metadataRule}`)
    }

    const result = await worker.recognize(file)
    const text = result.data.text ?? ''
    const ocrRule = firstMatchingRule(text)
    if (ocrRule) {
      findings.push(`${relative}: OCR matched ${ocrRule}`)
    }
    console.log(`Inspected ${relative} — ${text.split('\n').filter(Boolean).length} OCR lines`)
  }
} finally {
  await worker.terminate()
}

if (findings.length > 0) {
  for (const finding of findings) console.error(`FAIL ${finding}`)
  process.exit(1)
}

console.log(`Public media audit passed: ${files.length} images, metadata + offline OCR.`)
