#!/bin/bash
#
# Assert that a build is genuinely signed, notarized and stapled.
#
# electron-builder exits 0 when it cannot find a signing identity — it prints
# "skipped macOS application code signing" and carries on producing an ad-hoc
# signed artifact. `notarize: true` is not a build gate. This script is.
#
# Usage: scripts/verify-signing.sh [app-path] [dmg-path]

set -uo pipefail

APP="${1:-dist/mac-arm64/ASV Agent Desk.app}"
DMG="${2:-$(ls dist/ASV-Agent-Desk-*.dmg 2>/dev/null | head -1)}"

fail=0
note() { printf '  %s\n' "$1"; }
ok()   { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { printf '\033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }

echo "Verifying signing"
echo "  app: $APP"
echo "  dmg: ${DMG:-<none found>}"
echo

if [[ ! -d "$APP" ]]; then
  bad "app bundle not found — run npm run build:dist first"
  exit 1
fi

# 1. Real Developer ID signature, not the linker's ad-hoc one.
sig="$(codesign -dv --verbose=4 "$APP" 2>&1)"
team="$(printf '%s\n' "$sig" | awk -F'=' '/^TeamIdentifier=/ {print $2}')"

if [[ -z "$team" || "$team" == "not set" ]]; then
  bad "no TeamIdentifier — this is an ad-hoc/linker signature, not Developer ID"
  note "check: security find-identity -v -p codesigning"
else
  ok "signed by team $team"
fi

if printf '%s\n' "$sig" | grep -q 'flags=.*adhoc'; then
  bad "signature is ad-hoc"
else
  ok "signature is not ad-hoc"
fi

# 2. Hardened runtime must be on, and must not have been switched off to make
#    notarization pass — that would defeat the point.
if printf '%s\n' "$sig" | grep -q 'flags=.*runtime'; then
  ok "hardened runtime enabled"
else
  bad "hardened runtime missing — required for notarization"
fi

# 3. Deep verification catches an unsigned nested binary, which is the usual
#    node-pty failure: pty.node or spawn-helper left out of the signing pass.
if codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | grep -q 'satisfies its Designated Requirement'; then
  ok "deep verification passed (nested binaries signed)"
else
  bad "deep verification failed — check pty.node and spawn-helper in app.asar.unpacked"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -5
fi

# 4. Gatekeeper's own opinion.
if spctl -a -vvv -t install "$APP" 2>&1 | grep -q 'accepted'; then
  ok "Gatekeeper accepts the app"
else
  bad "Gatekeeper rejects the app"
  spctl -a -vvv -t install "$APP" 2>&1 | tail -3
fi

# 5. A stapled ticket means notarization actually completed, not just that the
#    submission was sent.
if [[ -n "${DMG:-}" && -f "$DMG" ]]; then
  if xcrun stapler validate "$DMG" 2>&1 | grep -q 'The validate action worked'; then
    ok "notarization ticket stapled to the dmg"
  else
    bad "dmg has no stapled ticket"
    note "logs: xcrun notarytool log <submission-id> --apple-id \"\$APPLE_ID\" --team-id \"\$APPLE_TEAM_ID\""
  fi
else
  bad "no dmg found to validate"
fi

echo
if [[ $fail -eq 0 ]]; then
  echo "All signing checks passed — this build is releasable."
else
  echo "Signing verification FAILED. Do not ship this build."
  echo "Do not disable the hardened runtime to make these pass."
fi
exit $fail
