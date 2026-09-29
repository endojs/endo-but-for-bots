/*
 * XS debugger extensions for xsnap.
 *
 * This translation unit compiles Moddable's xsDebug.c in place of the
 * stock source (build.rs substitutes it), so the functions below can
 * reuse xsDebug.c's file-static echo and listing helpers without
 * patching the pinned c/moddable submodule.
 */

#include "xsDebug.c"

#ifdef mxDebug

/*
 * Stop the world at a panic site (designs/ironhorse-panic.md
 * § Debugger Interaction).
 *
 * A panic is uncatchable by category: it never consults the jump chain,
 * so it must not flow through the exception-break classifier and is
 * never gated by the "exceptions"/"uncaughtExceptions" breakpoints
 * (setExceptionBreakMode). When a debugger is connected, emit a
 * distinct <panic kind="..."> element, then run the same command loop a
 * <break> runs, so the developer can inspect frames while the machine
 * is still frozen at the fault. The caller tears the worker down once
 * the debugger releases it (<go/>, a step, or a detach).
 *
 * The <panic> element is echoed on its own, before the frame and scope
 * listings, so a consumer receives it even if listing a frame at an
 * exhausted stack aborts again (the caller's reentrancy guard then
 * exits to the host without re-entering here).
 */
void fxDebugPanic(txMachine* the, txString kind, txString message)
{
	txSlot* frame;
	txString path = C_NULL;
	txInteger line = 0;
	if (!fxIsConnected(the))
		return;

#ifdef mxInstrument
	if (the->onBreak)
		(the->onBreak)(the, 1);
#endif
#if defined(mxInstrument) || defined(mxProfile)
	fxSuspendProfiler(the);
#endif

	frame = the->frame;
	while (frame && !path) {
		txSlot* environment = mxFrameToEnvironment(frame);
		if (environment->ID != XS_NO_ID) {
			path = fxGetKeyName(the, environment->ID);
			line = environment->value.environment.line;
		}
		frame = frame->next;
	}
	fxEchoStart(the);
	fxEcho(the, "<panic kind=\"");
	fxEchoString(the, kind);
	fxEcho(the, "\"");
	if (path)
		fxEchoPathLine(the, path, line);
	fxEcho(the, "># Panic: ");
	fxEchoString(the, message);
	fxEcho(the, "!\n</panic>");
	fxEchoStop(the);

	if (the->frame) {
		fxEchoStart(the);
		frame = the->frame;
		do {
			frame->flag &= ~XS_DEBUG_FLAG;
			frame = frame->next;
		} while (frame);
		the->frame->flag |= XS_DEBUG_FLAG;
		fxListFrames(the);
		fxListLocal(the);
		fxListGlobal(the);
		fxListModules(the);
		fxEchoStop(the);
	}

	the->debugExit = 0;
	the->debugModule = C_NULL;
	while (fxIsConnected(the)) {
		fxReceive(the);
		fxDebugParse(the);
		if ((the->debugState == XS_LF_STATE) && (the->debugExit > 1))
			break;
	}
	mxHostInspectors.value.list.first = C_NULL;
	mxHostInspectors.value.list.last = C_NULL;

#if defined(mxInstrument) || defined(mxProfile)
	fxResumeProfiler(the);
#endif
#ifdef mxInstrument
	if (the->onBreak)
		(the->onBreak)(the, 0);
#endif
}

#endif /* mxDebug */
