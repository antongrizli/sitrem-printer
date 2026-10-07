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
command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }

current_version="$(node -p "require('./package.json').version")"
node -e 'const p=require("./package.json"), l=require("./package-lock.json"); if(p.version !== l.version || p.version !== l.packages[""].version) { console.error("Version manifests disagree; resolve before bumping."); process.exit(1); }'
next_version="$(node -e 'const p=require("./package.json"); const v=p.version.split(".").map(Number); const i=["major","minor","patch"].indexOf(process.argv[1]); if(v.some(n=>!Number.isInteger(n))) process.exit(1); v[i]++; for(let j=i+1;j<3;j++) v[j]=0; console.log(v.join("."));' "$release_part")"
if git rev-parse --verify --quiet "refs/tags/v$next_version" >/dev/null; then
  echo "Tag v$next_version already exists; choose another version." >&2
  exit 1
fi
npm version "$release_part" --no-git-tag-version --ignore-scripts
new_version="$(node -p "require('./package.json').version")"

echo "Bumped SitremPrinter from $current_version to $new_version."
echo "Next, run:"
echo "  git add package.json package-lock.json"
echo "  git commit -m \"Bump version to $new_version\""
echo "  git push origin HEAD"
echo "  git tag v$new_version"
echo "  git push origin v$new_version"
