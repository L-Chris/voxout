import { readFile } from 'node:fs/promises'

export async function loadDotEnv(paths: readonly string[]): Promise<void> {
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)
    const content = await readFile(path, 'utf8').catch(() => '')
    if (!content) continue
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line)
      if (!parsed || process.env[parsed.key] != null) continue
      process.env[parsed.key] = parsed.value
    }
  }
}

function parseEnvLine(line: string): { key: string, value: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
  if (!match) return null
  return {
    key: match[1],
    value: unquoteEnvValue(match[2]),
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  const hashIndex = trimmed.search(/\s#/)
  return (hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed).trim()
}
