#include <stdio.h>
#include <setjmp.h>
static jmp_buf jb;
static void done(int *p) { printf("cleanup %d\n", *p); }
static void (*volatile fp)(int);
static void thrower(int x) { if (x) longjmp(jb, 1); }
static void inner(void) { int v __attribute__((cleanup(done))) = 7; fp(v); }
int main(void) { fp = thrower; if (!setjmp(jb)) inner(); else puts("longjmp back"); return 0; }
