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
#include "xsScript.h"
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define ENDOR_RESULT_MAX 16384
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
	/* True byte length of the coerced completion value BEFORE the copy
	 * into the fixed `result` buffer. When this exceeds ENDOR_RESULT_MAX-1
	 * the stored `result` is a truncated prefix, so a caller comparing it
	 * against the port must not read a divergence from the truncation — the
	 * differential check skips such a case honestly (finding 493390fc0397). */
	txU4 result_len;
} EndorOracleResult;

static int gEndorClusterReady = 0;

/*
 * Machine create/delete must be serialized process-wide.  XS machines
 * are thread-confined while RUNNING (the differential harness runs
 * cases in parallel across test threads on purpose), but
 * fxCreateMachine / fxDeleteMachine each adjust the process-global
 * shared-cluster usage count (gxSharedCluster->usage in xsAtomics.c)
 * with plain unsynchronized int arithmetic.  Racing creates/deletes
 * lose updates; when the count drifts to zero, fxTerminateSharedCluster
 * frees the live cluster and every later machine create/delete is a
 * use-after-free — observed as intermittent glibc aborts ("double free
 * or corruption", "corrupted double-linked list") in the parallel
 * oracle-differential suites.  The mutex covers the latch and the
 * create/delete calls only; machine execution stays parallel.
 */
static pthread_mutex_t gEndorMachineLifecycleMutex = PTHREAD_MUTEX_INITIALIZER;

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

/*
 * Best-effort stringification of the caught mxException into `buf`.
 * Every mxCatch in this shim wants the thrown value as text, but
 * fxToString can itself throw (an Error whose toString/name/message
 * reads throw again, a Symbol exception), and a throw inside mxCatch
 * re-enters fxJump with an EMPTY jump chain — fxAbort, bypassing the
 * caller's fxEndHost and machine teardown (review finding). So the
 * conversion runs under its own nested mxTry and falls back to a
 * fixed tag; the jump restore rebalances the->stack either way.
 */
static void endor_error_from_exception(txMachine *the, char *buf, size_t max)
{
	if (mxException.kind == XS_UNDEFINED_KIND)
		return;
	mxTry(the) {
		mxPush(mxException);
		fxToString(the, the->stack);
		if (the->stack->value.string) {
			strncpy(buf, the->stack->value.string, max - 1);
			buf[max - 1] = 0;
		}
		mxPop();
	}
	mxCatch(the) {
		strncpy(buf, "(exception stringification threw)", max - 1);
		buf[max - 1] = 0;
	}
}

/*
 * Filesystem module loader for the executable-module oracle
 * (xs_oracle_run_module). The xsnap platform's default loader resolves
 * only baked-in archive/preparation scripts, so csrc/xsoracle-platform.h
 * turns the defaults off and the shim supplies these — adapted verbatim
 * from moddable's test runner xst.c (fxFindModule / fxLoadModule /
 * fxLoadScript). They resolve a relative specifier against the referrer's
 * path and read + parse each dependency from disk, exactly as `xst -m`
 * runs a module. Only reached on the module-run path; the script / regexp
 * / compile entries never load a second module.
 */

/* Resolve a specifier `slot` (against `moduleID`'s path when relative) to a
 * canonical module id. Mirrors xst.c:fxFindModule. */
txID fxFindModule(txMachine* the, txSlot* realm, txID moduleID, txSlot* slot)
{
	char name[C_PATH_MAX];
	char path[C_PATH_MAX];
	txInteger dot = 0;
	txString slash;
	(void)realm;
	fxToStringBuffer(the, slot, name, sizeof(name));
	if (name[0] == '.') {
		if (name[1] == '/') {
			dot = 1;
		}
		else if ((name[1] == '.') && (name[2] == '/')) {
			dot = 2;
		}
	}
	if (dot) {
		if (moduleID == XS_NO_ID)
			return XS_NO_ID;
		c_strncpy(path, fxGetKeyName(the, moduleID), C_PATH_MAX - 1);
		path[C_PATH_MAX - 1] = 0;
		slash = c_strrchr(path, mxSeparator);
		if (!slash)
			return XS_NO_ID;
		if (dot == 2) {
			*slash = 0;
			slash = c_strrchr(path, mxSeparator);
			if (!slash)
				return XS_NO_ID;
		}
	}
	else
		slash = path;
	*slash = 0;
	if ((c_strlen(path) + c_strlen(name + dot)) >= sizeof(path))
		mxRangeError("path too long");
	c_strcat(path, name + dot);
	return fxNewNameC(the, path);
}

