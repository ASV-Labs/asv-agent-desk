# Development

## Requirements

- Apple Silicon Mac running a current macOS release
- Node.js 22 and npm 10
- official Grok Build CLI
- git

Verified runtime matrix:

| Component | Verified |
| --- | --- |
| Grok Build | `0.2.103` |
| Electron | `43.1.1` |
| Node.js | `22.22.3` |
| Architecture | `arm64` |

Newer Grok Build versions may work, but the runtime preflight labels them unverified until live
hooks, sessions, worktrees, and shutdown have been exercised.

## Setup

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
git clone https://github.com/ASV-Labs/asv-agent-desk.git
cd asv-agent-desk
npm ci
npm run dev
```

On first run choose **Continue with OAuth**. Grok Build opens and owns the browser
authentication flow. To keep a disposable development profile:

```bash
GROK_HOME=/tmp/agent-desk-grok ASV_AGENT_DESK_CWD=/tmp/sample-repo npm run dev
```

`ASV_AGENT_DESK_GROK_COMMAND` can point at a specific CLI binary for compatibility testing.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Electron development process |
| `npm test` | Node test runner over TypeScript tests |
| `npm run typecheck` | Main/preload and renderer projects |
| `npm run build` | Electron production bundles |
| `npm run dist` | Local arm64 DMG build; not a public release |
| `npm run website:dev` | Product site development server |
| `npm run website:build` | Static Pages output |
| `npm run verify:public` | Privacy, brand, and credential-pattern audit |
| `npm run audit:media` | Offline metadata and OCR audit of public raster media |
| `npm run ci` | Public tree, app, and site gates |

## Tests that matter

Unit tests cover the state machines and safety boundaries, but native behavior still needs live
verification when those areas change:

- hook execution records from a real turn;
- concurrent background sessions and attention shortcuts;
- worktree isolation and main-side removal refusal;
- xterm mouse, plan viewer, and resize while streaming;
- browser view attachment, popups, and quit;
- packaged PTY startup and clean shutdown;
- no new macOS crash report or lingering helper process.

Do not treat a successful bundle as proof that `node-pty` or its `spawn-helper` works in a
package.
