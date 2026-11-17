#!/usr/bin/env python3
"""Conformance statistics from the committed whole-tree expectation shards.

usage: python3 -I stats.py <expectations/whole-tree> <test262/test> [--json out.json]

Parses each shard with the grammar of ironhorse-262/src/expectations.rs:
  header  : '# engine=.. features=.. corpus=.. tip=..'
  entry   : '<path> <sloppy|strict> <pass | fail | fail:"json" | skip | skip:reason>'
(splitn(3, whitespace): the outcome token is the rest of the line.)

Joins every case with its test262 frontmatter (features/flags/negative/includes)
and with a text scan for `$262.<hook>` uses.
"""
import json, os, re, sys, collections

shard_dir, test_root = sys.argv[1], sys.argv[2]
out_json = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None

entries = []  # (path, mode, kind, reason)
headers = {}
manifest = []
for name in sorted(os.listdir(shard_dir)):
    p = os.path.join(shard_dir, name)
    if name == 'manifest.txt':
        manifest = [l.strip() for l in open(p) if l.strip()]
        continue
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        if line.startswith('#'):
            if 'engine=' in line or 'corpus=' in line:
                headers[name] = dict(kv.split('=', 1) for kv in line[1:].split() if '=' in kv)
            continue
        parts = re.split(r'\s', line, maxsplit=2)
        path, mode, tok = parts[0], parts[1], parts[2]
        if tok == 'pass':
            entries.append((path, mode, 'pass', ''))
        elif tok == 'fail':
            entries.append((path, mode, 'fail', ''))
        elif tok.startswith('fail:'):
            entries.append((path, mode, 'fail', json.loads(tok[5:])))
        elif tok == 'skip':
            entries.append((path, mode, 'skip', ''))
        elif tok.startswith('skip:'):
            entries.append((path, mode, 'skip', tok[5:]))
        else:
            raise SystemExit(f'bad outcome {tok!r} in {name}')

# --- frontmatter join -------------------------------------------------------
FM_RE = re.compile(r'/\*---(.*?)---\*/', re.S)
fm_cache = {}
def frontmatter(path):
    if path in fm_cache:
        return fm_cache[path]
    try:
        src = open(os.path.join(test_root, path), encoding='utf-8').read()
    except OSError:
        fm_cache[path] = None
        return None
    m = FM_RE.search(src)
    text = m.group(1) if m else ''
    def listfield(key):
        mm = re.search(r'^' + key + r':\s*\[(.*?)\]', text, re.M | re.S)
        if mm:
            return [x.strip() for x in mm.group(1).split(',') if x.strip()]
        mm = re.search(r'^' + key + r':\s*\n((?:\s+-\s*.*\n?)+)', text, re.M)
        if mm:
            return [l.strip()[1:].strip() for l in mm.group(1).splitlines() if l.strip().startswith('-')]
        return []
    neg = re.search(r'^negative:\s*\n\s+phase:\s*(\S+)\s*\n\s+type:\s*(\S+)', text, re.M)
    if not neg:
        neg2 = re.search(r'^negative:\s*\n\s+type:\s*(\S+)\s*\n\s+phase:\s*(\S+)', text, re.M)
        negative = (neg2.group(2), neg2.group(1)) if neg2 else None
    else:
        negative = (neg.group(1), neg.group(2))
    hooks = sorted(set(re.findall(r'\$262\.(\w+)', src)))
    rec = dict(features=listfield('features'), flags=listfield('flags'),
               includes=listfield('includes'), negative=negative, hooks=hooks,
               src_len=len(src))
    fm_cache[path] = rec
    return rec

