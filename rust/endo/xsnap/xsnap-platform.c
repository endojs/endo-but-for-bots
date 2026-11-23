/*
 * Platform functions for XS embedded in Rust.
 * Timer infrastructure and run loop copied from
 * c/xsnap-pub/xsnap/sources/xsnapPlatform.c.
 */

#define _GNU_SOURCE
#include "xsAll.h"

/* ---- Timer job struct (forward declaration) ---- */

typedef struct sxJob txJob;

struct sxJob {
	txJob* next;
	txMachine* the;
	txNumber when;
	txSlot self;
	txSlot function;
	txSlot argument;
	txNumber interval;
};

/* ---- Promise job flag ---- */

/*
 * the->promiseJobs is a one-shot latch, and it has two
 * destructive consumers within a single machine: fxRunLoop (which
 * clears it at the top of its own drain loop below) and the Rust
 * quiesce path (Machine::quiesce and the reactive pump in
 * src/lib.rs) via fxMachineHasPendingJobs. Whichever reads it first
 * takes the signal; the other sees 0.
 *
 * The sharing is believed benign, because every quiesce-path read is
 * immediately preceded by fxRunPromiseJobs on the same machine, so a
 * swallowed signal has already been serviced. It is stated here
 * rather than left implicit because one consumer eating another's
 * latch is exactly the bug the removed process-global
 * gHasPendingJobs caused across machines; a future caller that checks
 * the flag without draining first would reproduce it within one
 * machine.
 */

void fxCreateMachinePlatform(txMachine* the)
{
	the->promiseJobs = 0;
	the->timerJobs = C_NULL;
}

void fxDeleteMachinePlatform(txMachine* the)
{
	/* Free any remaining timer jobs. */
	txJob* job = (txJob*)the->timerJobs;
	while (job) {
		txJob* next = job->next;
		c_free(job);
		job = next;
	}
	the->timerJobs = C_NULL;
}

/*
 * Custom fxQueuePromiseJobs.
 *
 * Sets the per-machine flag consumed by fxRunLoop and by Rust's
 * quiesce loop via fxMachineHasPendingJobs.
 */
void fxQueuePromiseJobs(txMachine* the)
{
	the->promiseJobs = 1;
}

/*
 * Check and reset this machine's pending-jobs flag.
 * Used by Rust's quiesce() loop. Per-machine on purpose: a
 * process-wide flag lets one machine's drain steal another's
 * pending signal when machines run on concurrent threads.
 */
int fxMachineHasPendingJobs(txMachine* the)
{
	int result = the->promiseJobs;
	the->promiseJobs = 0;
	return result;
}

/* ---- Timer infrastructure ---- */

static void fxDestroyTimer(void* data);
static void fxMarkTimer(txMachine* the, void* it, txMarkRoot markRoot);

static txHostHooks gxTimerHooks = {
	fxDestroyTimer,
	fxMarkTimer
};

void fxClearTimer(txMachine* the)
{
	txHostHooks* hooks = fxGetHostHooks(the, mxArgv(0));
	if (hooks == &gxTimerHooks) {
		txJob* job = fxGetHostData(the, mxArgv(0));
		if (job) {
			fxForget(the, &job->self);
			fxSetHostData(the, mxArgv(0), NULL);
			job->the = NULL;
		}
	}
	else
		mxTypeError("no timer");
}

void fxDestroyTimer(void* data)
{
}

void fxMarkTimer(txMachine* the, void* it, txMarkRoot markRoot)
{
	txJob* job = it;
	if (job) {
		(*markRoot)(the, &job->function);
		(*markRoot)(the, &job->argument);
	}
}