/* Parse a module file at `path` (parse + hoist + bind + code). Mirrors the
 * core of xst.c:fxLoadScript (sans the source-map resolution branch, which
 * the fixtures never trigger). */
static txScript *fxEndorLoadScript(txMachine *the, txString path, txUnsigned flags)
{
	txParser _parser;
	txParser *parser = &_parser;
	txParserJump jump;
	/* volatile: these locals are read after the c_setjmp landing pad, so a
	 * longjmp out of fxParserTree must not leave them indeterminate (C99
	 * §7.13.2.1). xst.c omits this; we keep the harness build warning-clean
	 * and standard-correct. */
	FILE *volatile file = C_NULL;
	txString name = C_NULL;
	txScript *volatile script = C_NULL;
	fxInitializeParser(parser, the, the->parserBufferSize, the->parserTableModulo);
	parser->firstJump = &jump;
	file = fopen(path, "r");
	if (c_setjmp(jump.jmp_buf) == 0) {
		mxParserThrowElse(file);
		parser->path = fxNewParserSymbol(parser, path);
		fxParserTree(parser, file, (txGetter)fgetc, flags, &name);
		fclose(file);
		file = C_NULL;
		fxParserHoist(parser);
		fxParserBind(parser);
		script = fxParserCode(parser);
	}
	if (file)
		fclose(file);
	fxTerminateParser(parser);
	return script;
}

/* Load the module identified by `moduleID` (an absolute path) from disk and
 * resolve it into the graph. Mirrors xst.c:fxLoadModule (sans bundle/debug).
 * A `.json` file is a JSON module. A missing/unreadable file leaves the
 * module unresolved, which the linker reports as a rejection. */
void fxLoadModule(txMachine *the, txSlot *module, txID moduleID)
{
	char path[C_PATH_MAX];
	char real[C_PATH_MAX];
	txString dot;
	txScript *script;
	txUnsigned flags = 0;
	c_strncpy(path, fxGetKeyName(the, moduleID), C_PATH_MAX - 1);
	path[C_PATH_MAX - 1] = 0;
	if (c_realpath(path, real)) {
		struct stat a_stat;
		if (stat(real, &a_stat) == 0) {
			if (S_ISDIR(a_stat.st_mode))
				return;
		}
		dot = c_strrchr(real, '.');
		if (dot && !c_strcmp(dot, ".json"))
			flags |= mxJSONModuleFlag;
		script = fxEndorLoadScript(the, real, flags);
		if (script)
			fxResolveModule(the, module, moduleID, script, C_NULL, C_NULL);
	}
}

/* Mirrors DEFAULT_CREATION in rust/endo/xsnap/src/lib.rs, EXCEPT
 * stackCount: the tc39 generated corpora (RegExp/property-escapes,
 * CharacterClassEscapes, identifier start/part sweeps) drive the harness
 * idiom `String.fromCodePoint.apply(null, <10000 code points>)`, which
 * needs one value-stack slot per argument. Production xsnap's 4096 slots
 * abort those cases (`oracle-host-stack-limit` non-results, ~470 in the
 * full sweep); 64Ki slots (1 MiB) lets the oracle host them and certify
 * real verdicts. Stack capacity is host geometry, not language semantics
 * or metering: computron counts do not depend on it. */
static txCreation gEndorCreation = {
	128 * 1024, /* initialChunkSize */
	64 * 1024,  /* incrementalChunkSize */
	8192,       /* initialHeapCount */
	4096,       /* incrementalHeapCount */
	64 * 1024,  /* stackCount */
	2048,       /* initialKeyCount */
	512,        /* incrementalKeyCount */
	127,        /* nameModulo */
	127,        /* symbolModulo */
	8192 * 1024,/* parserBufferSize */
	1993,       /* parserTableModulo */
	0,          /* staticSize */
	0,          /* nativeStackSize */
};

/* See gEndorMachineLifecycleMutex: the latch and the cluster-usage
 * mutations inside fxCreateMachine run under the lock. */
static txMachine *xs_oracle_create_machine(const char *name)
{
	txMachine *the;
	pthread_mutex_lock(&gEndorMachineLifecycleMutex);
	if (!gEndorClusterReady) {
		fxInitializeSharedCluster(C_NULL);
		gEndorClusterReady = 1;
	}
	the = fxCreateMachine(&gEndorCreation, (txString)name, C_NULL, 0);
	pthread_mutex_unlock(&gEndorMachineLifecycleMutex);
	return the;
}

