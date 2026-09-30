// Copies stdin to stdout byte for byte (like cat), or with "gen N" writes N bytes of 0..255 without ever
// opening a file (zstd's datagen case: no filesystem use except stdio).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc > 2 && !strcmp(argv[1], "gen")) {
    long n = atol(argv[2]);
    for (long i = 0; i < n; i++) putchar((int)(i & 255));
    return 0;
  }
  char buf[65536]; size_t r;
  while ((r = fread(buf, 1, sizeof buf, stdin)) > 0) fwrite(buf, 1, r, stdout);
  return ferror(stdin) || ferror(stdout);
}
