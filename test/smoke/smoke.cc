// Toolchain smoke test: every ABI feature blender-wasm relies on, in one program.
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csetjmp>
#include <mutex>
#include <condition_variable>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <wasm_simd128.h>
#include <emmintrin.h>   // SSE2 emulated on SIMD128 (needs -msse2)
#include <emscripten.h>

static int failures = 0;
static void check(bool ok, const char *name) {
  std::printf("%s %s\n", ok ? "PASS" : "FAIL", name);
  if (!ok) failures++;
}

static std::jmp_buf jb;
static void jump_out() { std::longjmp(jb, 42); }
static void thrower(int v) { if (v > 0) throw std::runtime_error("boom " + std::to_string(v)); }
thread_local int tls_value = 0;

EM_ASYNC_JS(int, async_add, (int a, int b), {
  await new Promise(r => setTimeout(r, 5));
  return a + b;
});

int main() {
  check(sizeof(void *) == 8 && sizeof(size_t) == 8 && sizeof(long) == 8, "wasm64 pointer/size_t/long are 64-bit");

  // Beyond 4 GiB: grow the heap past 4 GiB in 1 GiB blocks (mimalloc caps single blocks below 4 GiB)
  // and check that addresses above 32 bits are usable.
  {
    char *blocks[5] = {};
    bool ok = true, high = false;
    for (int i = 0; i < 5 && ok; i++) {
      blocks[i] = static_cast<char *>(std::malloc(size_t(1) << 30));
      ok = blocks[i] != nullptr;
      if (ok) { blocks[i][0] = char(i); blocks[i][(size_t(1) << 30) - 1] = char(i + 1); high |= uintptr_t(blocks[i]) > 0xffffffffull; }
    }
    for (int i = 0; i < 5 && ok; i++) ok = blocks[i][(size_t(1) << 30) - 1] == char(i + 1);
    for (auto *b : blocks) std::free(b);
    check(ok && high, "heap beyond 4 GiB (5 x 1 GiB, addresses above 32 bits)");
  }

  try { thrower(3); check(false, "C++ exceptions"); }
  catch (const std::runtime_error &e) { check(std::strcmp(e.what(), "boom 3") == 0, "C++ exceptions"); }

  {
    std::exception_ptr ep;
    try { throw std::logic_error("x"); } catch (...) { ep = std::current_exception(); }
    bool ok = false;
    try { std::rethrow_exception(ep); } catch (const std::logic_error &) { ok = true; }
    check(ok, "exception_ptr rethrow");
  }

  {
    volatile int r = setjmp(jb);
    if (r == 0) jump_out();
    check(r == 42, "setjmp/longjmp");
  }

  {
    v128_t a = wasm_f32x4_make(1, 2, 3, 4), b = wasm_f32x4_splat(2);
    v128_t c = wasm_f32x4_mul(a, b);
    __m128 s = _mm_add_ps(_mm_set1_ps(1.5f), _mm_set1_ps(2.5f));
    check(wasm_f32x4_extract_lane(c, 3) == 8.0f && _mm_cvtss_f32(s) == 4.0f, "SIMD128 + SSE2 emulation");
  }

#ifndef WBA_ST
  {
    const int nthreads = 8;
    std::atomic<long> sum{0};
    std::mutex m; std::condition_variable cv; int ready = 0;
    std::vector<std::thread> ts;
    for (int t = 0; t < nthreads; t++) ts.emplace_back([&, t] {
      tls_value = t + 1;
      long local = 0;
      for (int i = 0; i < 100000; i++) local += i % 7;
      sum += local + tls_value - (t + 1);
      std::lock_guard<std::mutex> g(m); ready++; cv.notify_all();
    });
    { std::unique_lock<std::mutex> g(m); cv.wait(g, [&] { return ready == nthreads; }); }
    for (auto &t : ts) t.join();
    long expect = 0; for (int i = 0; i < 100000; i++) expect += i % 7;
    check(sum == expect * nthreads && tls_value == 0, "8 pthreads, atomics, mutex/condvar, thread_local");
  }
  {
    bool caught = false;
    std::thread t([&] { try { thrower(1); } catch (const std::exception &) { caught = true; } });
    t.join();
    check(caught, "exceptions on a worker thread");
  }
#endif

  check(async_add(40, 2) == 42, "await a JS promise from C (JSPI, or ASYNCIFY)");

  {
    const char *path = "bwasm-smoke.tmp";
    FILE *f = std::fopen(path, "wb"); bool ok = f != nullptr;
    if (ok) { std::fputs("hello", f); std::fclose(f); char buf[8] = {}; f = std::fopen(path, "rb"); ok = f && std::fread(buf, 1, 5, f) == 5 && !std::strcmp(buf, "hello"); if (f) std::fclose(f); std::remove(path); }
    check(ok, "file IO");
  }

  std::printf("%s: %d failure(s)\n", failures ? "FAILED" : "OK", failures);
  return failures ? 1 : 0;
}
