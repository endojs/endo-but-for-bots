import json, sys, collections
ns = {}
exec(compile(open(sys.argv[3]).read().split("V = ['pass'")[0].replace("d = json.load(open(sys.argv[1]))", ""), 'ih', 'exec'), ns)
verdict = ns['verdict']
on = {c['path']: c for c in json.load(open(sys.argv[1]))['cases']}
off = {c['path']: c for c in json.load(open(sys.argv[2]))['cases']}
x = collections.Counter((on[p]['category'], verdict(off[p])) for p in on)
V = ['pass', 'fail', 'unsupported', 'not-run']
print('| differential category (oracle on) | ' + ' | '.join(f'IronHorse {v}' for v in V) + ' | total |')
print('|---|' + '---:|' * (len(V) + 1))
for cat in ['covered', 'ironhorse-failure', 'unsupported', 'refused', 'skipped', 'infrastructure']:
    row = [x[(cat, v)] for v in V]
    print(f'| {cat} | ' + ' | '.join(map(str, row)) + f' | {sum(row)} |')
row = [sum(x[(c, v)] for c in {k[0] for k in x}) for v in V]
print('| total | ' + ' | '.join(map(str, row)) + f' | {sum(row)} |')
