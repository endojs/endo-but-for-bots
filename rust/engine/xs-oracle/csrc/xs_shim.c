/*
 * xs-oracle shim.
 *
 * Compiled alongside the XS sources (the c/moddable submodule pin
 * the endor daemon builds today), with the same feature defines as
 * the xsnap crate, so it can use the internal xsAll.h API directly
 * the way fx_eval() in xsGlobal.c does.
 *
 * It gives the differential harness two things the public xsnap
 * Machine API does not expose:
 *
 *   1. the exact XS bytecode the XS compiler emits for a program
 *      (so the Rust interpreter can execute the identical byte
 *      stream during stages 1 through 4, before the Rust compiler
 *      lands in stage 5), and
 *
 *   2. a run-only computron count: metering is reset to zero after
 *      parse and read after run, so parse metering
 *      (XS_PARSE_CODE_METERING) does not contaminate the interpreter
 *      parity number (design, "Stages 1 through 4 keep the oracle
 *      compiler in the loop ... a computron divergence always has
 *      exactly one suspect").
 *
 * This is the only crate in rust/engine that touches unsafe / FFI;
 * it is dev-and-CI only and never linked into a shipped engine.
 */

#include "xsAll.h"
#include <stdlib.h>
#include <string.h>

#define ENDOR_RESULT_MAX 1024
#define ENDOR_ERROR_MAX 256

typedef struct {
	txS1 *code;   /* malloc'd copy of the program bytecode; caller frees */
	txU4 code_size;
	txS1 *symbols; /* malloc'd copy of the symbols atom; caller frees */
	txU4 symbols_size;
	txU4 computrons; /* meterIndex >> 16 over the run only */
	txU4 meter_raw; /* raw meterIndex over the run only (diagnostic) */
	txU4 ok;         /* 1 = completed normally, 0 = threw / parse error */
	char result[ENDOR_RESULT_MAX]; /* completion value coerced to String() */
	char error[ENDOR_ERROR_MAX];   /* message when ok == 0 */
} EndorOracleResult;

static int gEndorClusterReady = 0;

static void fx_endor_detachArrayBuffer(txMachine *the)
{
	txSlot *slot = mxArgv(0);
	if (slot->kind == XS_REFERENCE_KIND) {
		txSlot *instance = slot->value.reference;
		if (((slot = instance->next)) && (slot->flag & XS_INTERNAL_FLAG) &&
			(slot->kind == XS_ARRAY_BUFFER_KIND) &&
			(instance != mxArrayBufferPrototype.value.reference)) {
			txSlot *bufferInfo = slot->next;
			if (bufferInfo && (bufferInfo->flag & XS_INTERNAL_FLAG) &&
				(bufferInfo->kind == XS_BUFFER_INFO_KIND)) {
				slot->value.arrayBuffer.address = C_NULL;
				slot->value.arrayBuffer.detachKey = C_NULL;
				bufferInfo->value.bufferInfo.length = 0;
				if (bufferInfo->value.bufferInfo.maxLength > 0)
					bufferInfo->value.bufferInfo.maxLength = 0;
				return;
			}
		}
	}
	mxTypeError("this is no ArrayBuffer instance");
}

/* Mirrors DEFAULT_CREATION in rust/endo/xsnap/src/lib.rs. */
static txCreation gEndorCreation = {
	128 * 1024, /* initialChunkSize */
	64 * 1024,  /* incrementalChunkSize */
	8192,       /* initialHeapCount */
	4096,       /* incrementalHeapCount */
	4096,       /* stackCount */
	2048,       /* initialKeyCount */
	512,        /* incrementalKeyCount */
	127,        /* nameModulo */
	127,        /* symbolModulo */
	8192 * 1024,/* parserBufferSize */
	1993,       /* parserTableModulo */
	0,          /* staticSize */
	0,          /* nativeStackSize */
};

/*
 * Run `source` as a program eval on a fresh machine.
 * Returns 0 on success (machine created and result populated),
 * negative on a machine-level failure.  A thrown JS exception or a
 * syntax error is a normal outcome reported through out->ok == 0.
 */
