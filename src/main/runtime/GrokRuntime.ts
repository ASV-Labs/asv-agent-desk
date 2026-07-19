import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { RuntimeStatus } from '../../shared/ipc'

const run = promisify(execFile)

export const TESTED_GROK_VERSION = '0.2.103'

export interface RuntimeProbe {
  status: RuntimeStatus
  /** Resolved executable path; kept in main and never exposed to the page. */
  command?: string
}

/** Extract the semantic version from either `grok version` output shape. */
export function parseGrokVersion(output: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output)?.[1]
}

/**
 * Fixed shell program used only to discover a command in the user's login
 * environment. The requested command is positional data, never interpolated.
 */
export function loginLookupArgs(command: string): string[] {
  return ['-l', '-c', 'command -v -- "$1"', 'asv-agent-desk-runtime', command]
}

export async function inspectGrokRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeProbe> {
  const testedVersion = TESTED_GROK_VERSION
  const shell = env.SHELL || '/bin/zsh'
  const requested = env.ASV_AGENT_DESK_GROK_COMMAND?.trim() || 'grok'

  try {
    let command = requested

    if (requested.includes('/')) {
      await access(requested)
    } else {
      const { stdout } = await run(shell, loginLookupArgs(requested), {
        env: env as Record<string, string>,
        timeout: 5_000,
      })
      command = stdout.trim().split('\n').at(-1)?.trim() || ''
      if (!command) throw new Error(`${requested} was not found in the login-shell PATH`)
    }

    const { stdout, stderr } = await run(command, ['version'], {
      env: env as Record<string, string>,
      timeout: 5_000,
    })
    const version = parseGrokVersion(`${stdout}\n${stderr}`)

    if (!version) {
      return {
        command,
        status: {
          installed: true,
          supported: false,
          testedVersion,
          error: 'Grok Build was found, but its version output could not be read.',
        },
      }
    }

    return {
      command,
      status: {
        installed: true,
        version,
        supported: version === testedVersion,
        testedVersion,
        error:
          version === testedVersion
            ? undefined
            : `Version ${version} has not been verified with this release.`,
      },
    }
  } catch (error) {
    return {
      status: {
        installed: false,
        supported: false,
        testedVersion,
        error: error instanceof Error ? error.message : 'Grok Build was not found.',
      },
    }
  }
}
