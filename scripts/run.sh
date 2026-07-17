#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

# Some development shells set this for Electron's Node-mode tooling. A desktop
# Connector must always run as Electron so it can create a macOS tray item.
unset ELECTRON_RUN_AS_NODE
if [[ ! -f out/main/index.js || ! -f out/renderer/index.html ]]; then
  echo "Compiled application not found; building SitremPrinter first."
  npm run build
fi
echo "Starting the SitremPrinter Electron Connector"
echo "Click the SitremPrinter tray icon in the macOS menu bar to configure."
exec npm run run:local
