# Platform findings

Behaviour of this toolchain and the browsers that matters when porting code, found while porting and testing
dependencies. Each entry says where it was seen. Fixed items say how; open items are what Blender will hit.

## Fixed in the toolchain

- **`CMAKE_CXX_FLAGS` overrides dropped the ABI flags** and produced wasm32 objects. Every compile and link now
  goes through `bin/wba-cc` (CMake launcher, CC/CXX wrappers). Guarded by `test/abi`.
- **CMake thought everything was wasm32.** Emscripten's platform file sets `CMAKE_SIZEOF_VOID_P` (and
  `CMAKE_LIBRARY_ARCHITECTURE`) from whether `CMAKE_C_FLAGS` contains `-m64`, and our ABI flags come from the
  launcher, so every CMake project was configured with 4-byte pointers (code was still 64-bit). Projects that
  branch on it or write it into headers/package version files got it wrong (oneTBB's config would reject 64-bit
  consumers). `cmake/project-include.cmake` re-applies the 64-bit values after every `project()`
  (CMAKE_PROJECT_INCLUDE); the test/project fixture asserts it.
- **Destructors registered for exit/thread-exit can trap: a clang bug with two faces.** In the WebAssembly C++
  ABI destructors return `this`, so registering one directly as a `void(void*)` callback needs a thunk.
  Clang omits it in two places: (a) with the default `-fuse-cxa-atexit`, for a lifetime-extended static
  reference (`static const T& x = T();`), which traps at *program exit*; (b) with `-fno-use-cxa-atexit`, for
  `thread_local` objects registered through `__cxa_thread_atexit`, which trap at *every thread exit*.
  The toolchain briefly used `-fno-use-cxa-atexit` to avoid (a) and that caused (b) (oneTBB's worker threads,
  doctest). It now uses the default: (b) would hit Blender's worker threads in the browser, while (a) only
  hits programs that exit, which browser apps don't. Test suites that hit (a) patch the pattern (yaml-cpp
  0002). `test/abi` checks (b) passes and reports (a) as KNOWN until clang is fixed. To report to LLVM.
