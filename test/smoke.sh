#!/usr/bin/env bash
# The smoke program (heap past 4 GiB, exceptions, exception_ptr, setjmp/longjmp, SIMD + SSE emulation, threads,
# exceptions on a worker, awaiting a JS promise from C, file IO) in every flavour, under node and in Chromium,
# Firefox and WebKit.
set -uo pipefail
source "$(dirname "$0")/common.sh"
mkdir -p "$work/web"
for fl in $FLAVORS; do
  ( use_flavor $fl
    st=""; [ "$WBA_THREADS" = 1 ] || st=-DWBA_ST
    $CXX -O2 -msse2 $st "$HOME_DIR/test/smoke/smoke.cc" -o "$work/smoke-$fl.js" $WBA_NODE_TEST_LDFLAGS &&
      $CXX -O2 -msse2 $st "$HOME_DIR/test/smoke/smoke.cc" -o "$work/web/smoke-$fl.js" $WBA_WEB_TEST_LDFLAGS ) >/dev/null 2>&1 ||
    { bad "$fl: build"; continue; }
  out="$(cd "$work" && "$HOME_DIR/bin/wasm-run" "$work/smoke-$fl.js" 2>&1)"
  [[ "$out" == *"OK: 0 failure(s)"* ]] && ok "$fl: node ($(grep -c '^PASS' <<< "$out") checks)" || { bad "$fl: node"; grep FAIL <<< "$out"; }
  for b in chromium firefox webkit; do
    r="$(node "$HOME_DIR/lib/browser.mjs" "$work/web/smoke-$fl.js" --browsers $b 2>&1)"
    [[ "$r" == *"OK: 0 failure(s)"* ]] && ok "$fl: $b" || { bad "$fl: $b"; tail -3 <<< "$r"; }
  done
done
finish smoke
