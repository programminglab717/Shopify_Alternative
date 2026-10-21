#!/bin/sh
# Lays out what an app's container image holds (ADR-724), from a built workspace: the manifests and
# built code of the app and the workspace packages it depends on, at the paths they have here, so
# that code finding files by path (migrations, themes) finds them; then the app's production
# dependencies alone, from the lockfile, offline from the store the workspace was installed from.
#
#   scripts/image-tree.sh @hatti/core /out/core
#
# Workspace packages are linked into node_modules where they are, not installed from it, so the
# peer dependencies they take from the app (Nest's, say) are found only when hoisted to the root.
set -eu
app=$1
out=$2

mkdir -p "$out"
cp package.json pnpm-lock.yaml pnpm-workspace.yaml "$out/"
pnpm --filter "$app..." ls --depth -1 --parseable | while read -r dir; do
  package=${dir#"$PWD/"}
  mkdir -p "$out/$package"
  cp "$package/package.json" "$out/$package/"
  if [ -d "$package/dist" ]; then cp -R "$package/dist" "$out/$package/"; fi
done
# What @hatti/db's migrate and @hatti/themes read from the repository's root.
cp -R --parents db/migrations themes "$out/"

cd "$out"
pnpm install --prod --offline --frozen-lockfile --filter "$app..." --config.shamefully-hoist=true
