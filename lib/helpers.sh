# Helpers available to a recipe's build.sh (its build() and test() hooks). Sourced by lib/run-recipe.sh after the
# flavour's environment (wasm-build-all env) and the recipe's variables are set:
#   NAME VERSION RECIPE (the recipe directory) SRC BUILD STAGE PREFIX NATIVE JOBS, and CACHE (download cache
#   for extra test data)
# Building
#   wba_cmake [-S dir] [cmake args...]     configure + build + install (into $STAGE) with the wasm-build-all toolchain
#   wba_configure [configure args...]      autotools configure + make + make install (into $STAGE)
#   wba_meson [-S dir] [meson args...]     meson setup + compile + install (into $STAGE) with the flavour's cross file
#   Tidy installed files under $PREFIX (the staged install prefix), never in the sysroot directly.
# Testing (results land in $RECIPE/results/wasm64-$WBA_FLAVOR.json)
#   wba_ctest SUITE [ctest args...]        run ctest in $BUILD (programs run under node via wasm-run)
#   wba_check NAME cmd... / wba_checks_done SUITE    custom checks recorded as one suite
#   wba_result SUITE PASS FAIL SKIP [NOTE] record counts directly (benchmarks: SUITE bench-*, ratio in NOTE)
#   wba_browser_ctest SUITE [opts]         relink $BUILD's test programs for the web, run the ctest list in
#                                          Chromium/Firefox/WebKit (SUITE-<browser>); WBA_BROWSER_TESTS=0 skips
#   wba_browser_tests SUITE FILE.json      same for suites not driven by ctest: [{"name","command":[...],"cwd"}]
#   wba_native_cmake [-S dir] [args...]    build the same source natively into $NATIVE (baseline)
#   wba_ctest_native SUITE [ctest args...] run ctest in $NATIVE, recorded as SUITE-native
#   wba_native_env cmd...                  run a command without the Emscripten environment
#   wba_shim NAME prog.js                  prints a dir holding an executable NAME that runs the wasm program;
#                                          put it first on PATH so upstream shell test drivers use the wasm build
#   wrun prog.js args...                   run a wasm program under node
set -euo pipefail

log() { printf '\033[1m[%s %s/%s]\033[0m %s\n' "$NAME" "$VERSION" "$WBA_FLAVOR" "$*"; }
wrun() { "$WBA_HOME/bin/wasm-run" "$@"; }
export -f wrun 2>/dev/null || true

_wba_fail_log() { local f="$1" what="$2"; grep -E -m20 'error' "$f" 2>/dev/null || true; tail -30 "$f"; echo "$NAME: $what failed ($f)" >&2; exit 1; }

wba_cmake() {
  local srcdir="$SRC"
  if [ "${1:-}" = "-S" ]; then srcdir="$2"; shift 2; fi
  log "cmake configure"
  cmake -G Ninja -S "$srcdir" -B "$BUILD" -DCMAKE_TOOLCHAIN_FILE="$WBA_CMAKE_TOOLCHAIN" -DWBA_FLAVOR="$WBA_FLAVOR" \
    -DWBA_SYSROOT="$WBA_SYSROOT" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WBA_SYSROOT" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@" > "$BUILD/configure.log" 2>&1 || _wba_fail_log "$BUILD/configure.log" configure
  log "build"
  cmake --build "$BUILD" -j "$JOBS" > "$BUILD/build.log" 2>&1 || _wba_fail_log "$BUILD/build.log" build
  log "install"
  rm -rf "$STAGE"
  DESTDIR="$STAGE" cmake --install "$BUILD" > "$BUILD/install.log" 2>&1 || _wba_fail_log "$BUILD/install.log" install
}

wba_configure() {
  log "configure"
  (cd "$BUILD" && emconfigure "$SRC/configure" --host=wasm32-unknown-emscripten --prefix="$WBA_SYSROOT" \
    --disable-shared --enable-static "$@" > configure.log 2>&1) || _wba_fail_log "$BUILD/configure.log" configure
  log "build"
  (cd "$BUILD" && emmake make -j "$JOBS" > build.log 2>&1) || _wba_fail_log "$BUILD/build.log" build
  log "install"
  rm -rf "$STAGE"
  (cd "$BUILD" && emmake make install DESTDIR="$STAGE" > install.log 2>&1) || _wba_fail_log "$BUILD/install.log" install
}

wba_meson() {
  local srcdir="$SRC"
  if [ "${1:-}" = "-S" ]; then srcdir="$2"; shift 2; fi
  log "meson setup"
  meson setup "$BUILD" "$srcdir" --cross-file "$WBA_MESON_CROSS" --buildtype=release --prefix="$WBA_SYSROOT" \
    --libdir=lib "$@" > "$BUILD.meson-setup.log" 2>&1 || _wba_fail_log "$BUILD.meson-setup.log" "meson setup"
  log "build"
  meson compile -C "$BUILD" -j "$JOBS" > "$BUILD/build.log" 2>&1 || _wba_fail_log "$BUILD/build.log" build
  log "install"
  rm -rf "$STAGE"
  DESTDIR="$STAGE" meson install -C "$BUILD" > "$BUILD/install.log" 2>&1 || _wba_fail_log "$BUILD/install.log" install
}

