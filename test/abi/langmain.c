#include <stdio.h>
int is_cxx(void);
int main(void){printf("compiled as %s\n", is_cxx() ? "C++" : "C");return 0;}
