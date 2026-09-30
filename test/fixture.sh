#!/usr/bin/env bash
# End to end through the CLI on test/project: `wasm-build-all all fixture` builds the fixture recipe in every
# flavour and runs its ctest suite under node and in Chromium, Firefox and WebKit; every count must be
# 4 passed / 0 failed / 1 skipped, and `wasm-build-all check fixture` must pass.
set -uo pipefail
source "$(dirname "$0")/common.sh"
P="$HOME_DIR/test/project"
rm -rf "$P/sysroot" "$P/recipes/fixture/build" "$P/recipes/fixture/results"
(cd "$P" && "$CLI" all fixture > "$work/log" 2>&1) || { bad "wasm-build-all all fixture"; tail -20 "$work/log"; }
for fl in $FLAVORS; do
  for s in upstream upstream-chromium upstream-firefox upstream-webkit; do
    got="$(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1])).suites[process.argv[2]];console.log(`${r.pass}/${r.fail}/${r.skip}`)}catch{console.log("none")}' "$P/recipes/fixture/results/wasm64-$fl.json" "$s")"
    [ "$got" = 4/0/1 ] && ok "$fl $s" || bad "$fl $s: got $got, want 4/0/1"
  done
done
(cd "$P" && "$CLI" check fixture > "$work/check" 2>&1) && ok "check fixture" || { bad "check fixture"; cat "$work/check"; }
finish "cli end to end"