int xs_oracle_run(const char *source, txU4 sourceLen, EndorOracleResult *out)
{
	txMachine *the;
	memset(out, 0, sizeof(*out));

	if (!gEndorClusterReady) {
		fxInitializeSharedCluster(C_NULL);
		gEndorClusterReady = 1;
	}

	the = fxCreateMachine(&gEndorCreation, "xs-oracle", C_NULL, 0);
	if (!the)
		return -1;

	the = fxBeginHost(the);
	{
		mxTry(the) {
			txStringCStream stream;
			txScript *script;
			txSlot *module;
			txSlot *realm;
			txSlot *result;

			/* Install the Hardened-JavaScript globals the embedder (xst.c /
			 * xstFuzz.c) installs, but the bare fxCreateMachine boot does not:
			 * harden/lockdown/petrify/mutabilities. Without this an `harden(x)`
			 * program is an undefined-reference throw. Mirrors xst.c's
			 * fxNextHostFunctionProperty install on the realm global; the ids
			 * intern to the same atoms the program's references use. This is the
			 * minimal audited extension of the oracle FFI seam the stage-4b
			 * lockdown/harden child needs to differential-run against the pin.
			 *
			 * The global MUST be pushed onto the stack first, exactly as xst.c
			 * does (`mxPush(mxGlobal); global = the->stack;`). fxNextHostFunctionProperty
			 * reads the new host function's HOME object from `the->stack` at
			 * entry — it stamps `home.object = the->stack->value.reference`. If
			 * the global is not the stack top, each installed function gets a
			 * garbage home.object pointing at whatever stale frame slot happened
			 * to sit on the stack. That pointer is then dereferenced by the GC's
			 * XS_HOME_KIND marker (`fxMarkInstance` on home.object) on the next
			 * collection, and read by the Function.prototype.toString / property
			 * enumeration path — a use-after/into-garbage that SIGSEGVs the whole
			 * oracle process under any allocation pressure (the intrinsic-graph
			 * walk, typed-array construction, Array concat/sort). Pushing the
			 * global fixes the home linkage for all four installs at once. */
			{
				txSlot *slot;
				mxPush(mxGlobal);
				slot = fxLastProperty(the, fxToInstance(the, the->stack));
				slot = fxNextHostFunctionProperty(the, slot, fx_harden, 1,
					fxID(the, "harden"), XS_DONT_ENUM_FLAG);
				slot = fxNextHostFunctionProperty(the, slot, fx_lockdown, 0,
					fxID(the, "lockdown"), XS_DONT_ENUM_FLAG);
				slot = fxNextHostFunctionProperty(the, slot, fx_petrify, 1,
					fxID(the, "petrify"), XS_DONT_ENUM_FLAG);
				slot = fxNextHostFunctionProperty(the, slot, fx_mutabilities, 1,
					fxID(the, "mutabilities"), XS_DONT_ENUM_FLAG);
				mxPop();
			}

			/* Install the test262 host hook used by detachArrayBuffer.js. */
			{
				txSlot *slot;
				txSlot *global;
				txSlot *host;
				mxPush(mxGlobal);
				global = the->stack;
				mxPush(mxObjectPrototype);
				slot = fxLastProperty(the, fxNewObjectInstance(the));
				slot = fxNextHostFunctionProperty(the, slot,
					fx_endor_detachArrayBuffer, 1,
					fxID(the, "detachArrayBuffer"), XS_DONT_ENUM_FLAG);
				host = the->stack;
				slot = fxLastProperty(the, fxToInstance(the, global));
				(void)fxNextSlotProperty(the, slot, host,
					fxID(the, "$262"), XS_DONT_ENUM_FLAG);
				mxPop();
				mxPop();
			}

			stream.buffer = (txString)source;
			stream.offset = 0;
			stream.size = (txSize)sourceLen;

			/* Compile (parse+code). Parse metering is discarded below. */
			script = fxParseScript(the, &stream, fxStringCGetter,
				mxProgramFlag | mxEvalFlag);

			/* Capture the emitted bytecode before running. */
			out->code_size = (txU4)script->codeSize;
			if (script->codeSize > 0) {
				out->code = (txS1 *)malloc(script->codeSize);
				if (out->code)
					memcpy(out->code, script->codeBuffer, script->codeSize);
			}
			if (script->symbolsBuffer && script->symbolsSize > 0) {
				out->symbols_size = (txU4)script->symbolsSize;
				out->symbols = (txS1 *)malloc(script->symbolsSize);
				if (out->symbols)
					memcpy(out->symbols, script->symbolsBuffer, script->symbolsSize);
			}

			/* The initial program instance carries the realm. */
			module = mxProgram.value.reference;
			realm = mxModuleInstanceInternal(module)->value.module.realm;

			/* Measure the run only. */
			the->meterIndex = 0;
			fxRunScript(the, script, mxRealmGlobal(realm), C_NULL,
				mxRealmClosures(realm)->value.reference, C_NULL, module);
			/* Pump-loop latch: drain the promise job queue with metering
			 * still accumulating, modeling the host-driven microtask drain
			 * the ironhorse embedding performs after a crank (design § promises,
			 * the pump-loop latch). fxRunScript queues promise jobs — setting
			 * the->promiseJobs via the xsnap-platform fxQueuePromiseJobs —
			 * but does not run them; the metered computron count must include
			 * the reactions, since a crank's cost (message delivery plus its
			 * microtask drain) is the consensus-relevant unit. We drain via
			 * fxRunPromiseJobs (not fxRunLoop) so no timer jobs run and no
			 * exit-time unhandled-rejection check aborts a completed run. The
			 * queue-neutral fxRunPromiseJobs leaves the script's completion
			 * value at the stack top, captured below. A program that queues
			 * no jobs leaves the->promiseJobs clear, so this is a no-op and
			 * the non-promise corpora measure identically. */
			while (the->promiseJobs) {
				the->promiseJobs = 0;
				fxRunPromiseJobs(the);
			}
			out->computrons = the->meterIndex >> 16;
			out->meter_raw = (txU4)the->meterIndex;

			/* fxRunScript leaves the completion value on the stack top. */
			result = the->stack;
			fxToString(the, result);
			{
				txString s = result->value.string;
				if (s) {
					strncpy(out->result, s, ENDOR_RESULT_MAX - 1);
					out->result[ENDOR_RESULT_MAX - 1] = 0;
				}
			}
			mxPop();
			out->ok = 1;
		}
		mxCatch(the) {
			out->ok = 0;
			/* Record the run-only computron count reached at the point of
			 * an uncaught throw, exactly as the normal-completion path
			 * does. meterIndex was reset to 0 immediately before
			 * fxRunScript (above) and the longjmp out of the run
			 * preserves it, so this is the run-phase count when the throw
			 * originated in execution. (A parse-phase failure — before the
			 * reset — leaves a parse-metering value here, but such a run
			 * yields empty/undecodable bytecode on the ironhorse side and so
			 * is never a bit-exact BothAbort regardless.) This is what lets
			 * the dual-run harness compare computrons on the abort path,
			 * not only the completion path (stage-2a review observation 3). */
			out->computrons = the->meterIndex >> 16;
			out->meter_raw = (txU4)the->meterIndex;
			/* mxException holds the thrown value; stringify best-effort. */
			if (mxException.kind != XS_UNDEFINED_KIND) {
				mxPush(mxException);
				fxToString(the, the->stack);
				if (the->stack->value.string) {
					strncpy(out->error, the->stack->value.string, ENDOR_ERROR_MAX - 1);
					out->error[ENDOR_ERROR_MAX - 1] = 0;
				}
				mxPop();
			}
		}
	}
	fxEndHost(the);
	fxDeleteMachine(the);
	return 0;
}

