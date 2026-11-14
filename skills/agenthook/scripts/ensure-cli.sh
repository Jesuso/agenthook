#!/bin/sh
# Make sure the `agenthook` CLI this skill drives is installed.
#   sh <skill dir>/scripts/ensure-cli.sh [--dry-run]
# Already on PATH: says which version and where, and exits 0 (a version other than the one this
# skill was written for is a note, never an error — the installed CLI is the one the receiver runs).
# Missing: installs the version stamped in ../SKILL.md with npm, globally, falling back to
# ~/.local when the global prefix is not writable. Needs Node >= 22. --dry-run prints the
# install command instead of running it.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
want=$(sed -n 's/^<!-- agenthook-skill \([0-9][0-9A-Za-z.+-]*\) -->.*/\1/p' "$dir/../SKILL.md" 2>/dev/null | head -n 1)
pkg="@jesuso/agenthook${want:+@$want}"

if command -v agenthook >/dev/null 2>&1; then
  have=$(agenthook --version 2>/dev/null || echo "?")
  echo "agenthook $have is installed: $(command -v agenthook)"
  if [ -n "$want" ] && [ "$have" != "$want" ]; then
    echo "note: this skill was written for agenthook $want. If a command it names is missing, update with: npm install -g $pkg"
  fi
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "agenthook needs Node.js 22 or newer, and node is not installed. Install it (https://nodejs.org), then run this again." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 22 ]; then
  echo "agenthook needs Node.js 22 or newer; this is $(node --version). Upgrade Node, then run this again." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "node is installed but npm is not on PATH; install npm, then run: npm install -g $pkg" >&2
  exit 1
fi

if [ "${1:-}" = "--dry-run" ]; then
  echo "agenthook is not installed. Would run: npm install -g $pkg"
  exit 0
fi

echo "agenthook is not installed. Running: npm install -g $pkg" >&2
if npm install -g "$pkg" >&2; then
  :
elif npm install -g --prefix "$HOME/.local" "$pkg" >&2; then
  echo "the global npm prefix is not writable; installed under $HOME/.local instead" >&2
else
  echo "could not install $pkg — run it by hand and read npm's error: npm install -g $pkg" >&2
  exit 1
fi

if command -v agenthook >/dev/null 2>&1; then
  echo "agenthook $(agenthook --version 2>/dev/null || echo "$want") is installed: $(command -v agenthook)"
elif [ -x "$HOME/.local/bin/agenthook" ]; then
  echo "agenthook is installed at $HOME/.local/bin/agenthook, which is not on PATH."
  echo "Call it by that full path, or first run: export PATH=\"\$HOME/.local/bin:\$PATH\""
else
  echo "installed $pkg, but \`agenthook\` is not on PATH — add npm's global bin directory (\`npm prefix -g\`/bin) to PATH." >&2
  exit 1
fi
