/* Deliberate faults used only by test-oracle-sanitizer-scope.sh. */
#include <limits.h>
#include <stdlib.h>

int main(void) {
#ifdef PROBE_ADDRESS
  volatile char *bytes = malloc(1);
  if (!bytes)
    return 2;
  bytes[1] = 0;
  free((void *)bytes);
#else
  volatile int value = INT_MAX;
  value += 1;
#endif
  return 0;
}
