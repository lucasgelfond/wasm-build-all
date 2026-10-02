#!/usr/bin/env bash
# Runs one step of one recipe for one flavour. Called by `wasm-build-all` with the flavour's environment and the
# recipe's variables (NAME VERSION RECIPE WBA_SRC_* WBA_REQUIRES WBA_RECIPE_FLAVORS) already exported.
#   run-recipe.sh fetch|build|test|package
set -euo pipefail
step="$1"
SRC="$RECIPE/src/$NAME-$VERSION"
if [ -n "${WBA_SRC_PATH:-}" ]; then case "$WBA_SRC_PATH" in /*) SRC="$WBA_SRC_PATH";; *) SRC="$RECIPE/$WBA_SRC_PATH";; esac; fi
BUILD="$RECIPE/build/wasm64-$WBA_FLAVOR"
STAGE="$RECIPE/build/stage-wasm64-$WBA_FLAVOR"
PREFIX="$STAGE$WBA_SYSROOT"
NATIVE="$RECIPE/build/native"
JOBS="${JOBS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc)}"
CACHE="$WBA_ROOT/.cache/downloads"   # shared download cache (sources, test corpora)
mkdir -p "$CACHE"
export NAME VERSION RECIPE SRC BUILD STAGE PREFIX NATIVE JOBS CACHE
# shellcheck disable=SC1091
source "$WBA_HOME/lib/helpers.sh"
mkdir -p "$RECIPE/src" "$RECIPE/results" "$BUILD"
share="$WBA_SYSROOT/share/wba"

applicable=0
for f in $WBA_RECIPE_FLAVORS; do [ "$f" = "$WBA_FLAVOR" ] && applicable=1; done

fetch() {
  local dl="$CACHE"
  if [ -n "${WBA_SRC_PATH:-}" ]; then   # a local source tree (tests, vendored code): used in place
    return 0
  fi
  if [ -n "${WBA_SRC_GIT:-}" ]; then
    [ -d "$SRC/.git" ] && return 0
    log "fetch $WBA_SRC_GIT @ $WBA_SRC_REV"
    git init -q "$SRC"; git -C "$SRC" remote add origin "$WBA_SRC_GIT"
    git -C "$SRC" fetch -q --depth 1 origin "$WBA_SRC_REV"; git -C "$SRC" checkout -q FETCH_HEAD
    return 0
  fi
  local f="$dl/$WBA_SRC_FILE" got
  if [ ! -f "$f" ]; then log "download $WBA_SRC_URL"; curl -fsSL --retry 3 -o "$f.part" "$WBA_SRC_URL"; mv "$f.part" "$f"; fi
  if [ -n "${WBA_SRC_HASH:-}" ]; then
    if [ ${#WBA_SRC_HASH} -eq 32 ]; then got="$(md5 -q "$f" 2>/dev/null || md5sum "$f" | cut -d' ' -f1)"
    else got="$(shasum -a 256 "$f" | cut -d' ' -f1)"; fi
    [ "$got" = "$WBA_SRC_HASH" ] || { echo "$NAME: hash mismatch for $f: got $got" >&2; rm -f "$f"; exit 1; }
  fi
  if [ ! -d "$SRC" ]; then
    rm -rf "$SRC.tmp"; mkdir -p "$SRC.tmp"; tar -xf "$f" -C "$SRC.tmp" --strip-components=1; mv "$SRC.tmp" "$SRC"
  fi
}
patch_src() {
  local stamp="$SRC/.wba-patched" p
  [ -n "${WBA_SRC_PATH:-}" ] && return 0
  [ -f "$stamp" ] && return 0
  for p in "$RECIPE"/patches/*.patch; do [ -f "$p" ] || continue; log "patch $(basename "$p")"; patch -d "$SRC" -p1 --forward -s < "$p"; done
  touch "$stamp"
}
merge_install() {
  mkdir -p "$share"
  if [ -d "$PREFIX" ]; then
    find "$PREFIX" \( -name '*.so' -o -name '*.so.*' -o -name '*.dylib' \) -exec rm -f {} + 2>/dev/null || true
    (cd "$PREFIX" && find . \( -type f -o -type l \) | sed 's|^\./||' | sort) > "$share/$NAME.files"
    (cd "$PREFIX" && tar -cf - .) | (cd "$WBA_SYSROOT" && tar -xf -)
  else
    log "warning: nothing staged in $PREFIX; no file manifest"; : > "$share/$NAME.files"
  fi
  echo "$VERSION" > "$share/$NAME"; echo "$WBA_REQUIRES" > "$share/$NAME.requires"
  log "installed $(wc -l < "$share/$NAME.files" | tr -d ' ') files into $WBA_SYSROOT"
}
package() {
  local out="$WBA_ROOT/dist" pkg="$NAME-$VERSION-wasm64-$WBA_FLAVOR" tmp pc
  [ -d "$PREFIX" ] || { echo "$NAME: nothing staged for $WBA_FLAVOR; build first" >&2; exit 1; }
  tmp="$(mktemp -d)"; mkdir -p "$out" "$tmp/$pkg"
  (cd "$PREFIX" && tar -cf - .) | (cd "$tmp/$pkg" && tar -xf -)
  # pkg-config files made relocatable: prefix relative to the .pc file's own directory.
  for pc in $(find "$tmp/$pkg" -name '*.pc'); do
    WBA_SR="$WBA_SYSROOT" perl -pi -e 's|^prefix=.*|prefix=\$\{pcfiledir\}/../..|; s|\Q$ENV{WBA_SR}\E|\$\{prefix\}|gi' "$pc"
  done
  printf 'name=%s\nversion=%s\nflavor=wasm64-%s\nrequires=%s\nemsdk=%s\n' "$NAME" "$VERSION" "$WBA_FLAVOR" "$WBA_REQUIRES" \
    "$(tr -d '"' < "$WBA_EMSDK/upstream/emscripten/emscripten-version.txt")" > "$tmp/$pkg/WBA-PACKAGE"
  cp "$RECIPE/results/wasm64-$WBA_FLAVOR.json" "$tmp/$pkg/" 2>/dev/null || true
  if grep -rIli -- "$WBA_SYSROOT" "$tmp/$pkg" >/dev/null 2>&1; then
    log "warning: absolute build paths left in: $(grep -rIli -- "$WBA_SYSROOT" "$tmp/$pkg" | sed "s|$tmp/$pkg/||" | tr '\n' ' ')"
  fi
  tar -czf "$out/$pkg.tar.gz" -C "$tmp" "$pkg"; rm -rf "$tmp"
  log "packaged dist/$pkg.tar.gz"
}

if [ $applicable = 0 ]; then
  case "$step" in
    test) rm -f "$RECIPE/results/wasm64-$WBA_FLAVOR.json"
          wba_result not-applicable 0 0 1 "${WBA_NA_REASON:-not built for $WBA_FLAVOR}" ;;
    *) log "not built for $WBA_FLAVOR" ;;
  esac
  exit 0
fi
for d in $WBA_REQUIRES; do
  [ -f "$share/$d" ] || { echo "$NAME needs $d: wasm-build-all build $d --flavor $WBA_FLAVOR" >&2; exit 1; }
done
# shellcheck disable=SC1091
source "$RECIPE/build.sh"
case "$step" in
  fetch) fetch; patch_src ;;
  build)
    if declare -F fetch_source >/dev/null; then fetch_source; else fetch; fi
    patch_src; build; merge_install ;;
  test) rm -f "$RECIPE/results/wasm64-$WBA_FLAVOR.json"; test ;;
  package) package ;;
  *) echo "unknown step $step" >&2; exit 2 ;;
esac