static void xs_oracle_delete_machine(txMachine *the)
{
	pthread_mutex_lock(&gEndorMachineLifecycleMutex);
	fxDeleteMachine(the);
	pthread_mutex_unlock(&gEndorMachineLifecycleMutex);
}

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

	the = xs_oracle_create_machine("xs-oracle");
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
					out->result_len = (txU4)c_strlen(s);
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
			endor_error_from_exception(the, out->error, ENDOR_ERROR_MAX);
		}
	}
	fxEndHost(the);
	xs_oracle_delete_machine(the);
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
 * MULTI-CRANK oracle mode (the wave-6 pattern-2 antidote): run
 * `crankCount` script sources SEQUENTIALLY on ONE machine, capturing a
 * full EndorOracleResult per crank — bytecode/symbols (each crank's
 * own compile), run-only computrons (meterIndex reset per crank,
 * exactly as xs_oracle_run measures a single crank), the microtask
 * drain included (the pump-loop latch), and the completion value.
 *
 * This is what lets the differential harness compare CROSS-CRANK
 * semantics — state created by crank 1 observed by crank 2 — where the
 * single-crank entry structurally cannot (a class of divergence the
 * wave-6 analysis showed 1093 single-crank tests missed). Retained
 * defining-crank bytecode lets the ironhorse side include calls of
 * functions and closures created by earlier cranks too.
 *
 * An uncaught throw in crank i captures into outs[i] exactly as the
 * single-crank entry's catch does and STOPS the run; later cranks are
 * left ok == 0 with no code (the harness compares up to and including
 * the aborting crank). Every out slot must be released with
 * xs_oracle_free regardless.
 */
int xs_oracle_run_cranks(const char **sources, const txU4 *sourceLens,
	txU4 crankCount, EndorOracleResult *outs)
{
	txMachine *the;
	/* Survives the mxCatch longjmp, so the catch attributes the throw
	 * to the crank that raised it. */
	volatile txU4 crank_i = 0;
	txU4 j;

	for (j = 0; j < crankCount; j++)
		memset(&outs[j], 0, sizeof(outs[j]));

	the = xs_oracle_create_machine("xs-oracle-cranks");
	if (!the)
		return -1;

	the = fxBeginHost(the);
	{
		mxTry(the) {
			/* The Hardened-JavaScript globals + test262 host hook, exactly
			 * as xs_oracle_run installs them (see its comment for why the
			 * global must be the stack top during the installs). */
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

			for (crank_i = 0; crank_i < crankCount; crank_i++) {
				EndorOracleResult *out = &outs[crank_i];
				txStringCStream stream;
				txScript *script;
				txSlot *module;
				txSlot *realm;
				txSlot *result;

				stream.buffer = (txString)sources[crank_i];
				stream.offset = 0;
				stream.size = (txSize)sourceLens[crank_i];

				/* Compile this crank (parse metering discarded below). */
				script = fxParseScript(the, &stream, fxStringCGetter,
					mxProgramFlag | mxEvalFlag);

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

				module = mxProgram.value.reference;
				realm = mxModuleInstanceInternal(module)->value.module.realm;

				/* Measure THIS crank's run only. */
				the->meterIndex = 0;
				fxRunScript(the, script, mxRealmGlobal(realm), C_NULL,
					mxRealmClosures(realm)->value.reference, C_NULL, module);
				/* Per-crank microtask drain (the pump-loop latch). */
				while (the->promiseJobs) {
					the->promiseJobs = 0;
					fxRunPromiseJobs(the);
				}
				out->computrons = the->meterIndex >> 16;
				out->meter_raw = (txU4)the->meterIndex;

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
		}
		mxCatch(the) {
			EndorOracleResult *out = &outs[crank_i];
			out->ok = 0;
			out->computrons = the->meterIndex >> 16;
			out->meter_raw = (txU4)the->meterIndex;
			endor_error_from_exception(the, out->error, ENDOR_ERROR_MAX);
		}
	}
	fxEndHost(the);
	xs_oracle_delete_machine(the);
	return 0;
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

	the = xs_oracle_create_machine("xs-oracle-module");
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
			endor_error_from_exception(the, out->error, ENDOR_ERROR_MAX);
		}
	}
	fxEndHost(the);
	xs_oracle_delete_machine(the);
	return 0;
}

/*
 * Reject handler for xs_oracle_run_module: latch the rejection reason
 * into the slot the->rejection points at, exactly as xst.c's
 * fxRejectModuleFile does. A fulfilled module needs no handler body (the
 * completion is observed through the guest's `globalThis.result` and the
 * absence of a latched rejection).
 */
