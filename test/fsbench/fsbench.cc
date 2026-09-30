// Filesystem microbenchmark: many small writes and reads through stdio, from main() (a worker in mt) and from
// 4 extra threads at once. Prints milliseconds per phase. Used to choose between the JS filesystem and WasmFS.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>
static double ms_since(std::chrono::steady_clock::time_point t) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
}
static long work(const std::string &path, int lines) {
  FILE *f = std::fopen(path.c_str(), "w");
  if (!f) { std::perror(path.c_str()); return -1; }
  for (int i = 0; i < lines; i++) std::fprintf(f, "line %d of some text %f\n", i, i * 0.5);
  std::fclose(f);
  f = std::fopen(path.c_str(), "r");
  char buf[128]; long n = 0;
  while (std::fgets(buf, sizeof buf, f)) n += std::strlen(buf);
  std::fclose(f); std::remove(path.c_str());
  return n;
}
int main(int argc, char **argv) {
  const char *dir = argc > 1 ? argv[1] : ".";
  const int lines = 200000;
  auto t = std::chrono::steady_clock::now();
  long n = work(std::string(dir) + "/fsbench-main.txt", lines);
  std::printf("main thread: %.0f ms (%ld bytes)\n", ms_since(t), n);
#ifdef __EMSCRIPTEN_PTHREADS__
  t = std::chrono::steady_clock::now();
  std::vector<std::thread> ts; long tot[4] = {};
  for (int i = 0; i < 4; i++) ts.emplace_back([&, i] { tot[i] = work(std::string(dir) + "/fsbench-" + std::to_string(i) + ".txt", lines); });
  for (auto &th : ts) th.join();
  std::printf("4 threads:   %.0f ms\n", ms_since(t));
#endif
  return n > 0 ? 0 : 1;
}
