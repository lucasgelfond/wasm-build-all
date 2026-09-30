#!/usr/bin/env bash
# File I/O benchmark (informational): 200k-line write+read from main() and from 4 threads, with the JS filesystem
# and with WasmFS, per flavour, against native. Behind the per-flavour filesystem choice in flavors.json.
set -uo pipefail
source "$(dirname "$0")/common.sh"
for fl in $FLAVORS; do
  ( use_flavor $fl
    env="-sEXIT_RUNTIME=1 -sENVIRONMENT=node"; [ "$WBA_THREADS" = 1 ] && env="-sEXIT_RUNTIME=1 -sENVIRONMENT=node,worker -sPROXY_TO_PTHREAD=1"
    $CXX -O2 "$HOME_DIR/test/fsbench/fsbench.cc" -o "$work/js-$fl.js" -sWASMFS=0 $env 2>/dev/null
    $CXX -O2 "$HOME_DIR/test/fsbench/fsbench.cc" -o "$work/wasmfs-$fl.js" -sWASMFS=1 $env 2>/dev/null
    echo "== $fl, JS filesystem (in memory)"; wasm-run "$work/js-$fl.js" /tmp
    echo "== $fl, WasmFS (in memory)"; wasm-run "$work/wasmfs-$fl.js" /tmp )
done
echo "== native (host disk)"; c++ -O2 -std=c++17 -D__EMSCRIPTEN_PTHREADS__ "$HOME_DIR/test/fsbench/fsbench.cc" -o "$work/native" && "$work/native" "$work"
