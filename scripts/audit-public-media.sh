#!/bin/bash

set -euo pipefail

ROOT="${1:-.}"

if ! command -v node >/dev/null 2>&1; then
  echo "Missing required media-audit command: node" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/audit-public-media.mjs" "$ROOT"
