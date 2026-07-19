import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * One resolver for every Grok-owned path.
 *
 * Grok supports moving its user data with `GROK_HOME`. Reading one location
 * for sessions and a different one for hooks or worktrees produces a
 * deceptively half-working app, so every service receives this same root.
 */
export function grokHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env.GROK_HOME?.trim()
  return configured ? resolve(configured) : join(home, '.grok')
}

/**
 * Grok's on-disk session layout.
 *
 * ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/
 *   summary.json        title, timestamps, model
 *   updates.jsonl       the event stream, including hook_execution records
 *   events.jsonl
 *   chat_history.jsonl
 *
 * The directory name is the working directory percent-encoded, so
 * /Users/demo/Projects/agent-sample becomes
 * %2FUsers%2Fdemo%2FProjects%2Fagent-sample.
 *
 * Because ASV Agent Desk passes `--session-id`, sessions it started are addressable
 * directly by the id it already holds — no scanning needed to find them.
 */

export function sessionsRoot(root = grokHome()): string {
  return join(root, 'sessions')
}

/** Percent-encode a working directory the way Grok names its folders. */
export function encodeCwd(cwd: string): string {
  return encodeURIComponent(cwd)
}

export function decodeCwd(encoded: string): string {
  try {
    return decodeURIComponent(encoded)
  } catch {
    // A malformed name is still a real directory on disk; show it as-is
    // rather than dropping the project from the sidebar entirely.
    return encoded
  }
}

export function projectDir(cwd: string, root = grokHome()): string {
  return join(sessionsRoot(root), encodeCwd(cwd))
}

export function sessionDir(cwd: string, sessionId: string, root = grokHome()): string {
  return join(projectDir(cwd, root), sessionId)
}

/** Worktrees live outside the session tree, keyed by repo then name. */
export function worktreesRoot(root = grokHome()): string {
  return join(root, 'worktrees')
}
