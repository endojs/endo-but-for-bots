"""Root-cause label for every IronHorse-alone non-passing case (oracle-off sweep),
combining the sweep reason with the plain-host one-Script re-run (sync: ironhorse-xst;
async: Rust probe zz_audit_cov_1 reading the $DONE latch after the job drain)."""
import json, collections, re, sys
T = '/home/user/endo-but-for-bots/rust/engine/target/test262-report/test262-src/test/'
np = json.load(open('nonpass.json'))
sync = collections.defaultdict(list)
for f in ('sync-all.jsonl', 'intl-results.jsonl'):
    for l in open(f):
        r = json.loads(l); sync[r['path']].append(r)
asy = json.load(open('async-res.json'))
def src(p):
    try: return open(T + p).read()
    except Exception: return ''
PROPOSAL_FEATS = [
 ('joint-iteration', 'absent: Iterator.zip/zipKeyed (lens row)'),
 ('iterator-chunking', 'absent: Iterator.prototype.chunks/windows (lens row)'),
 ('iterator-includes', 'absent: Iterator.prototype.includes (lens row)'),
 ('Iterator.prototype.join', 'absent: Iterator.prototype.join (proposal; lens row)'),
 ('await-dictionary', 'absent: Promise.allKeyed/allSettledKeyed (proposal; lens row)'),
 ('immutable-arraybuffer', 'absent: immutable ArrayBuffer (proposal; lens row)'),
 ('Atomics.pause', 'absent: Atomics.pause (lens row)'),
 ('decorators', 'decorators proposal: @ rejected (lens row)'),
 ('error-stack-accessor', 'NEW error-stack-accessor setter checks'),
 ('legacy-regexp', 'absent: legacy RegExp statics (proposal; lens row)'),
 ('nonextensible-applies-to-private', 'proposal nonextensible-applies-to-private (lens proposal list)'),
 ('import-defer', 'import defer / source phase syntax rejected (proposal; lens row)'),
 ('source-phase-imports', 'import defer / source phase syntax rejected (proposal; lens row)'),
 ('Intl.Locale-info', 'absent: Intl.Locale info getters (proposal; lens row)'),
 ('Intl.DurationFormat', 'absent: Intl.DurationFormat (lens row)'),
 ('Intl.RelativeTimeFormat', 'absent: Intl.RelativeTimeFormat (lens row)'),
 ('Intl.DisplayNames', 'absent: Intl.DisplayNames (lens row)'),
 ('Intl.Era-monthcode', 'Temporal/Intl calendars (NVAL-7, lens row)'),
]
HOOK = re.compile(r'\$262\.(createRealm|evalScript|global|gc|agent|IsHTMLDDA|AbstractModuleSource)')
def label(c):
    p, r, feats = c['path'], c['reason'] or '', c['features']
    s = None
    # one-Script result
    rs = sync.get(p); a = asy.get(p)
    one_pass = (rs and all(x['ok'] for x in rs)) or (a and all(v[0] for v in a.values()))
    if one_pass:
        if r in ('non-primitive-completion',) or r.startswith('result divergence'):
            return 'HARNESS completion-value coercion (passes plain host)'
        return 'T262-2 split-Script artifact (passes as one Script)'
    msg = ''
    if rs: msg = [x for x in rs if not x['ok']][0]['msg']
    elif a:
        b = [v for v in a.values() if not v[0]][0]; msg = (b[2] or '') + ' ' + (b[3] or '') + ' ' + b[1]
    # module / unsupported reasons
    if 'no-async-instance' in r: return 'NEW await in module-level class heritage loses AWAITING (EngineInvariant)'
    if r.startswith('unsupported-opcode:module') or r.startswith('module:resolution-linking') or r.startswith('compiler-unimplemented:module') or 'NotImplemented("module:' in msg:
        if any(f in feats for f in ('import-defer', 'source-phase-imports')): return 'import defer / source phase syntax rejected (proposal; lens row)'
        return 'BOOT-7 modules (static linking / dynamic import / TLA)'
    if r == 'ironhorse-aborted-limit' or 'HeapExhausted' in msg: return 'RGX-1 regexp match-state cap'
    if 'Temporal' in p or 'Temporal' in feats:
        return 'NVAL-6/7 Temporal'
    for f, lab in PROPOSAL_FEATS:
        if f in feats: return lab
    text = src(p)
    if 'cross-realm' in feats or HOOK.search(text): return 'T262-9 $262 hooks (createRealm/evalScript/...)'
    if r.startswith('module:compiler-rejected') or 'invalid import.' in msg or ('dynamic-import' in p and 'COMPILE' in msg):
        return 'import defer / source phase syntax rejected (proposal; lens row)'
    if p.startswith('intl402'):
        if 'cannot coerce undefined to object' in msg and ('prop-desc' in p or 'Locale' in p): return 'CORE-3/NVAL-4 accessors only on static GET'
        if 'formatRange' in msg or 'compact-locale' in msg: return 'Intl NotImplemented (lens rows)'
        return 'NVAL-8/NVAL-5/NVAL-6 Intl data/semantics'
    if p.startswith('annexB/language/') or p.startswith('annexB/built-ins/Function/createdynfn'):
        if p.startswith('annexB/language/literals/regexp'): return 'Annex B.1.2 regexp grammar (XS parity, regexp map note)'
        if 'assignmenttargettype' in p: return 'NEW Annex B call-expression assignment targets'
        return 'CMP-12 Annex B sloppy syntax'
    if p.startswith('annexB/built-ins/String'): return 'absent: Annex B String HTML methods (lens row)'
    if p.startswith('annexB/built-ins/RegExp/prototype/compile') or 'order-after-compile' in p or 'recompiles-source' in p: return 'NEW RegExp.prototype.compile no-op stub'
    if p.startswith('annexB/built-ins/RegExp'): return 'Annex B.1.2 regexp grammar (XS parity, regexp map note)'
    if 'AsyncFromSyncIterator' in p or re.search(r'yield-star.*sync|sync.*yield-star|async-from-sync|for-await.*sync', p): return 'CORE-2/FN-1 AsyncFromSyncIterator'
    if 'Symbol.asyncDispose' in p or ('Iterator/prototype/Symbol.dispose' in p): return 'absent: %IteratorPrototype%[@@dispose]/%AsyncIteratorPrototype%[@@asyncDispose]'
    if re.search(r'TypedArray/prototype/(toReversed|toSorted|with)/', p): return 'NOBJ-12 TypedArray change-array-by-copy'
    if ('Weak' in p or 'FinalizationRegistry' in p) and ('symbol' in p.lower() or 'Symbol' in msg or 'not an object' in msg or 'Refused' in msg or 'refused' in r): return 'NOBJ-13 symbols as weak keys'
    if re.search(r'Expected a ReferenceError to be thrown but no exception', msg) or 'statements/with/' in p or 'assign-to-global-undefined' in p:
        return 'NEW PutValue/GetBindingValue skip HasProperty re-check'
    if re.search(r'(frozen|seal|preventExtensions|symbol-data-property-default)-?.*strict|undefined/15\.1\.1\.3-2', p): return 'NEW strict computed-key [[Set]] failure ignored'
    if 'RegExp' in p and ('cannot coerce undefined' in msg or 'hasOwnProperty' in msg): return 'RGX-2 RegExp accessors not properties'
    if 'getOwnPropertyDescriptor/15.2.3.3-4' in p: return 'RGX-2 RegExp accessors not properties'
    if 'disposed' in p: return 'NOBJ-9 disposed accessor'
    if 'Math/random' in p or 'S11.2.1_A4_T8' in p: return 'absent: Math.random (lens row)'
    if 'static-init' in p: return 'CMP-3 static blocks'
    if re.search(r'Promise/any/', p): return 'FN-6 Promise.any'
    if re.search(r'Promise/prototype/finally', p): return 'FN-8 finally'
    if 'disposeAsync' in p: return 'NOBJ-8 disposeAsync'
    if 'revoked' in p or 'typeof/proxy' in p: return 'PROP-5 proxy callability'
    if 'call: not a function' in msg and re.search(r'\bthis\.(hasOwnProperty|propertyIsEnumerable)\b', text): return 'CORE-4/PROP-7 global [[Prototype]] null'
    if 'broken-promise' in p or 'constructor-lookup' in p: return 'FN-5 await/PromiseResolve constructor check'
    if 'async-generator/return-undefined-implicit-and-explicit' in p or 'yield-return-then-getter-ticks' in p: return 'FN-7 async generator return await'
    if 'getPrototypeOf/15.2.3.2-2-30' in p or 'Object/create/15.2.3.5-1-2' in p or 'seal-proxy' in p: return 'CORE-4/PROP-7 global [[Prototype]] null'
    if 'setPrototypeOf-with-non-circular' in p: return 'PROP-6 immutable Object.prototype'
    return 'OTHER: ' + re.sub(r'«[^»]*»', '«…»', msg)[:80]