# --- categorization ---------------------------------------------------------
def skip_family(reason):
    r = reason
    if r.startswith('strict:'):
        r = r[7:]
    if r.startswith('oracle-host-missing-global:'):
        return 'oracle lacks a global Ironhorse has (oracle-host-missing-global:*)'
    if r == 'oracle-host-missing-temporal':
        return 'oracle lacks Temporal (oracle-host-missing-temporal)'
    if r == 'oracle-host-missing-intl':
        return 'oracle lacks Intl (oracle-host-missing-intl)'
    if r == 'shared-positive-test-failure':
        return 'both engines threw the same non-Test262Error (shared-positive-test-failure)'
    if r == 'shared-test262-failure':
        return 'both engines failed the same assertion (shared-test262-failure)'
    if r.startswith('unsupported-opcode:'):
        return 'engine NotImplemented label (unsupported-opcode:*)'
    if r == 'ironhorse-aborted-limit':
        return 'Ironhorse stack/meter/step limit (ironhorse-aborted-limit)'
    if r.startswith('structural:multi-agent'):
        return 'multi-agent / $262.agent / Atomics.wait (structural:multi-agent)'
    if r.startswith('structural:can-block'):
        return 'CanBlockIsFalse flag (structural:can-block)'
    if r.startswith('structural:'):
        return 'other structural (' + r + ')'
    if r.startswith('module:') or r.startswith('compiler-unimplemented:module'):
        return 'module loader / linker shape (module:*)'
    if r.startswith('feature:'):
        return 'feature skip list (' + r + ')'
    if r.startswith('async:'):
        return 'async completion not signalled by Ironhorse (async:*)'
    if r.startswith('compiler-unimplemented:'):
        return 'compiler Unsupported construct (compiler-unimplemented:*)'
    if r == 'non-primitive-completion':
        return 'completion-value rendering (non-primitive-completion)'
    if r.startswith('negative-type-unmatched'):
        return 'Ironhorse threw wrong error type on negative test (negative-type-unmatched:*)'
    if r.startswith('refused:'):
        return 'execution-profile refusal (refused:*)'
    if r == 'negative-oracle-unexpected':
        return 'oracle disagrees with test262 negative (negative-oracle-unexpected)'
    if r == 'parse-or-decode':
        return 'empty/undecodable bytecode (parse-or-decode)'
    if r.startswith('oracle-xs-script-decl-eval-framing'):
        return 'oracle eval framing (oracle-xs-script-decl-eval-framing)'
    if r.startswith('oracle-nontermination'):
        return 'timeout: oracle non-termination'
    if r.startswith('oracle-'):
        return 'other oracle failure (' + r + ')'
    if r == 'strict-unimplemented':
        return 'strict omitted by policy'
    return 'other (' + r + ')'

def fail_family(reason):
    r = reason[7:] if reason.startswith('strict:') else reason
    for prefix, fam in [
        ('error-message-differs:', 'same native error ctor, different message (error-message-differs)'),
        ('abort-type divergence', 'different error constructor (abort-type divergence)'),
        ('abort-value-differs', 'different thrown value (abort-value-differs)'),
        ('ironhorse failed a harness assertion', 'Ironhorse failed an assertion XS passed'),
        ('ironhorse threw where the oracle completed', 'Ironhorse threw where XS completed'),
        ('spurious ReferenceError', 'spurious ReferenceError'),
        ('result divergence', 'completion-value divergence (both completed)'),
        ('negative over-acceptance', 'negative over-acceptance'),
        ('over-acceptance', 'positive over-acceptance (Ironhorse completed, XS threw)'),
        ('module over-acceptance', 'module over-acceptance'),
        ('async:', 'async: Ironhorse did not complete where XS did'),
        ('engine-invariant', 'engine invariant'),
        ('engine-fault', 'engine fault'),
        ('compiler-panicked', 'compiler panic'),
        ('ironhorse-hang', 'timeout: Ironhorse hang'),
        ('ironhorse-worker-panic', 'worker panic'),
        ('setup failed', 'harness setup failed'),
        ('unregistered-halt-label', 'unregistered halt label'),
        ('nondeterministic', 'nondeterminism'),
    ]:
        if r.startswith(prefix):
            return fam
    return 'other fail (' + r[:60] + ')'

# report.rs::classify replica (per-mode)
def classify(kind, reason):
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'pass':
        return 'covered'
    if kind == 'fail':
        return 'ironhorse-failure'
    # NOTE: shards do not distinguish pre-skip from run-skip; feature:/structural:
    # are pre-skips, everything else is a run-skip.
    if r.startswith('feature:') or r.startswith('structural:') or r.startswith('ses-mode:'):
        if r.startswith('structural:missing-harness') or r == 'unreadable':
            return 'infrastructure'
        if r.startswith('ses-mode:') or r in ('feature:lockdown', 'feature:Compartment', 'feature:ses-xs-parity'):
            return 'unsupported'
        return 'skipped'
    if r.startswith('refused:'):
        return 'refused'
    if r in ('oracle-host-missing-intl', 'oracle-host-missing-temporal') or r.startswith('oracle-host-missing-global:'):
        return 'skipped'
    for p in ('oracle-machine-error', 'negative-oracle-unexpected', 'oracle-shim-unsafe', 'oracle-gate-off', 'quarantine:'):
        if r.startswith(p):
            return 'infrastructure'
    if (r.startswith('unsupported-opcode:') or r == 'parse-or-decode' or r.startswith('non-primitive-completion')
            or r.startswith('builtin-coercion-computron-gap') or r.startswith('abort-value-differs')
            or r.startswith('error-message-differs:') or r.startswith('ironhorse-aborted')
            or r.startswith('ironhorse-missing-global:') or r.startswith('negative-') or r.startswith('async:')
            or r in ('shared-test262-failure', 'shared-positive-test-failure') or r.startswith('compiler-unimplemented:')):
        return 'unsupported'
    return 'infrastructure'

