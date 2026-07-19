# Contributing to ASV Agent Desk

Thank you for helping improve ASV Agent Desk. This project keeps the real Grok Build terminal
experience intact and adds local orchestration around it. A contribution is welcome when it
respects that boundary.

## Start here

1. Read [the architecture](docs/ARCHITECTURE.md).
2. Install the official Grok Build CLI.
3. Fork and clone this repository.
4. Run `npm ci`.
5. Run `npm test && npm run typecheck && npm run build`.
6. Create a focused branch and keep unrelated changes out of the patch.

## Non-negotiable architecture

- Never scrape, parse, transform, or infer state from PTY output.
- Preserve raw PTY bytes in both directions and the renderer acknowledgement loop.
- Never subscribe to `PreToolUse`; it is blocking and a stalled GUI would stall the agent.
- Keep personal hooks under the resolved Grok home. The generated hook script must always exit
  zero.
- Main owns sessions and browser tabs. React mirrors state; it does not own processes or native
  views.
- Keep the terminal column height stable at runtime.
- Keep `BaseWindow` plus `WebContentsView`; do not replace native browser views with an iframe or
  `<webview>`.
- Keep `node-pty` external and unpack its native release artifacts.
- Never remove a live or dirty worktree. The guard belongs in main, not just in the renderer.
- Treat Grok's session directory as read-only.

If a requested change conflicts with one of these constraints, open an issue explaining the
use case and the conflict before writing a workaround.

## Pull requests

A useful pull request includes:

- the user-visible problem and intended behavior;
- focused tests for the regression or new boundary;
- the commands you ran and their results;
- screenshots for renderer changes at a normal and narrow width;
- no credentials, personal paths, real session IDs, private repositories, or private history.

Run the public-release audit before pushing:

```bash
npm run verify:public
npm run audit:media
npm test
npm run typecheck
npm run build
npm run website:build
```

## Website changes

The product site is governed by the checked-in Web Design Intelligence artifacts. Preserve the
numbered proof spine, card budget, real-product imagery rule, reduced-motion behavior, and
WDI-011 pass. Update `website/design-notes.md` when the design premise changes and rerun the WDI
verification gate.

## Commit style

Use a short imperative subject that describes the outcome, for example:

```text
Guard external protocols in main
Preserve tab selection while scrolling
Document OAuth-first setup
```

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