/* The GC-tracked stack slot the reject handler latches the rejection
 * reason into (xst.c uses a machine `rejection` field its platform adds;
 * the xsnap platform this oracle links has no such field, so we hold the
 * latch here). THREAD-LOCAL: each XS machine is thread-confined and the
 * differential harness runs module cases in parallel across test threads,
 * so a process-global latch would let one thread's reject handler write
 * into another thread's machine. `__thread` scopes the latch to the
 * running machine's thread. */
static __thread txSlot *gEndorModuleLatch = C_NULL;

static void xs_oracle_module_fulfilled(txMachine *the)
{
	(void)the;
}

static void xs_oracle_module_rejected(txMachine *the)
{
	if (gEndorModuleLatch)
		*gEndorModuleLatch = *mxArgv(0);
}

/*
 * Run `mainRel` as a MODULE-goal entry point on a fresh machine, linking
 * and EVALUATING the whole graph — the executable counterpart of
 * xs_oracle_compile_module (stage-5 fix2, executable module + dynamic
 * import / import.meta oracle).
 *
 * compile_module proves byte-identity of the emitted module bytecode but
 * cannot run it ("a module cannot fxRunScript without a linker"). This
 * entry drives XS's real module loader over a DETERMINISTIC per-case host
 * filesystem rooted at `dir` (the caller materializes the test262 module
 * fixtures — the entry module plus every module it statically or
 * dynamically imports — into that directory), using the same
 * fxRunImport + job-drain shape xst.c's fxRunModuleFile uses. XS's
 * default host resolve/load hooks (fxFindModule / fxLoadModule in
 * xsPlatforms.c) resolve relative specifiers against the referrer's path
 * and read each dependency from disk, so a multi-file graph, a cyclic
 * graph, caching/identity (a specifier resolves to one module instance),
 * top-level await, dynamic `import()`, `import.meta`, and import
 * attributes all execute exactly as the shipped XS engine runs them.
 *
 * The differential contract mirrors xs_oracle_run's run half but keyed on
 * the module graph's settled state:
 *
 *   out->ok == 1  the entry module's import promise FULFILLED (the whole
 *                 graph linked and evaluated with no uncaught throw). The
 *                 guest's observable result is read from `globalThis.result`
 *                 (String()-coerced; "undefined" when the fixture set none),
 *                 so a fixture asserts a concrete value — a namespace field,
 *                 an identity boolean, a cycle-order string, `import.meta`
 *                 shape — by assigning it there.
 *   out->ok == 0  the import promise REJECTED (a throwing module body, an
 *                 unresolved specifier, a host load failure, a rejected
 *                 dynamic import): out->error carries the String()-coerced
 *                 rejection reason.
 *
 * out->computrons is the meterIndex over the whole import+drain (parse of
 * the graph is interleaved with evaluation and cannot be excluded the way
 * the script entry excludes it, so this is a diagnostic total, not a
 * run-only parity number). No bytecode is captured here — byte identity is
 * the compile entry's job.
 *
 * Returns 0 on a normal outcome (fulfilled or rejected), negative only on
 * a machine-level failure (out of memory creating the machine).
 */
