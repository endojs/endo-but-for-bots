/* Audit probe: drive the xs-oracle shim directly (same C, same defines as build.rs). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
typedef struct {
	int8_t *code; uint32_t code_size; int8_t *symbols; uint32_t symbols_size;
	uint32_t computrons, meter_raw, ok; char result[16384]; char error[256];
	uint32_t result_len; int32_t exit_status; uint32_t heap_count, chunks_size;
	uint32_t has_async_signal; char async_signal[256];
} R;
int xs_oracle_run(const char *source, uint32_t len, R *out);
void xs_oracle_free(R *out);
int main(int argc, char **argv) {
	FILE *f = fopen(argv[1], "rb"); static char buf[1<<20]; size_t n = fread(buf, 1, sizeof buf, f); fclose(f);
	static R r; int rc = xs_oracle_run(buf, (uint32_t)n, &r);
	printf("rc=%d ok=%u exit_status=%d result=%.80s error=%.120s computrons=%u\n", rc, r.ok, r.exit_status, r.result, r.error, r.computrons);
	xs_oracle_free(&r);
	return 0;
}