void fxSetTimer(txMachine* the, txNumber interval, txBoolean repeat)
{
	c_timeval tv;
	txJob* job;
	txJob** address = (txJob**)&(the->timerJobs);
	while ((job = *address))
		address = &(job->next);
	job = *address = malloc(sizeof(txJob));
	c_memset(job, 0, sizeof(txJob));
	job->the = the;
	c_gettimeofday(&tv, NULL);
	if (repeat)
		job->interval = interval;
	job->when = ((txNumber)(tv.tv_sec) * 1000.0) + ((txNumber)(tv.tv_usec) / 1000.0) + interval;
	fxNewHostObject(the, NULL);
	mxPull(job->self);
	job->function = *mxArgv(0);
	if (mxArgc > 2)
		job->argument = *mxArgv(2);
	else
		job->argument = mxUndefined;
	fxSetHostData(the, &job->self, job);
	fxSetHostHooks(the, &job->self, &gxTimerHooks);
	fxRemember(the, &job->self);
	fxAccess(the, &job->self);
	*mxResult = the->scratch;
}

/* ---- Debug hooks ---- */

/*
 * fxRunDebugger: always defined (declared in xsnap.h without
 * #ifdef mxDebug guard). When mxDebug is off, it's a no-op.
 */
void fxRunDebugger(txMachine* the)
{
#ifdef mxDebug
	fxDebugCommand(the);
#endif
}

#ifdef mxDebug

/*
 * Rust-side debug I/O functions (defined in powers/debug.rs).
 * These use thread-local buffers so each worker thread has
 * independent debug state.
 */
extern void rust_debug_connect(void);
extern void rust_debug_disconnect(void);
extern int rust_debug_is_connected(void);
extern int rust_debug_is_readable(void);
extern int rust_debug_recv(char* buffer, int capacity);
extern void rust_debug_send(const char* data, int length);

void fxConnect(txMachine* the)
{
	/* XS calls this during machine creation.
	   The Rust side must have called debug_enable() on this thread
	   before machine creation for the connection to activate. */
	rust_debug_connect();
}

void fxDisconnect(txMachine* the)
{
	rust_debug_disconnect();
}

txBoolean fxIsConnected(txMachine* the)
{
	return rust_debug_is_connected();
}

txBoolean fxIsReadable(txMachine* the)
{
	return rust_debug_is_readable();
}

void fxReceive(txMachine* the)
{
	int n = rust_debug_recv(
		the->debugBuffer, sizeof(the->debugBuffer) - 1);
	if (n < 0)
		the->debugOffset = 0;
	else
		the->debugOffset = n;
	the->debugBuffer[the->debugOffset] = 0;
}

void fxSend(txMachine* the, txBoolean more)
{
	rust_debug_send(the->echoBuffer, the->echoOffset);
}

#endif /* mxDebug */

/* ---- Run loop ---- */

void fxRunLoop(txMachine* the)
{
	c_timeval tv;
	txNumber when;
	txJob* job;
	txJob** address;
	for (;;) {
		while (the->promiseJobs) {
			the->promiseJobs = 0;
			fxRunPromiseJobs(the);
		}
		fxEndJob(the);
		if (the->promiseJobs) {
			continue;
		}
		c_gettimeofday(&tv, NULL);
		when = ((txNumber)(tv.tv_sec) * 1000.0) + ((txNumber)(tv.tv_usec) / 1000.0);
		address = (txJob**)&(the->timerJobs);
		if (!*address)
			break;
		while ((job = *address)) {
			txMachine* the = job->the;
			if (the) {
				if (job->when <= when) {
					fxBeginHost(the);
					mxTry(the) {
						mxPushUndefined();
						mxPush(job->function);
						mxCall();
						mxPush(job->argument);
						mxRunCount(1);
						mxPop();
						if (job->the) {
							if (job->interval) {
								job->when += job->interval;
							}
							else {
								fxAccess(the, &job->self);
								*mxResult = the->scratch;
								fxForget(the, &job->self);
								fxSetHostData(the, mxResult, NULL);
								job->the = NULL;
							}
						}
					}
					mxCatch(the) {
						fxAccess(the, &job->self);
						*mxResult = the->scratch;
						fxForget(the, &job->self);
						fxSetHostData(the, mxResult, NULL);
						job->the = NULL;
						fxAbort(the, XS_UNHANDLED_EXCEPTION_EXIT);
					}
					fxEndHost(the);
					break; /* run promise jobs queued by the timer */
				}
				address = &(job->next);
			}
			else {
				*address = job->next;
				c_free(job);
			}
		}
	}
	fxCheckUnhandledRejections(the, 1);
}