int xs_oracle_run_module(const char *dir, const char *mainRel,
	EndorOracleResult *out)
{
	txMachine *the;
	memset(out, 0, sizeof(*out));

	the = xs_oracle_create_machine("xs-oracle-run-module");
	if (!the)
		return -1;

	the = fxBeginHost(the);
	{
		txSlot *latch;

		/* A GC-tracked stack slot the reject handler writes the rejection
		 * reason into (xst.c uses xsVar(0) the same way). Its address is
		 * stable across later pushes, so the raw pointer in the->rejection
		 * stays valid for the whole run. */
		mxPushUndefined();
		latch = the->stack;
		gEndorModuleLatch = latch;

		mxTry(the) {
			char path[C_PATH_MAX];
			char real[C_PATH_MAX];
			txSlot *module;
			txSlot *realm;

			/* Install the Hardened-JavaScript globals the run entry
			 * installs, so a module body may reference them (parity with
			 * xs_oracle_run; see its long comment). The global must be the
			 * stack top during the install so each host function's HOME is
			 * the global, not a stale frame. */
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

			/* Resolve dir + '/' + mainRel to an absolute path so XS keys the
			 * entry module (and every relative specifier off it) by a stable
			 * canonical id. A missing file is a normal rejection below, not a
			 * machine failure, so realpath failure falls through to a reject
			 * with the unresolved path as the specifier. */
			if ((c_strlen(dir) + 1 + c_strlen(mainRel)) >= sizeof(path))
				mxRangeError("oracle module path too long");
			c_strcpy(path, dir);
			{
				size_t n = c_strlen(path);
				if (n && path[n - 1] != mxSeparator) {
					path[n] = mxSeparator;
					path[n + 1] = 0;
				}
			}
			c_strcat(path, mainRel);
			if (!c_realpath(path, real))
				c_strcpy(real, path);

			module = mxProgram.value.reference;
			realm = mxModuleInstanceInternal(module)->value.module.realm;

			the->meterIndex = 0;

			/* fxRunImport(realm, referrer=NULL) with the specifier + a
			 * placeholder referrer on the stack returns the entry module's
			 * import promise; attach fulfill/reject handlers exactly as
			 * fxRunModuleFile does, then drain the job queue so linking,
			 * evaluation, top-level await, and any dynamic import settle. */
			mxPushStringC(real);
			mxPushUndefined();
			fxRunImport(the, realm, C_NULL);
			mxDub();
			fxGetID(the, mxID(_then));
			mxCall();
			fxNewHostFunction(the, xs_oracle_module_fulfilled, 1, XS_NO_ID, XS_NO_ID);
			fxNewHostFunction(the, xs_oracle_module_rejected, 1, XS_NO_ID, XS_NO_ID);
			mxRunCount(2);
			mxPop();

			/* Drain the promise/module job queue (queue-neutral, so no timer
			 * jobs and no exit-time unhandled-rejection abort), letting the
			 * whole graph settle. */
			while (the->promiseJobs) {
				the->promiseJobs = 0;
				fxRunPromiseJobs(the);
			}

			out->computrons = the->meterIndex >> 16;
			out->meter_raw = (txU4)the->meterIndex;

			if (latch->kind != XS_UNDEFINED_KIND) {
				/* The import promise rejected: stringify the latched reason. */
				out->ok = 0;
				mxPushSlot(latch);
				fxToString(the, the->stack);
				if (the->stack->value.string) {
					strncpy(out->error, the->stack->value.string,
						ENDOR_ERROR_MAX - 1);
					out->error[ENDOR_ERROR_MAX - 1] = 0;
				}
				mxPop();
			}
			else {
				/* Fulfilled: the graph evaluated. Read the guest-observable
				 * result the fixture published on globalThis.result. */
				out->ok = 1;
				mxPush(mxGlobal);
				fxGetID(the, fxID(the, "result"));
				fxToString(the, the->stack);
				if (the->stack->value.string) {
					out->result_len = (txU4)c_strlen(the->stack->value.string);
					strncpy(out->result, the->stack->value.string,
						ENDOR_RESULT_MAX - 1);
					out->result[ENDOR_RESULT_MAX - 1] = 0;
				}
				mxPop();
			}
		}
		mxCatch(the) {
			/* A synchronous throw escaping fxRunImport (before the promise
			 * machinery caught it) is still a normal rejection outcome. */
			out->computrons = the->meterIndex >> 16;
			out->meter_raw = (txU4)the->meterIndex;
			out->ok = 0;
			endor_error_from_exception(the, out->error, ENDOR_ERROR_MAX);
		}
	}
	gEndorModuleLatch = C_NULL;
	fxEndHost(the);
	xs_oracle_delete_machine(the);
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
	/* The meter is XS's own `meterIndex`, a txU8 (xsAll.h). A match over a
	 * pathological empty-matchable pattern can dispatch well over 65536
	 * steps, so the raw 16.16 meter exceeds 2^32; these fields therefore
	 * carry the full 64-bit value. A narrower field silently wrapped it
	 * (finding 5d122a6fc10babd9: a false differential_regexp divergence
	 * where the port's un-truncated u64 meter disagreed only with the
	 * shim's wrapped 32-bit copy). */
	txU8 compile_computrons; /* compile meter >> 16 */
	txU8 compile_meter_raw;
	txU8 match_computrons;   /* match meter >> 16 */
	txU8 match_meter_raw;
	char error[ENDOR_ERROR_MAX]; /* compile error message when ok == 0 */
} EndorRegExpResult;

int xs_oracle_regexp(const char *pattern, const char *modifier,
	const char *subject, txU4 subjectLen, txS4 start, EndorRegExpResult *out)
{
	txMachine *the;
	memset(out, 0, sizeof(*out));

	the = xs_oracle_create_machine("xs-oracle-regexp");
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
				out->compile_meter_raw = (txU8)the->meterIndex;
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
				out->match_meter_raw = (txU8)the->meterIndex;
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
			endor_error_from_exception(the, out->error, ENDOR_ERROR_MAX);
		}
	}
	fxEndHost(the);
	xs_oracle_delete_machine(the);
	return 0;
}
