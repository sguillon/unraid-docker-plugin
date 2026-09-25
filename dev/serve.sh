#!/usr/bin/env bash
# Serve the editor locally against a scratch copy of the fixtures.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="${TMPDIR:-/tmp}/dte-dev"
if [[ ! -d "$work/templates" || "${1:-}" == "--reset" ]]; then
  rm -rf "$work"; mkdir -p "$work/templates"
  cp "$here"/fixtures/*.xml "$work/templates/"
fi
# Ace (Unraid 7 ships it at /webGui/javascript/ace); cache a copy for the harness.
if [[ ! -f "$work/ace/ace.js" ]]; then
  mkdir -p "$work/ace"
  for f in ace.js mode-xml.js mode-sh.js theme-tomorrow.js theme-tomorrow_night.js; do
    curl -fsSL "https://cdn.jsdelivr.net/npm/ace-builds@1.43.5/src-min-noconflict/$f" -o "$work/ace/$f" || echo "warning: could not fetch $f"
  done
fi
echo "Templates: $work/templates  ->  http://localhost:${PORT:-8765}/"
DTE_TEMPLATE_DIR="$work/templates" DTE_BACKUP_DIR="$work/backups" DTE_CONFIG_FILE="$work/docker-template-editor.cfg" DTE_DEV_ACE_DIR="$work/ace" \
  exec php -d short_open_tag=On -S "127.0.0.1:${PORT:-8765}" "$here/router.php"