void xs_oracle_free(EndorOracleResult *out)
{
	if (out->code) {
		free(out->code);
		out->code = C_NULL;
	}
	if (out->symbols) {
		free(out->symbols);
		out->symbols = C_NULL;
	}
}

/*
 * Compile `source` as a MODULE goal and return the emitted bytecode
 * WITHOUT running it (stage-5 modules child, PR #600).
 *
 * The differential harness reaches the XS compiler through
 * xs_oracle_run, but that entry compiles only the SCRIPT goal
 * (fxParseScript with mxProgramFlag | mxEvalFlag), where a top-level
 * import/export is a SyntaxError — so module output was untestable. A
 * module also cannot fxRunScript without a linker (the MODULE opcode
 * needs a module record + realm the bare-boot machine has not built),
 * so this entry parses-and-codes ONLY and hands back script->codeBuffer.
 *
 * The goal split is the whole point: we pass fxParseScript neither
 * mxProgramFlag nor mxJSONModuleFlag, so fxParserTree takes its module
 * branch (fxModule, adding mxStrictFlag | mxAsyncFlag), exactly the goal
 * the ironhorse Rust `compile_module` targets. This does NOT touch the
 * script path: xs_oracle_run is unchanged, so the existing
 * byte-identity script corpus is a locked regression (a dedicated test
 * asserts the script entry's output is unperturbed by this addition).
 *
 * Contract mirrors xs_oracle_run's capture half: out->ok == 1 with
 * code/symbols populated on a clean parse+code; out->ok == 0 with a
 * best-effort message on a SyntaxError (or an empty codeBuffer, which
 * the harness reads as a rejection). No metering, no completion value —
 * nothing runs.
 */