wba_result() {
  local suite="$1" pass="$2" fail="$3" skip="$4" note="${5:-}"
  "$WBA_NODE" "$WBA_HOME/lib/record-result.mjs" "$RECIPE/results/wasm64-$WBA_FLAVOR.json" \
    "$NAME" "$VERSION" "$suite" "$pass" "$fail" "$skip" "$note"
  log "test $suite: $pass passed, $fail failed, $skip skipped${note:+ ($note)}"
}

_wba_ctest_in() {
  local dir="$1" suite="$2"; shift 2
  local logf="$dir/ctest-$suite.log" total failed skip pass
  log "ctest $suite"
  (cd "$dir" && ctest --output-on-failure -j "$JOBS" --timeout "${CTEST_TIMEOUT:-600}" "$@" > "$logf" 2>&1) || true
  # ctest prints "N% tests passed, F tests failed out of T", or "100% tests passed out of T" when all pass.
  # Skipped (SKIP_RETURN_CODE) and disabled tests are listed as "did not run", not counted as failed.
  total="$(grep -Eo 'tests (passed|failed) out of [0-9]+' "$logf" | grep -Eo '[0-9]+$' | tail -1 || true)"; total="${total:-0}"
  failed="$(grep -Eo '[0-9]+ tests failed out of' "$logf" | grep -Eo '^[0-9]+' | tail -1 || true)"; failed="${failed:-0}"
  skip="$(grep -Ec '\*\*\*Skipped|Disabled' "$logf" || true)"
  pass=$((total - failed - skip))
  [ "$total" -gt 0 ] || { tail -20 "$logf"; echo "no tests ran for $suite" >&2; return 1; }
  grep -E 'Not Run|\(Failed\)|\(Subprocess aborted\)|\(Timeout\)|\(SEGFAULT\)' "$logf" | head -20 || true
  wba_result "$suite" "$pass" "$failed" "$skip"
}
wba_ctest() { _wba_ctest_in "$BUILD" "$@"; }
wba_ctest_native() { local suite="$1"; shift; _wba_ctest_in "$NATIVE" "$suite-native" "$@"; }

_wba_cp=0; _wba_cf=0; _wba_failed=""
wba_check() {
  local name="$1"; shift
  if ( "$@" ) > "$BUILD/check.log" 2>&1; then _wba_cp=$((_wba_cp+1)); printf '  PASS %s\n' "$name"
  else _wba_cf=$((_wba_cf+1)); _wba_failed="$_wba_failed $name"; printf '  FAIL %s\n' "$name"; tail -5 "$BUILD/check.log" | sed 's/^/       /'; fi
}
wba_checks_done() { wba_result "$1" "$_wba_cp" "$_wba_cf" 0 "${_wba_failed:+failed:$_wba_failed}"; _wba_cp=0; _wba_cf=0; _wba_failed=""; }

wba_native_env() {
  env -u CC -u CXX -u CFLAGS -u CXXFLAGS -u LDFLAGS -u PKG_CONFIG_LIBDIR -u EMSDK -u EM_CONFIG \
    PATH="$(echo "$PATH" | tr ':' '\n' | grep -v -i -e emsdk -e "$WBA_HOME/bin" | paste -sd: -)" "$@"
}
wba_native_cmake() {
  local srcdir="$SRC"
  if [ "${1:-}" = "-S" ]; then srcdir="$2"; shift 2; fi
  mkdir -p "$NATIVE"
  log "native build (baseline)"
  wba_native_env cmake -G Ninja -S "$srcdir" -B "$NATIVE" -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 "$@" \
    > "$NATIVE/configure.log" 2>&1 || _wba_fail_log "$NATIVE/configure.log" "native configure"
  wba_native_env cmake --build "$NATIVE" -j "$JOBS" > "$NATIVE/build.log" 2>&1 || _wba_fail_log "$NATIVE/build.log" "native build"
}

_wba_browser() {
  [ "${WBA_BROWSER_TESTS:-1}" = 1 ] || { log "browser pass skipped (WBA_BROWSER_TESTS=0)"; return 0; }
  "$WBA_HOME/lib/relink-web.sh" "$BUILD"
  "$WBA_NODE" "$WBA_HOME/lib/browser-ctest.mjs" --build "$BUILD" --results "$RECIPE/results/wasm64-$WBA_FLAVOR.json" \
    --dep "$NAME" --version "$VERSION" "$@"
}
wba_browser_ctest() { local suite="$1"; shift; _wba_browser --suite "$suite" "$@"; }
wba_browser_tests() { local suite="$1" list="$2"; shift 2; _wba_browser --suite "$suite" --tests "$list" "$@"; }

wba_shim() {
  local name="$1" prog="$2" dir="$BUILD/shims"
  mkdir -p "$dir"
  printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$WBA_HOME/bin/wasm-run" "$prog" > "$dir/$name"
  chmod +x "$dir/$name"; echo "$dir"
}
