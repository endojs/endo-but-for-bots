#!/usr/bin/env python3
"""Check that every NativeMethod variant the router (call_native_method_inner)
sends to a native_method_* family is named inside that family's body, and
report variants a family names that the router never sends to it.
The family bodies end in `_ => unreachable!(...)`, so a router/family
mismatch is a host panic rather than a compile error."""
import re, sys
src = open(sys.argv[1], encoding='utf-8').read().split('\n')
def fn_span(name):
    start = next(i for i, l in enumerate(src) if re.search(r'fn ' + name + r'\(', l))
    for j in range(start + 1, len(src)):
        if re.match(r'^    (pub(\([^)]*\))? )?fn ', src[j]):
            return start, j
    return start, len(src)
rs, re_ = fn_span('call_native_method_inner')
groups = {}
cur = []
for i in range(rs, re_):
    l = src[i]
    cur += re.findall(r'NativeMethod::(\w+)', l)
    m = re.search(r'self\.(native_method_\w+|native_async_generator_method)\(', l)
    if m and cur:
        groups.setdefault(m.group(1), set()).update(cur)
        cur = []
    elif '=>' in l and not m:
        # arm handled elsewhere (inline or another helper); look ahead one line
        nxt = src[i + 1] if i + 1 < len(src) else ''
        m2 = re.search(r'self\.(native_method_\w+|native_async_generator_method)\(', nxt)
        if m2 and cur:
            groups.setdefault(m2.group(1), set()).update(cur)
        cur = []
bad = 0
for fam, sent in sorted(groups.items()):
    s, e = fn_span(fam)
    named = set(re.findall(r'NativeMethod::(\w+)', '\n'.join(src[s:e])))
    missing = sorted(sent - named)
    extra = sorted(named - sent)
    print(f'{fam}: routed {len(sent)}, named in body {len(named)}, routed-but-unnamed {missing}, named-but-not-routed {len(extra)}')
    bad += len(missing)
print('routed-but-unnamed total:', bad)
