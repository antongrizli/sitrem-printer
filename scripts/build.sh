#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

command -v node >/dev/null || { echo "Node.js 22.17 or later is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }

node_major="$(node -p "process.versions.node.split('.')[0]")"
if (( node_major < 22 )); then
  echo "Node.js 22.17 or later is required; found $(node --version)." >&2
  exit 1
fi

echo "Type-checking, testing, and compiling SitremPrinter..."
npm run build
echo "SitremPrinter build completed."
