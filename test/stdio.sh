#!/usr/bin/env bash
# stdio under node, per flavour: binary-safe stdout from a program that never opens a file, stdin from a file and
# from a pipe (3 MB), empty stdin. Upstream CLI test suites (zstd, xz, bzip2, ...) depend on all of it.
set -uo pipefail
source "$(dirname "$0")/common.sh"
head -c 3000000 /dev/urandom > "$work/rand.bin"
perl -e 'print chr($_ % 256) for 0..65535' > "$work/ramp.bin"
for fl in $FLAVORS; do
  ( use_flavor $fl; $CC -O2 "$HOME_DIR/test/stdio/cat.c" -o "$work/cat-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null ) || { bad "$fl: build"; continue; }
  r() { "$HOME_DIR/bin/wasm-run" "$work/cat-$fl.js" "$@"; }
  r gen 65536 > "$work/g" 2>/dev/null && cmp -s "$work/g" "$work/ramp.bin" && ok "$fl: binary stdout" || bad "$fl: binary stdout"
  r < "$work/rand.bin" > "$work/o" 2>/dev/null && cmp -s "$work/o" "$work/rand.bin" && ok "$fl: stdin from a file" || bad "$fl: stdin from a file"
  cat "$work/rand.bin" | r 2>/dev/null | cmp -s - "$work/rand.bin" && ok "$fl: stdin/stdout pipes" || bad "$fl: stdin/stdout pipes"
  printf '' | r > "$work/e" 2>/dev/null && [ ! -s "$work/e" ] && ok "$fl: empty stdin" || bad "$fl: empty stdin"
done
finish stdio