- **Build systems adding `-pthread` in single-threaded flavours** (meson's threads dependency) would mix
  threaded objects into st/asyncify; the wrappers drop it outside mt. The meson cross file sets
  `prefer_static` so static `.pc` files' `Requires.private` get linked (libbrotlidec -> libbrotlicommon).
- **Asyncify can't process wasm exception handling** (Binaryen's Flatten pass aborts), so the asyncify flavour
  compiles with JS-based exceptions and longjmp, and links C programs with em++ so the JS exception runtime is
  included (expat's test harness).
- **mimalloc won't return a single block of 4 GiB or more**; the heap still grows past 4 GiB in smaller blocks.
  Guarded by the smoke test.
- **node's stdout on a pipe with a slow reader fails with EAGAIN**; `bin/wasm-run` buffers through a temp file
  when stdout is a pipe.

- **File I/O from worker threads was ~19x slower in mt.** With Emscripten's JS filesystem every syscall from a
  pthread is proxied to the main thread. The mt flavour now ships WasmFS, which lives in shared memory and serves
  every thread directly (`test/fsbench/run.sh`, 200k-line write+read, in-memory filesystem):

  | | from main() | 4 threads |
  |---|---|---|
  | mt, JS filesystem | 1082 ms | 2007 ms |
  | mt, WasmFS | 84 ms | 127 ms |
  | st, JS filesystem / WasmFS | 62 / 103 ms | |
  | asyncify, JS filesystem / WasmFS | 110 / 202 ms | |
  | native (host disk) | 46 ms | 138 ms |

  Single-threaded, WasmFS is ~1.7x slower than the JS filesystem, so st and asyncify keep the JS filesystem.
- **WasmFS `getcwd()` dropped mount-point names** (`/Users/x` came back as `//x`): the memory backend names
  children only from its own entries, and mounts live in the directory cache. Patched in
  `patches/emscripten/0001-wasmfs-getcwd-names-mount-points.patch` (applied by `wasm-build-all setup`); to report upstream.
  Blender will mount OPFS directories, so this mattered beyond the tests.
- **WasmFS can't serve node test programs.** With NODERAWFS it starts in the wasm root and can't reach host
  paths; its node backend treats every file as positional (writes to a pipe fail with ESPIPE) and can't open
  stdin; its own stdout isn't binary-safe on node and its stdin reader uses `process.stdin`, which doesn't exist
  on a worker. So node test programs use the JS filesystem with NODERAWFS in every flavour, and the browser pass
  (relinked with the shipping filesystem) is what exercises WasmFS. `test/stdio` guards the node side.
- **A one-step `emcc a.c b.c -o x.js` in asyncify compiled C as C++** because the wrapper linked through em++ (which
  ignores `-x c`); the wrapper now compiles `.c` sources with emcc first. em++ is still needed for the link:
  C code with cleanups built with `-fexceptions` references libc++abi's `__resumeException`.
- **Link flags could be lost** when a project sets `CMAKE_EXE_LINKER_FLAGS`, and `$LDFLAGS` (which CMake appends
  after its own flags) overrode the node test flags. The wrappers now add the base link flags to every link and
  `$LDFLAGS` carries only the library path.
- **Browser harness:** with WasmFS the JS filesystem API calls into wasm, so test data is loaded in
  `onRuntimeInitialized` rather than `preRun`; output printed on a worker can arrive just after the exit
  notice, so the harness keeps collecting for 200 ms.

## Open: behaviour to design around

- **In mt, the main thread's `thread_local` destructors don't run at program exit** (main() runs on a proxied
  worker); other threads' do. Irrelevant for browser apps, which don't exit.

- **WebKit's worker stack is much smaller.** In the mt flavour `main()` runs on a worker (PROXY_TO_PTHREAD), and
  deeply recursive code dies with "Maximum call stack size exceeded" in WebKit only (yaml-cpp's CVE-2017-5950
  test, pugixml's test runners). st and asyncify pass. Blender's recursive code (depsgraph, RNA, Python) will need
  checking in WebKit's mt build.
- **Node benchmarks of file-heavy code under-state mt**: node test programs use the proxied JS filesystem (see
  above), so a file-heavy benchmark in mt measures proxying, not the shipping WasmFS. Benchmark those in the
  browser pass.
- **mimalloc refuses single allocations of 4 GiB or more** on wasm64 (dlmalloc allows them). zstd's `--max` test
  is skipped for it; Blender could hit it with very large single buffers.
- **WebKit, mt: intermittent "Invalid argument type in ToBigInt"** in a worker, reproduced with a 10-line pthread +
  nanosleep program on reused pool workers (zstd's zstreamtest and poolTests). Possibly a WebKit bug or an
  Emscripten wasm64 conversion; to reduce and report.
- **Emscripten filesystem differences** tests trip over: lseek on an inherited stdout is accepted but ignored on
  write; O_NONBLOCK is dropped on open (opening a FIFO blocks); a fixed umask of 022; mmap on a pipe returns
  ESPIPE (libdeflate's gzip patched to fall back to read()).
- **No hardware CRC32 or carry-less multiply** in wasm: checksums are the main cost in gzip decompression
  (libdeflate 732 vs 2010 MB/s native; raw deflate is ~1.3x).
- **Asyncify costs up to 10x** on call-heavy code (yaml-cpp, fmt). It is a fallback for engines without JSPI.
- **No FMA contraction.** wasm has no fused multiply-add, so results that native computes with FMA differ in the
  last bit; compare against a native build with `-ffp-contract=off` (Imath).
- **libm differs from Apple's in the last ULP** for transcendental functions (Imath's Euler/quaternion/solveCubic
  paths); tests need tolerances, not bit-exactness.
- **`long double` is IEEE binary128**, as on Linux aarch64, and formats with full quad precision (fmt).
- **`std::hash<std::string>` differs from Apple's libc++**, so anything that persists std::hash values across
  platforms breaks (robin-map interop).
- **No locale data**: the libc accepts any locale name but behaves as "C" (fmt's locale tests).
- **Eigen has no wasm SIMD path**: with these flags it runs scalar.
