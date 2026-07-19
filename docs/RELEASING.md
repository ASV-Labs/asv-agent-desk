# Releasing

## Current state

Source is available now. A signed and notarized macOS build is pending Apple Developer Program
enrollment.

There is no official DMG or GitHub Release asset. Do not trust binaries distributed elsewhere
under this project name.

## Source release gate

Before updating `main`:

```bash
npm ci
npm run ci
```

Then verify the repository with Gitleaks, inspect every public image for metadata and OCR
leakage, and repeat the gates from a clean clone.

## Future signed macOS release

The existing package configuration keeps the hardened runtime enabled and unpacks
`node-pty/build/Release/**` so both `pty.node` and `spawn-helper` can be signed. A public binary
must not be published until all of these pass:

1. Developer ID Application signature with a non-empty TeamIdentifier
2. `codesign --deep --strict`
3. hardened runtime preserved
4. Apple notarization accepted
5. ticket stapled to the DMG
6. Gatekeeper accepts a quarantined clean install
7. a real session starts from `/Applications`
8. hooks, worktrees, browser tabs, and clean quit work in the signed package
9. no new crash report or lingering child/helper process

Use `npm run release` only when the Apple credentials exist. Never disable the hardened runtime,
remove entitlements, or fall back to an ad-hoc signature to make the gate green.