/* ---- Guarded eval for Machine::eval ---- */

/*
 * Call the global `eval` on `source` inside an XS try frame.
 *
 * Machine::eval (src/lib.rs) calls this between fxBeginHost and
 * fxEndHost.  fxBeginHost installs no jump record, so without this a
 * throw longjmps to whatever `the->firstJump` holds: NULL at top level
 * (fxJump then dereferences it), or a jump record below a Rust caller's
 * frames when Machine::eval runs inside a host callback.  Here the jump
 * lands in this C frame instead.
 *
 * On success the completion value is left in *result and 0 is returned.
 * A value other than undefined, null, a boolean, a number or a string is
 * converted to a string first, while the try is still in place, because
 * that conversion runs JS (`toString`) that can throw.  The value is kept
 * on the XS stack during the conversion so that it stays reachable, and
 * once it is a primitive the caller can read it without calling into JS.
 *
 * If the evaluation or the conversion throws, returns -1.  A recoverable
 * fxAbort (fxExitToHost) longjmps to the outermost jump record; when this
 * try is the outermost one (Machine::eval at top level) it lands here and
 * the exit status is returned.  Either way the stack, scope, frame and
 * code are restored to what they were on entry.
 */
int fxEvalGuarded(txMachine* the, txString source, txSlot* result)
{
	int status = 0;
	the->exitStatus = 0;
	mxTry(the) {
		/* `this`, the frame fxCallID builds, and the one argument. */
		fxOverflow(the, -8, C_NULL, 0);
		mxPush(mxGlobal);
		fxCallID(the, fxID(the, "eval"));
		mxPushStringC(source);
		fxRunCount(the, 1);
		switch (the->stack->kind) {
		case XS_UNDEFINED_KIND:
		case XS_NULL_KIND:
		case XS_BOOLEAN_KIND:
		case XS_INTEGER_KIND:
		case XS_NUMBER_KIND:
		case XS_STRING_KIND:
		case XS_STRING_X_KIND:
			break;
		default:
			fxToString(the, the->stack);
			break;
		}
		*result = *(the->stack);
		mxPop();
	}
	mxCatch(the) {
		status = the->exitStatus ? the->exitStatus : -1;
		the->exitStatus = 0;
	}
	return status;
}

/* ---- Guarded define and key lookup for Machine::define_function / id ---- */

/*
 * xs.h's xsDefine(xsGlobal, xsID(name), xsNewHostFunction(callback,
 * length), flag) under an XS try frame.  fxDefineID throws a TypeError
 * when the global already has a non-configurable property of that name
 * (or is frozen), and fxID aborts when the key table is full; with no
 * jump record installed either one longjmps through a NULL firstJump.
 * Returns 0, -1 if it threw, or the exit status of an abort that landed
 * here.  Must be called between fxBeginHost and fxEndHost.
 */
int fxDefineHostFunctionGuarded(txMachine* the, txString name, txCallback callback,
	txInteger length, txInteger flag, txInteger mask)
{
	int status = 0;
	the->exitStatus = 0;
	mxTry(the) {
		txID id = fxID(the, name);
		/* the function, the global, and what fxNewHostFunction pushes. */
		fxOverflow(the, -8, C_NULL, 0);
		fxNewHostFunction(the, callback, length, id, XS_NO_ID);
		mxPush(mxGlobal);
		fxDefineID(the, id, (txFlag)flag, (txFlag)mask);
		mxPop();
	}
	mxCatch(the) {
		status = the->exitStatus ? the->exitStatus : -1;
		the->exitStatus = 0;
	}
	return status;
}

