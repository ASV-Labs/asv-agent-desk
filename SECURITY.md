# Security policy

## Supported version

Security fixes are applied to the current `main` branch. No signed binary release exists yet.

## Report a vulnerability

Please use GitHub's private vulnerability reporting for
`ASV-Labs/asv-agent-desk` rather than filing a public issue. Include:

- the affected commit;
- reproduction steps;
- the trust boundary crossed;
- expected and observed behavior;
- any proposed mitigation.

Do not include real tokens, OAuth data, API keys, private repository contents, or personal
session files. Use synthetic fixtures.

## Security model

ASV Agent Desk:

- runs the separately installed Grok Build CLI in a local PTY;
- inherits the launching process environment, including `XAI_API_KEY` when an advanced user
  explicitly exports it;
- delegates OAuth to Grok Build and does not read or store its token;
- reads Grok-owned sessions and worktrees from `GROK_HOME` or `~/.grok`;
- installs two personal hook files while running and removes them on clean quit;
- uses a bounded Unix socket hook bridge;
- keeps browser tabs sandboxed, context-isolated, Node-disabled, and in a separate partition;
- limits operating-system URL opens to `http`, `https`, and `mailto`;
- invokes CLI arguments positionally rather than interpolating shell strings;
- never executes code from terminal output.

The in-app browser is still a browser. Treat untrusted pages as untrusted, keep Electron current,
and do not expose new preload capabilities to browser views.

