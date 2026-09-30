#!/usr/bin/env bash
# ABI guards, per flavour:
#  - A CMake project that sets its own CMAKE_CXX_FLAGS still gets the flavour's ABI flags, and CMake sees 64-bit
#    pointers (the fixture's CMakeLists asserts it).
#  - C through the wrappers is 64-bit; a one-step C compile+link stays C (asyncify links through em++).
#  - C with a cleanup attribute left by longjmp through an indirect call links and runs (libc++abi in asyncify).
#  - A link without the flavour's LDFLAGS still gets the base link flags (memory growth).
#  - -pthread from a build system is dropped outside mt.
#  - thread_local destructors run (at thread exit; and at program exit outside mt, where main() is a proxied
#    worker whose TLS destructors Emscripten doesn't run at exit).
#  - KNOWN clang bug, reported not failed: a lifetime-extended static reference (`static const T& x = T();`)
#    registers its this-returning destructor with __cxa_atexit without a thunk and traps at program exit.
set -uo pipefail
source "$(dirname "$0")/common.sh"
for fl in $FLAVORS; do
  ( use_flavor $fl
    cmake -G Ninja -S "$HOME_DIR/test/project/recipes/fixture/src" -B "$work/cm-$fl" -DCMAKE_TOOLCHAIN_FILE="$WBA_CMAKE_TOOLCHAIN" \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-O2 >/dev/null 2>&1 && ninja -C "$work/cm-$fl" >/dev/null 2>&1 &&
      out="$(cd "$work/cm-$fl" && ctest 2>&1)" && [[ "$out" == *'100% tests passed'* ]] ) \
    && ok "$fl: CMAKE_CXX_FLAGS override keeps the ABI; CMake sees 64-bit" || bad "$fl: CMAKE_CXX_FLAGS override"
  ( use_flavor $fl
    printf '#include <stdio.h>\nint main(void){puts(sizeof(void*)==8 ? "c ok" : "c wasm32");return 0;}\n' > "$work/c-$fl.c"
    $CC -O2 "$work/c-$fl.c" -o "$work/c-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null && [ "$(wasm-run "$work/c-$fl.js")" = "c ok" ] ) \
    && ok "$fl: C through the wrappers is 64-bit" || bad "$fl: C through the wrappers"
  ( use_flavor $fl
    $CC -O1 "$HOME_DIR/test/abi/lang.c" "$HOME_DIR/test/abi/langmain.c" -o "$work/lang-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null &&
      [ "$(wasm-run "$work/lang-$fl.js")" = "compiled as C" ] ) && ok "$fl: one-step C compile+link stays C" || bad "$fl: one-step C compile+link"
  ( use_flavor $fl
    $CC -O1 -c "$HOME_DIR/test/abi/cleanup_longjmp.c" -o "$work/cl-$fl.o" 2>/dev/null && $CC "$work/cl-$fl.o" -o "$work/cl-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null &&
      [ "$(wasm-run "$work/cl-$fl.js" | tail -1)" = "longjmp back" ] ) && ok "$fl: C cleanup + longjmp" || bad "$fl: C cleanup + longjmp"
  ( use_flavor $fl
    printf '#include <stdlib.h>\n#include <string.h>\nint main(void){char*p=malloc(200u<<20);if(!p)return 1;memset(p,1,200u<<20);return p[123]==1?0:2;}\n' > "$work/grow.c"
    $CC -O1 "$work/grow.c" -o "$work/grow-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null && wasm-run "$work/grow-$fl.js" ) \
    && ok "$fl: base link flags without LDFLAGS (memory grows)" || bad "$fl: base link flags"
  if [ $fl != mt ]; then
    ( use_flavor $fl
      printf '#include <stdio.h>\nint main(void){\n#ifdef __EMSCRIPTEN_PTHREADS__\nputs("threaded");\n#else\nputs("single");\n#endif\nreturn 0;}\n' > "$work/pt.c"
      $CC -pthread -O1 "$work/pt.c" -o "$work/pt-$fl.js" -pthread $WBA_NODE_TEST_LDFLAGS 2>/dev/null && [ "$(wasm-run "$work/pt-$fl.js")" = single ] ) \
      && ok "$fl: -pthread dropped" || bad "$fl: -pthread dropped"
  fi
  ( use_flavor $fl
    $CXX -O1 "$HOME_DIR/test/abi/tls_dtor.cc" -o "$work/tls-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null &&
      out="$(wasm-run "$work/tls-$fl.js" 2>&1)" && [[ "$out" != *RuntimeError* ]] &&
      if [ $fl = mt ]; then [[ "$out" == *"tls dtor 1"* ]]; else [[ "$out" == *"tls dtor 2"* ]]; fi ) \
    && ok "$fl: thread_local destructors" || bad "$fl: thread_local destructors"
  ( use_flavor $fl
    $CXX -O2 "$HOME_DIR/test/abi/atexit.cc" -o "$work/ae-$fl.js" $WBA_NODE_TEST_LDFLAGS 2>/dev/null &&
      [ "$(wasm-run "$work/ae-$fl.js" 2>&1)" = $'lifetime-extended\ndestructor ran' ] ) \
    && echo "PASS $fl: static reference destructor at exit (clang fixed it: update the known-issues list)" \
    || echo "KNOWN $fl: static reference destructor traps at exit (clang bug)"
done
finish "abi guards"
