#!/bin/sh
# Regenerate the shipped reader from an unmodified public Scout release.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
ref=5dc3c2976fafc879366843fe84082456cc9a2d2a
repo=${1:-"$stage/scout"}
if [ "$#" -eq 0 ]; then
  git clone -q --depth 1 --branch v0.5.3 https://github.com/openscout-app/scout.git "$repo"
fi
git -C "$repo" archive -o "$stage/source.tar" "$ref" packages/runtime/src
tar -xf "$stage/source.tar" -C "$stage"
cd "$stage"
echo 'export { scanRecentSessionKnowledge } from "./packages/runtime/src/knowledge/session-indexer.ts";' > reader.ts
bun build reader.ts --target=node --external=bun:sqlite --outfile=recent.mjs
cp recent.mjs "$root/vendor/recent.mjs"
