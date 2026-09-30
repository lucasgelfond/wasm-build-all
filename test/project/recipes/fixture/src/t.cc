#include <cstdio>
#include <cstring>
#include <atomic>
#include <thread>
#include <vector>
int main(int argc, char **argv) {
#if defined(MODE_basic)
  return 0;
#elif defined(MODE_file)
  if (argc < 2) return 2;
  FILE *f = std::fopen(argv[1], "rb"); if (!f) { std::perror(argv[1]); return 3; }
  char buf[64] = {}; std::fread(buf, 1, sizeof buf - 1, f); std::fclose(f);
  return std::strcmp(buf, "hello from a data file\n") == 0 ? 0 : 4;
#elif defined(MODE_threads)
# ifdef __EMSCRIPTEN_PTHREADS__
  std::atomic<int> n{0}; std::vector<std::thread> ts;
  for (int i = 0; i < 4; i++) ts.emplace_back([&] { n++; });
  for (auto &t : ts) t.join();
  return n == 4 ? 0 : 5;
# else
  return 0;
# endif
#elif defined(MODE_fail)
  return 1;
#elif defined(MODE_skip)
  return 77;
#endif
}
