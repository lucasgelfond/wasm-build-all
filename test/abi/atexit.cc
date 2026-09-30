// clang registers the destructor of a lifetime-extended static reference with __cxa_atexit without a thunk,
// which traps ("function signature mismatch") at exit on WebAssembly. bwasm-cc adds -fno-use-cxa-atexit.
#include <cstdio>
#include <string>
struct Noisy { std::string s; ~Noisy() { std::puts("destructor ran"); } };
int main() {
  static const Noisy &n = Noisy{"lifetime-extended"};
  std::printf("%s\n", n.s.c_str());
  return 0;
}