/*
 * fxID under an XS try frame, for the key-table-full abort.  Returns 0
 * with the key in *id, or nonzero as fxDefineHostFunctionGuarded.
 */
int fxIDGuarded(txMachine* the, txString name, void* id)
{
	int status = 0;
	the->exitStatus = 0;
	mxTry(the) {
		*(txID*)id = fxID(the, name);
	}
	mxCatch(the) {
		status = the->exitStatus ? the->exitStatus : -1;
		the->exitStatus = 0;
	}
	return status;
}

/* ---- Guarded drains for Machine::run_promise_jobs / quiesce / run_loop ---- */

/*
 * Run `run` with this C frame as the outermost jump record.
 *
 * fxRunPromiseJobs runs each job under its own mxTry, and its catch
 * calls fxAbort(XS_UNHANDLED_EXCEPTION_EXIT); fxRunLoop does the same for
 * a timer callback.  A recoverable abort inside a job (stack or memory
 * exhaustion, metering) longjmps to the outermost jump record, which is
 * that job's own try when Rust calls the drain at top level; its catch
 * then aborts again with `the->firstJump` NULL, and fxExitToHost
 * dereferences it.  Installing an outermost record here makes every such
 * abort land in this frame.
 *
 * Returns 0 if `run` returned, or the exit status of the abort that
 * landed here, with the stack, scope, frame and code restored.  (Called
 * inside a host callback, an abort still longjmps to the outermost record
 * below the callback's frames, as for fxEvalGuarded.)
 */
static int fxRunGuarded(txMachine* the, void (*run)(txMachine*))
{
	txJump aJump;
	aJump.nextJump = the->firstJump;
	aJump.stack = the->stack;
	aJump.scope = the->scope;
	aJump.frame = the->frame;
	aJump.code = the->code;
	aJump.flag = 0;
	the->firstJump = &aJump;
	the->exitStatus = 0;
	if (c_setjmp(aJump.buffer) == 0) {
		(*run)(the);
		the->firstJump = aJump.nextJump;
		return 0;
	}
	else {
		int status = the->exitStatus ? the->exitStatus : -1;
		the->stack = aJump.stack;
		the->scope = aJump.scope;
		the->frame = aJump.frame;
		the->code = aJump.code;
		the->firstJump = aJump.nextJump;
		the->exitStatus = 0;
		return status;
	}
}

int fxRunPromiseJobsGuarded(txMachine* the)
{
	return fxRunGuarded(the, fxRunPromiseJobs);
}

int fxRunLoopGuarded(txMachine* the)
{
	return fxRunGuarded(the, fxRunLoop);
}

/* ---- Metering helpers ---- */

#ifdef mxMetering

/*
 * Get the current meter index (computrons = value >> 16).
 */
txU8 fxGetCurrentMeter(txMachine* the)
{
	return the->meterIndex;
}

/*
 * Set the meter index directly.
 */
void fxSetCurrentMeter(txMachine* the, txU8 value)
{
	the->meterIndex = value;
}

/*
 * Safe wrapper around fxRunPromiseJobs that catches aborts.
 *
 * Uses a raw setjmp/longjmp guard as the outermost jump frame.
 * fxExitToHost walks `firstJump` to the outermost frame (where
 * nextJump == NULL) and longjmps there.  We set up that outermost
 * frame here so the abort lands safely in C, not across Rust.
 *
 * Returns 0 on success, or the XS exit status on abort.
 */
