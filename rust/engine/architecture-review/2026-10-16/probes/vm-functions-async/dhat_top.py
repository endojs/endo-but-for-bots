import json, sys
# usage: dhat_top.py dhat.json [N] -- top allocation sites by total bytes, skipping allocator frames
d = json.load(open(sys.argv[1]))
n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
ftbl = d['ftbl']
def site(p):
    out = []
    for i in p['fs']:
        f = ftbl[i]
        if any(s in f for s in ('malloc', 'realloc', 'finish_grow', 'grow_one', 'raw_vec', 'RawVec', 'reserve_rehash', '__rust_')):
            continue
        name = f.split(': ', 1)[-1].split(' (in ')[0]
        out.append(name.replace('ironhorse_vm::interp::', '').replace('<impl ironhorse_vm::interp::Interp>::', '')[:90])
        if len(out) == 3:
            break
    return ' <- '.join(out)
pps = sorted(d['pps'], key=lambda p: -p['tb'])
for p in pps[:n]:
    print('%10d bytes %8d blocks  %s' % (p['tb'], p['tbk'], site(p)))
