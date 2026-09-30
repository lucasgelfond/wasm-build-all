#!/usr/bin/env bash
# Relinks every test program in a ninja build tree for the browser, next to the node build: foo.js -> foo.web.js.
# Only the final link runs again (objects are reused): the node-only flags (host filesystem, node environment)
# are removed and the flavour's webTest flags from flavors.json ($WBA_WEB_TEST_LDFLAGS) are added, so the program
# gets the flavour's shipping filesystem and a filesystem API the browser harness can load test data through.
#   relink-web.sh <build-dir>          (inside a flavour's environment; WBA_WEB_ASSERTIONS=1 adds -sASSERTIONS)
set -euo pipefail
dir="$1"
extra="$WBA_WEB_TEST_LDFLAGS${WBA_WEB_ASSERTIONS:+ -sASSERTIONS=1}"
n=0; failed=0
targets="$(ninja -C "$dir" -t targets all 2>/dev/null | sed -n 's/^\([^:]*\.js\): .*/\1/p')"
while IFS= read -r cmd; do
  case "$cmd" in *" -c "*|*.web.js*) continue;; esac
  out="$(printf '%s\n' "$cmd" | grep -Eo -- '-o [^ ]+\.js( |$)' | tail -1 | sed -E 's/^-o //; s/ $//')" || continue
  [ -n "$out" ] || continue
  web="${out%.js}.web.js"
  # Flags go right after -o: CMake wraps link lines as ": && <launcher> em++ ... && :".
  new="$(printf '%s\n' "$cmd" | sed -E \
    -e 's/ -sNODERAWFS=1//g; s/ -sWASMFS=0//g; s/ -sENVIRONMENT=[a-z,]+//g' \
    -e "s# -o ${out//./\\.}( |\$)# -o ${web} ${extra}\\1#")"
  if (cd "$dir" && eval "$new") > /dev/null 2>&1; then n=$((n+1)); else failed=$((failed+1)); echo "relink-web: failed for $out" >&2; fi
done < <([ -n "$targets" ] && ninja -C "$dir" -t commands $targets 2>/dev/null \
         | grep -E '(em\+\+|emcc|wba-launch)[^ ]* ' | grep -E -- '-o [^ ]+\.js( |$)' | sort -u)
echo "relink-web: $n programs relinked for the browser$([ $failed -gt 0 ] && echo ", $failed failed")"