int xs_oracle_compile_module(const char *source, txU4 sourceLen, EndorOracleResult *out)
{
	txMachine *the;
	memset(out, 0, sizeof(*out));

	if (!gEndorClusterReady) {
		fxInitializeSharedCluster(C_NULL);
		gEndorClusterReady = 1;
	}

	the = fxCreateMachine(&gEndorCreation, "xs-oracle-module", C_NULL, 0);
	if (!the)
		return -1;

	the = fxBeginHost(the);
	{
		mxTry(the) {
			txStringCStream stream;
			txScript *script;

			stream.buffer = (txString)source;
			stream.offset = 0;
			stream.size = (txSize)sourceLen;

			/* Module goal: no mxProgramFlag and no mxJSONModuleFlag, so
			 * fxParserTree parses as a Module (fxModule) rather than a
			 * Script. Compile only; never run. */
			script = fxParseScript(the, &stream, fxStringCGetter, 0);

			if (script && script->codeSize > 0) {
				out->code_size = (txU4)script->codeSize;
				out->code = (txS1 *)malloc(script->codeSize);
				if (out->code)
					memcpy(out->code, script->codeBuffer, script->codeSize);
				if (script->symbolsBuffer && script->symbolsSize > 0) {
					out->symbols_size = (txU4)script->symbolsSize;
					out->symbols = (txS1 *)malloc(script->symbolsSize);
					if (out->symbols)
						memcpy(out->symbols, script->symbolsBuffer,
							script->symbolsSize);
				}
				out->ok = 1;
			}
			else {
				/* A parse error yields a NULL/empty script (fxParserCode
				 * returns C_NULL when errorCount is nonzero and there is no
				 * console). Report a rejection, not a machine failure. */
				out->ok = 0;
				strncpy(out->error, "SyntaxError: module parse failed",
					ENDOR_ERROR_MAX - 1);
				out->error[ENDOR_ERROR_MAX - 1] = 0;
			}
		}
		mxCatch(the) {
			out->ok = 0;
			if (mxException.kind != XS_UNDEFINED_KIND) {
				mxPush(mxException);
				fxToString(the, the->stack);
				if (the->stack->value.string) {
					strncpy(out->error, the->stack->value.string,
						ENDOR_ERROR_MAX - 1);
					out->error[ENDOR_ERROR_MAX - 1] = 0;
				}
				mxPop();
			}
		}
	}
	fxEndHost(the);
	fxDeleteMachine(the);
	return 0;
}

/*
 * XSRE matcher oracle (stage-3b child 8, PR #600).
 *
 * The XSRE regexp engine (xsre.c) is engine-internal: it has no
 * public Machine API, so the differential harness cannot reach it
 * through xs_oracle_run. This shim calls fxCompileRegExp +
 * fxMatchRegExp directly (exactly as xsRegExp.c does) and returns the
 * matcher's own reference behavior:
 *
 *   1. matched / not-matched,
 *   2. the raw capture byte-offset pairs the matcher writes into
 *      `data` (data[2*i] = capture i from, data[2*i+1] = capture i to,
 *      -1 for an unset capture) in the subject's UTF-8/CESU-8 byte
 *      space — the same offset space the Rust port operates in, so the
 *      two compare directly with no UTF-16 conversion layer (that is
 *      child 9's JS-surface concern), and
 *   3. two run-only computron counts: the compile meter
 *      (XS_PARSE_REGEXP_METERING * pattern size) and the match meter
 *      (XS_REGEXP_METERING per step dispatched), each measured over a
 *      zeroed meterIndex so the Rust matcher's per-step metering has an
 *      isolated reference.
 *
 * `the` is non-null so both the meter increments fire and code/data
 * allocate as GC chunks; no allocation happens between compile and
 * match, so the chunk pointers stay valid across the call.
 */

