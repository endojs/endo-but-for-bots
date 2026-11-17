#!/usr/bin/env python3
"""Compare ironhorse-meter's DEFAULT_KEYS with XS's gxIDStrings at the pin,
evaluating the table's #if blocks under the feature flags the xs-oracle build
uses (xs-oracle/build.rs defines plus xsCommon.h defaults).
Usage (from the repository root): default_keys_vs_xs.py"""
import difflib
import re

FLAGS = dict(mxECMAScript2026=1, mxECMAScript2025=1, mxECMAScript2024=1,
             mxECMAScript2023=1, mxErrorIsError=1, mxExplicitResourceManagement=1,
             mxFloat16=1, mxImmutableArrayBuffers=0, mxModuleStuff=1,
             mxUint8ArrayBase64=1, mxNative=1)


def xs_keys(flags):
    src = open('c/moddable/xs/sources/xsCommon.c').read()
    body = re.search(r'gxIDStrings\[[^\]]*\]\s*=\s*\{(.*?)\};', src, re.S).group(1)
    out, stack = [], [True]
    for line in body.split('\n'):
        s = line.strip()
        if s.startswith('#if'):
            stack.append(stack[-1] and bool(flags[s.split()[1]]))
        elif s.startswith('#endif'):
            stack.pop()
        elif stack[-1]:
            out += re.findall(r'"((?:[^"\\]|\\.)*)"', s)
    return out[1:]  # drop the "@" placeholder (id 0)


rs = open('rust/engine/ironhorse-meter/src/default_keys.rs').read()
ih = re.findall(r'^\s*"((?:[^"\\]|\\.)*)",', rs, re.M)
for value in (0, 1):
    flags = dict(FLAGS, mxImmutableArrayBuffers=value)
    xs = xs_keys(flags)
    print(f'mxImmutableArrayBuffers={value}: XS {len(xs)} keys, DEFAULT_KEYS {len(ih)}')
    for line in difflib.unified_diff(xs, ih, 'XS', 'DEFAULT_KEYS', lineterm='', n=0):
        print('  ' + line)
