/* Audit probe: xs_oracle_regexp keeps fxCompileRegExp's `code`/`data` chunks in
 * unrooted C locals; a code chunk that does not fit triggers a compacting GC. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
typedef struct {
	uint32_t ok, matched, capture_count, name_count; int32_t captures[128];
	uint64_t cc, cr, mc, mr; char error[256];
} RR;
int xs_oracle_regexp(const char *p, const char *m, const char *s, uint32_t sl, int32_t start, RR *out);
int main(int argc, char **argv) {
	int lo = atoi(argv[1]), hi = atoi(argv[2]), step = atoi(argv[3]);
	for (int n = lo; n <= hi; n += step) {
		size_t len = 3 + 6 * (size_t)n + 1;
		char *p = malloc(len); strcpy(p, "(a)");
		for (int i = 0; i < n; i++) strcat(p, "(?:b?)");
		RR r; memset(&r, 0, sizeof r);
		int rc = xs_oracle_regexp(p, "", "a", 1, 0, &r);
		int good = rc == 0 && r.ok && r.matched && r.capture_count == 2 && r.captures[0] == 0 && r.captures[1] == 1 && r.captures[2] == 0 && r.captures[3] == 1;
		if (!good || n % (step * 20) == lo % (step*20))
			printf("n=%d patlen=%zu rc=%d ok=%u matched=%u ncap=%u cap0=(%d,%d) cap1=(%d,%d) %s err=%s\n", n, strlen(p), rc, r.ok, r.matched, r.capture_count, r.captures[0], r.captures[1], r.captures[2], r.captures[3], good ? "OK" : "BAD", r.error);
		fflush(stdout);
		free(p);
	}
	return 0;
}