#define ENDOR_MAX_CAPTURES 64

typedef struct {
	txU4 ok;          /* 1 = compiled; 0 = pattern compile error */
	txU4 matched;     /* 1 = matched at/after start; 0 = no match */
	txU4 capture_count; /* code[1]: total captures incl. whole match (index 0) */
	txU4 name_count;    /* code[2] */
	txS4 captures[2 * ENDOR_MAX_CAPTURES]; /* from,to pairs, byte offsets, -1 unset */
	txU4 compile_computrons; /* compile meter >> 16 */
	txU4 compile_meter_raw;
	txU4 match_computrons;   /* match meter >> 16 */
	txU4 match_meter_raw;
	char error[ENDOR_ERROR_MAX]; /* compile error message when ok == 0 */
} EndorRegExpResult;

int xs_oracle_regexp(const char *pattern, const char *modifier,
	const char *subject, txU4 subjectLen, txS4 start, EndorRegExpResult *out)
{
	txMachine *the;
	memset(out, 0, sizeof(*out));

	if (!gEndorClusterReady) {
		fxInitializeSharedCluster(C_NULL);
		gEndorClusterReady = 1;
	}

	the = fxCreateMachine(&gEndorCreation, "xs-oracle-regexp", C_NULL, 0);
	if (!the)
		return -1;

	the = fxBeginHost(the);
	{
		mxTry(the) {
			txInteger *code = C_NULL;
			txInteger *data = C_NULL;
			char errorBuffer[ENDOR_ERROR_MAX];
			txInteger before;
			txInteger i, captureCount;

			errorBuffer[0] = 0;
			the->meterIndex = 0;
			if (!fxCompileRegExp(the, (txString)pattern, (txString)modifier,
					&code, &data, errorBuffer, sizeof(errorBuffer))) {
				out->ok = 0;
				strncpy(out->error, errorBuffer, ENDOR_ERROR_MAX - 1);
				out->error[ENDOR_ERROR_MAX - 1] = 0;
			}
			else {
				out->ok = 1;
				out->compile_meter_raw = (txU4)the->meterIndex;
				out->compile_computrons = the->meterIndex >> 16;

				captureCount = code[1];
				out->capture_count = (txU4)captureCount;
				out->name_count = (txU4)code[2];

				/* Silence the unused subjectLen note: the subject is a
				 * NUL-terminated C string the matcher scans itself; the
				 * length is kept in the ABI for a future explicit-length
				 * subject and to let the caller assert its own view. */
				(void)subjectLen;

				the->meterIndex = 0;
				out->matched = fxMatchRegExp(the, code, data,
					(txString)subject, start) ? 1 : 0;
				out->match_meter_raw = (txU4)the->meterIndex;
				out->match_computrons = the->meterIndex >> 16;

				before = captureCount;
				if (before > ENDOR_MAX_CAPTURES)
					before = ENDOR_MAX_CAPTURES;
				for (i = 0; i < before; i++) {
					out->captures[2 * i] = (txS4)data[2 * i];
					out->captures[2 * i + 1] = (txS4)data[(2 * i) + 1];
				}
			}
		}
		mxCatch(the) {
			/* A machine-level abort during compile/match (e.g. stack
			 * overflow on a pathological pattern). Report as a compile
			 * failure with a best-effort message. */
			out->ok = 0;
			if (mxException.kind != XS_UNDEFINED_KIND) {
				mxPush(mxException);
				fxToString(the, the->stack);
				if (the->stack->value.string) {
					strncpy(out->error, the->stack->value.string, ENDOR_ERROR_MAX - 1);
					out->error[ENDOR_ERROR_MAX - 1] = 0;
				}
				mxPop();
			}
		}
	}
	fxEndHost(the);
	fxDeleteMachine(the);
	return 0;
}
