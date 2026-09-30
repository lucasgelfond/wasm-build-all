#!/usr/bin/env bash
# Self-test of lib/helpers.sh's result recording: runs wba_ctest (with a stub ctest) and wba_check under the
# same `set -euo pipefail` as recipes, and checks the counts written to the results file.
set -uo pipefail
HOME_DIR="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/recipe/results" "$work/build"
printf '#!/usr/bin/env bash\ncat "$FAKE_CTEST_OUT"\n' > "$work/bin/ctest"; chmod +x "$work/bin/ctest"
fails=0
counts() { node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1])).suites[process.argv[2]];console.log(`${s.pass}/${s.fail}/${s.skip}`)}catch{console.log("none")}' "$work/recipe/results/wasm64-mt.json" "$1"; }
run() { # name, ctest output, expected counts, expected exit
  printf '%s\n' "$2" > "$work/ctest.out"; rm -f "$work/recipe/results/"*.json
  ( export PATH="$work/bin:$PATH" FAKE_CTEST_OUT="$work/ctest.out" WBA_HOME="$HOME_DIR" WBA_FLAVOR=mt WBA_NODE="$(command -v node)"
    NAME=selftest VERSION=0 RECIPE="$work/recipe" BUILD="$work/build" JOBS=1
    source "$HOME_DIR/lib/helpers.sh"; wba_ctest suite ) > "$work/log" 2>&1
  local rc=$? got; got="$(counts suite)"
  if [ "$got" = "$3" ] && [ $rc = "$4" ]; then echo "PASS $1"; else echo "FAIL $1: got $got rc=$rc, want $3 rc=$4"; tail -3 "$work/log"; fails=$((fails+1)); fi
}
run "all pass (ctest 4.x summary)" "100% tests passed out of 8" "8/0/0" 0
run "some fail (classic summary)" "75% tests passed, 2 tests failed out of 8" "6/2/0" 0
run "skipped tests are not failures" $'3/5 Test #5: s ....***Skipped   0.28 sec\n100% tests passed out of 5\nThe following tests did not run:\n\t  5 - s (Skipped)' "4/0/1" 0
run "skip and fail together" $'2/5 Test #2: a ....***Failed\n4/5 Test #4: b ....***Skipped\n75% tests passed, 1 tests failed out of 5' "3/1/1" 0
run "no tests ran is an error" "No tests were found!!!" "none" 1
( export WBA_HOME="$HOME_DIR" WBA_FLAVOR=mt WBA_NODE="$(command -v node)" NAME=selftest VERSION=0 RECIPE="$work/recipe" BUILD="$work/build" JOBS=1
  source "$HOME_DIR/lib/helpers.sh"; wba_check ok true; wba_check bad false; wba_checks_done checks ) > "$work/log" 2>&1
[ "$(counts checks | cut -d/ -f1-2)" = "1/1" ] && echo "PASS wba_check records pass and fail" || { echo "FAIL wba_check"; fails=$((fails+1)); }
[ $fails = 0 ] && echo "helpers: ok" || { echo "helpers: $fails failure(s)"; exit 1; }
