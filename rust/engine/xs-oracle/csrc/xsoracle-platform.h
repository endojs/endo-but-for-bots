/*
 * Oracle platform wrapper.
 *
 * The oracle reuses xsnap's audited platform layer verbatim
 * (xsnap-platform.{c,h}), but xsnap's platform hard-`#define`s
 * mxUseDefaultFindModule / mxUseDefaultLoadModule to 1 — its default
 * module loader resolves only baked-in archive/preparation scripts (SES
 * bundles), never the filesystem, because a shipped xsnap embeds its
 * modules. The executable-module oracle (xs_oracle_run_module) instead
 * links a graph the caller has materialized as real files under a
 * per-case directory, so it needs XS's *filesystem* resolve/load hooks —
 * the ones the moddable test runner xst.c provides.
 *
 * This wrapper includes the xsnap platform, then flips those two guards
 * off so xsPlatforms.c leaves fxFindModule / fxLoadModule undefined and
 * the shim (xs_shim.c) supplies its own filesystem versions (adapted from
 * xst.c). Nothing else about the platform changes, so the script / regexp
 * / module-compile entries are byte-for-byte unaffected.
 */
#ifndef XSORACLE_PLATFORM_H__
#define XSORACLE_PLATFORM_H__

#include "xsnap-platform.h"

#undef mxUseDefaultFindModule
#define mxUseDefaultFindModule 0
#undef mxUseDefaultLoadModule
#define mxUseDefaultLoadModule 0

#endif /* XSORACLE_PLATFORM_H__ */
