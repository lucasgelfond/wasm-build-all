// A thread_local object with a destructor, on a worker thread and on the main thread. With
// -fno-use-cxa-atexit clang registers the destructor via __cxa_thread_atexit without the wasm signature thunk
// (oneTBB's governor, doctest), which traps at thread exit.
#include <cstdio>
#include <thread>
struct Tls { int v = 0; ~Tls() { std::printf("tls dtor %d\n", v); } };
thread_local Tls tls;
int main() {
#ifdef __EMSCRIPTEN_PTHREADS__
  std::thread t([] { tls.v = 1; });
  t.join();
#endif
  tls.v = 2;
  std::puts("main done");
  return 0;
}
