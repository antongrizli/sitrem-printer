#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/bump-version.sh <major|minor|patch>

Updates package.json and package-lock.json without creating a Git commit or tag.
EOF
}

if [[ $# -ne 1 || "$1" == "--help" || "$1" == "-h" ]]; then
  usage
  [[ $# -eq 1 ]] && exit 0
  exit 1
fi

release_part="$1"
case "$release_part" in
  major|minor|patch) ;;
  *)
    echo "Version type must be major, minor, or patch; received: $release_part" >&2
    usage >&2
    exit 1
    ;;
esac

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }

current_version="$(node -p "require('./package.json').version")"
npm version "$release_part" --no-git-tag-version --ignore-scripts
new_version="$(node -p "require('./package.json').version")"

echo "Bumped SitremPrinter from $current_version to $new_version."
echo "Next, commit package.json and package-lock.json. Then run:"
echo "  git tag v$new_version"
echo "  git push origin v$new_version"