# test262's own verdict for Ironhorse, inferred from the recorded outcome.
def t262(kind, reason):
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'pass':
        return 'pass'
    if kind == 'fail':
        if r.startswith('result divergence'):
            return 'pass'  # both completed; completion value is not a test262 observable
        if r.startswith('over-acceptance'):
            return 'pass'  # positive test, Ironhorse completed, XS threw
        return 'fail'
    if r in ('oracle-host-missing-temporal', 'oracle-host-missing-intl',
             'non-primitive-completion') or r.startswith('oracle-xs-script-decl-eval-framing'):
        return 'pass'  # Ironhorse completed the positive test
    if r.startswith('oracle-host-missing-global:') or r == 'negative-oracle-unexpected' \
            or r.startswith('oracle-nontermination'):
        return 'unknown'
    if r.startswith('feature:') or r.startswith('structural:') or r.startswith('module:') \
            or r.startswith('compiler-unimplemented:module'):
        return 'not-run'
    return 'fail'

def topdir(path, depth=2):
    parts = path.split('/')
    return '/'.join(parts[:depth]) if len(parts) > depth else '/'.join(parts[:-1])

# --- aggregate --------------------------------------------------------------
cases = collections.OrderedDict()
for path, mode, kind, reason in entries:
    cases.setdefault(path, []).append((mode, kind, reason))

C = collections.Counter
kind_count = C(k for _, _, k, _ in entries)
mode_count = C(m for _, m, _, _ in entries)
skip_fam = C(); skip_reason = C(); fail_fam = C(); fail_reason_head = C()
cat = C(); t262c = C()
by_dir = collections.defaultdict(C)
by_top = collections.defaultdict(C)
skip_examples = {}
for path, mode, kind, reason in entries:
    d = topdir(path)
    by_dir[d][kind] += 1
    by_dir[d]['total'] += 1
    t = path.split('/')[0]
    by_top[t][kind] += 1
    by_top[t]['total'] += 1
    cat[classify(kind, reason)] += 1
    t262c[t262(kind, reason)] += 1
    by_dir[d]['t262:' + t262(kind, reason)] += 1
    by_top[t]['t262:' + t262(kind, reason)] += 1
    if kind == 'skip':
        f = skip_fam_name = skip_family(reason)
        skip_fam[f] += 1
        skip_reason[reason] += 1
        skip_examples.setdefault(reason, path)
    elif kind == 'fail':
        fail_fam[fail_family(reason)] += 1
        fail_reason_head[(reason[7:] if reason.startswith('strict:') else reason).split(':')[0][:70]] += 1

# per-file view (a file passes iff every recorded mode passes)
file_view = C()
for path, modes in cases.items():
    kinds = {k for _, k, _ in modes}
    if kinds == {'pass'}:
        file_view['all modes pass'] += 1
    elif 'fail' in kinds:
        file_view['some mode fails'] += 1
    else:
        file_view['no fail, some skip'] += 1

# frontmatter join: features of skipped cases, $262 hooks
feat_skip = C(); feat_total = C(); feat_pass = C()
hook_count = collections.defaultdict(C)
neg_early_pass = C()
missing_fm = 0
for path, mode, kind, reason in entries:
    fm = frontmatter(path)
    if fm is None:
        missing_fm += 1
        continue
    for f in fm['features']:
        feat_total[f] += 1
        if kind == 'pass':
            feat_pass[f] += 1
        else:
            feat_skip[f] += 1
    for h in fm['hooks']:
        hook_count[h][kind] += 1
        hook_count[h]['total'] += 1
        if kind != 'pass':
            hook_count[h]['nonpass:' + (skip_family(reason) if kind == 'skip' else fail_family(reason))] += 1
    if fm['negative']:
        neg_early_pass[(fm['negative'][0], kind)] += 1

# missing-global names
mg = C()
for path, mode, kind, reason in entries:
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'skip' and r.startswith('oracle-host-missing-global:'):
        mg[r.split(':', 1)[1]] += 1
uo = C()
for path, mode, kind, reason in entries:
    r = reason[7:] if reason.startswith('strict:') else reason
    if kind == 'skip' and r.startswith('unsupported-opcode:'):
        uo[r.split(':', 1)[1]] += 1