L = {}
for c in np: L[c['path']] = label(c)
json.dump(L, open('labels.json', 'w'), indent=0)
if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'labels'
    if mode == 'labels':
        for k, v in collections.Counter(L.values()).most_common(): print(v, k)
    elif mode == 'other':
        for c in np:
            if L[c['path']].startswith('OTHER'): print(c['path'], '|', L[c['path']])
    elif mode == 'clusters':
        g = collections.defaultdict(collections.Counter)
        def norm(r): return re.sub(r'«[^»]*»', '«…»', re.sub(r'"[^"]*"', '"…"', r or ''))[:140]
        v = {}
        exec(open('../../../probes/test262-sweep/ih_alone.py').read().split('V = [')[0].replace("d = json.load(open(sys.argv[1]))", "d={'cases':[]}"), v)
        for c in np: g[('/'.join(c['path'].split('/')[:3]), v['verdict'](c), norm(c['reason']))][L[c['path']]] += 1
        for k, cnt in sorted(g.items(), key=lambda kv: -sum(kv[1].values())):
            n = sum(cnt.values())
            if n >= 10: print(f"{n}\t{k[0]}\t{k[1]}\t{k[2][:70]}\t" + '; '.join(f'{lab} {m}' for lab, m in cnt.most_common()))
    elif mode == 'features':
        for f in sys.argv[2:]:
            cnt = collections.Counter(L[c['path']] for c in np if f in c['features'])
            print(f'== {f} ({sum(cnt.values())})')
            for k, n in cnt.most_common(): print('   ', n, k)
