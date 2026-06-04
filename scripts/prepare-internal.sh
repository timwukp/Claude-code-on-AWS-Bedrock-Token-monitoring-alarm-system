#!/usr/bin/env bash
#
# Generate the INTERNAL variant of the repo (for the private GitLab mirror) from the public
# `main` tree. The public tree is the source of truth and contains NO secrets. This script
# layers an internal-only README section with live demo access details.
#
# Usage:
#   DEMO_URL=https://xxxx.cloudfront.net \
#   DEMO_USER=demo@example.com \
#   DEMO_PASS='********' \
#   ./scripts/prepare-internal.sh [output-dir]
#
# It copies the working tree (minus VCS/build/junk) to <output-dir> and prepends a
# "Demo access (internal only)" block to the README there. It NEVER modifies the public tree.
set -euo pipefail

OUT="${1:-../token-monitoring-internal}"
: "${DEMO_URL:?Set DEMO_URL}"
: "${DEMO_USER:?Set DEMO_USER}"
: "${DEMO_PASS:?Set DEMO_PASS}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Source (public tree): $ROOT"
echo "Output (internal):    $OUT"

mkdir -p "$OUT"
# Copy everything except VCS, dependencies, build artifacts, and local config.
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'cdk.out' \
  --exclude 'cdk.context.json' \
  --exclude '.env' --exclude '.env.local' \
  "$ROOT/" "$OUT/"

# Prepend an internal-only demo block to the README.
DEMO_BLOCK="$(cat <<EOF
> ## 🔒 Demo access (internal only — do NOT publish)
>
> | | |
> |---|---|
> | URL | ${DEMO_URL} |
> | Username | ${DEMO_USER} |
> | Password | ${DEMO_PASS} |
>
> This block exists only in the internal mirror. The public repository contains no credentials.
> Rotate these before any wider sharing.

EOF
)"
README="$OUT/README.md"
printf '%s\n%s' "$DEMO_BLOCK" "$(cat "$README")" > "$README"

echo "Done. Internal variant ready at: $OUT"
echo "Review it, then push to your internal GitLab remote."
