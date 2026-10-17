#!/bin/bash
# shellcheck disable=SC2034,SC2206
R=/home/user/endo-but-for-bots
FLAGS=(-O2 -fPIC -m64 -w -I$R/c/moddable/xs/sources -I$R/c/moddable/xs/includes -I$R/c/moddable/xs/platforms -I$R/rust/endo/xsnap -I$R/rust/engine/xs-oracle/csrc "-DXSPLATFORM=\"$R/rust/engine/xs-oracle/csrc/xsoracle-platform.h\"" -DINCLUDE_XSPLATFORM -DmxLockdown=1 -DmxMetering=1 -DmxParse=1 -DmxRun=1 -DmxSloppy=1 -DmxSnapshot=1 -DmxRegExpUnicodePropertyEscapes=1 -DmxStringNormalize=1 -DmxMinusZero=1 -DmxBoundsCheck=1 -DmxModuleStuff=1 -DmxCanonicalNaN=1 -DmxCESU8=1 -DmxStringInfoCacheLength=4 -fno-common -fno-strict-aliasing)
pids=()
for s in xsAll xsAPI xsArguments xsArray xsAtomics xsBigInt xsBoolean xsCode xsCommon xsDataView xsDate xsDebug xsDefaults xsdtoa xsError xsFunction xsGenerator xsGlobal xsJSON xsLexical xsLockdown xsMapSet xsMarshall xsMath xsMemory xsModule xsNumber xsObject xsPlatforms xsProfile xsPromise xsProperty xsProxy xsre xsRegExp xsRun xsScope xsScript xsSnapshot xsSourceMap xsString xsSymbol xsSyntaxical xsTree xsType; do
  gcc "${FLAGS[@]}" -c $R/c/moddable/xs/sources/$s.c -o $s.o &
done
gcc "${FLAGS[@]}" -c $R/rust/endo/xsnap/xsnap-platform.c -o plat.o &
gcc "${FLAGS[@]}" -c $R/rust/engine/xs-oracle/csrc/xs_shim.c -o shim.o &
wait
gcc -O2 -c ../oracle_main.c -o main.o
gcc *.o -o oracle_probe -lm -lpthread -ldl