int fxRunPromiseJobsMetered(txMachine* the)
{
	txJump aJump;
	aJump.nextJump = the->firstJump;
	aJump.stack = the->stack;
	aJump.scope = the->scope;
	aJump.frame = the->frame;
	aJump.code = the->code;
	aJump.flag = 0;
	the->firstJump = &aJump;
	the->exitStatus = 0;
	if (c_setjmp(aJump.buffer) == 0) {
		fxRunPromiseJobs(the);
		the->firstJump = aJump.nextJump;
		return 0;
	}
	else {
		/* fxExitToHost landed here — restore state. */
		the->stack = aJump.stack;
		the->scope = aJump.scope;
		the->frame = aJump.frame;
		the->code = aJump.code;
		the->firstJump = aJump.nextJump;
		return the->exitStatus;
	}
}

#endif /* mxMetering */

/* ---- Custom fxAbort ---- */

/*
 * Non-default fxAbort: use fxExitToHost (longjmp) for recoverable
 * abort conditions so the process is not killed.  Only truly fatal
 * conditions (debugger exit, fatal check) call exit().
 */
void fxAbort(txMachine* the, int status)
{
	the->exitStatus = status;
	switch (status) {
	case XS_TOO_MUCH_COMPUTATION_EXIT:
	case XS_JAVASCRIPT_STACK_OVERFLOW_EXIT:
	case XS_NOT_ENOUGH_MEMORY_EXIT:
	case XS_NO_MORE_KEYS_EXIT:
	case XS_UNHANDLED_EXCEPTION_EXIT:
	case XS_UNHANDLED_REJECTION_EXIT:
	case XS_NATIVE_STACK_OVERFLOW_EXIT:
		/* Recoverable: longjmp to the nearest mxTry frame. */
		fxExitToHost(the);
		break;
	default:
		/* Fatal: debugger exit, dead strip, fatal check. */
		c_exit(status);
		break;
	}
}

/* ---- Snapshot callback discovery ---- */

/*
 * Collect all host callback pointers found on the machine heap.
 * Returns the number of unique callbacks found.
 * If `out` is non-NULL and `out_cap` > 0, stores pointers in `out`.
 *
 * Walks XS_CALLBACK_KIND and XS_CALLBACK_X_KIND slots, which is
 * the same slot kind the snapshot writer projects via
 * fxProjectCallback.
 */
#include <dlfcn.h>

int fxCollectHostCallbacks(txMachine* the, txCallback* out, int out_cap) {
	int count = 0;
	txSlot* aSlot;
	txSlot* bSlot;
	txSlot* cSlot;

	/* Walk heap chunks */
	aSlot = the->firstHeap;
	while (aSlot) {
		bSlot = aSlot + 1;
		cSlot = aSlot + 1 + ((aSlot + 1)->next->value.integer);
		while (bSlot < cSlot) {
			if (bSlot->kind == XS_CALLBACK_KIND
				|| bSlot->kind == XS_CALLBACK_X_KIND) {
				txCallback cb = bSlot->value.callback.address;
				if (cb) {
					int found = 0;
					for (int i = 0; i < count; i++) {
						if (out && out[i] == cb) { found = 1; break; }
					}
					if (!found) {
						if (out && count < out_cap) {
							out[count] = cb;
						}
						count++;
					}
				}
			}
			bSlot++;
		}
		aSlot = aSlot->next;
	}
	return count;
}

/* Print all host callbacks found on the machine to stderr.
   Useful for discovering which callbacks the snapshot table needs. */
void fxDebugDumpCallbacks(txMachine* the) {
	txCallback cbs[256];
	int n = fxCollectHostCallbacks(the, cbs, 256);
	fprintf(stderr, "=== Host callbacks on machine: %d ===\n", n);
	for (int i = 0; i < n && i < 256; i++) {
		Dl_info info;
		if (dladdr((void*)cbs[i], &info) && info.dli_sname) {
			fprintf(stderr, "  [%d] %s (%p)\n", i, info.dli_sname, (void*)cbs[i]);
		} else {
			fprintf(stderr, "  [%d] <unknown> (%p)\n", i, (void*)cbs[i]);
		}
	}
	fprintf(stderr, "=== end ===\n");
}