def pct(a, b):
    return f'{100.0 * a / b:.1f}%' if b else '-'

N = len(entries)
print(f'shards (excluding manifest): {len(headers)}; manifest batches: {len(manifest)}')
print(f'tips: {sorted({h.get("tip") for h in headers.values()})}')
print(f'unique cases (files): {len(cases)}; case/modes: {N}; modes: {dict(mode_count)}')
print(f'missing frontmatter (file not in corpus): {missing_fm}')
print()
print('== per case/mode outcome ==')
for k in ('pass', 'fail', 'skip'):
    print(f'  {k:6} {kind_count[k]:7}  {pct(kind_count[k], N)}')
print()
print('== per file (all recorded modes) ==')
for k, v in file_view.most_common():
    print(f'  {k:22} {v:7}  {pct(v, len(cases))}')
print()
print('== report.rs::classify categories (per case/mode) ==')
for k, v in cat.most_common():
    print(f'  {k:18} {v:7}  {pct(v, N)}')
print()
print("== test262's own verdict for Ironhorse, inferred from recorded outcome (per case/mode) ==")
for k, v in t262c.most_common():
    print(f'  {k:8} {v:7}  {pct(v, N)}')
print()
print('== skip families ==')
for k, v in skip_fam.most_common():
    print(f'  {v:7}  {pct(v, kind_count["skip"]):>6} of skips  {k}')
print()
print('== fail families ==')
for k, v in fail_fam.most_common():
    print(f'  {v:7}  {pct(v, kind_count["fail"]):>6} of fails  {k}')
print()
print('== top 25 skip reasons (exact) ==')
for k, v in skip_reason.most_common(25):
    print(f'  {v:6}  {k}   e.g. {skip_examples[k]}')
print()
print('== oracle-host-missing-global names ==')
for k, v in mg.most_common(30):
    print(f'  {v:6}  {k}')
print()
print('== unsupported-opcode labels ==')
for k, v in uo.most_common(40):
    print(f'  {v:6}  {k}')
print()
print('== by top-level tree ==')
print(f'  {"tree":10} {"total":>7} {"pass":>7} {"fail":>6} {"skip":>6}  pass%  t262-pass%(min..max)')
for t, c in sorted(by_top.items()):
    lo = c['t262:pass']; hi = lo + c['t262:unknown']
    print(f'  {t:10} {c["total"]:7} {c["pass"]:7} {c["fail"]:6} {c["skip"]:6}  {pct(c["pass"], c["total"]):>6} {pct(lo, c["total"])}..{pct(hi, c["total"])}')
print()
print('== top 25 directories (depth 2) by non-pass count ==')
rows = sorted(by_dir.items(), key=lambda kv: -(kv[1]['fail'] + kv[1]['skip']))
print(f'  {"dir":42} {"total":>6} {"pass":>6} {"fail":>5} {"skip":>6} {"pass%":>6}')
for d, c in rows[:25]:
    print(f'  {d:42} {c["total"]:6} {c["pass"]:6} {c["fail"]:5} {c["skip"]:6} {pct(c["pass"], c["total"]):>6}')
print()
print('== top 25 directories (depth 2) by fail count ==')
rows = sorted(by_dir.items(), key=lambda kv: -kv[1]['fail'])
for d, c in rows[:25]:
    print(f'  {d:42} {c["total"]:6} fail {c["fail"]:5} ({pct(c["fail"], c["total"])})  skip {c["skip"]:6}')
print()
print('== features: most non-pass case/modes (top 30) ==')
for f, v in feat_skip.most_common(30):
    print(f'  {f:40} nonpass {v:6} / {feat_total[f]:6}  pass {pct(feat_pass[f], feat_total[f])}')
print()
print('== $262 hooks referenced in source (case/modes) ==')
for h, c in sorted(hook_count.items(), key=lambda kv: -kv[1]['total']):
    np = {k[8:]: v for k, v in c.items() if k.startswith('nonpass:')}
    print(f'  $262.{h:22} total {c["total"]:5} pass {c["pass"]:5} fail {c["fail"]:5} skip {c["skip"]:5}')
    for k, v in sorted(np.items(), key=lambda kv: -kv[1])[:4]:
        print(f'        {v:5}  {k}')
print()
print('== negative tests by phase x outcome (case/modes) ==')
for (ph, k), v in sorted(neg_early_pass.items()):
    print(f'  {ph:10} {k:5} {v:6}')

if out_json:
    json.dump({'skip_reason': skip_reason, 'by_dir': {k: dict(v) for k, v in by_dir.items()}}, open(out_json, 'w'), indent=1)
