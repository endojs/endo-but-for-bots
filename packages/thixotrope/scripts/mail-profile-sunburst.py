#!/usr/bin/env python3
"""Partition a measured mail interval without double-counting concurrent work."""
import argparse
from collections import Counter, defaultdict
import html
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('trace', type=Path)
parser.add_argument('output', type=Path, help='output basename for .json and .svg')
parser.add_argument('--label', help='name of this experiment for the figure title')
parser.add_argument('--segments', action='store_true', help='include every wall-partition segment in JSON')
parser.add_argument('--trial', type=int, help='defaults to the median elapsed-time trial')
args = parser.parse_args()
raw = args.trace.read_text()
if args.trace.suffix == '.jsonl':
    records = [json.loads(line) for line in raw.splitlines() if line]
    data = {**records[0], 'events': records[1:]}
else:
    data = json.loads(raw)
windows = [w for w in data['trials'] if 'end' in w]
median = statistics.median(w['end'] - w['start'] for w in windows)
window = (next(w for w in windows if w['trial'] == args.trial) if args.trial is not None
          else min(windows, key=lambda w: abs(w['end'] - w['start'] - median)))
start, end = window['start'], window['end']
total = end - start
active_events = [e for e in data['events'] if e['end'] > start and e['start'] < end]
if not any(e['kind'] == 'vm' for e in active_events):
    raise SystemExit('No native VM phases in selected trial; use the profiling worker')

files = {'hub': 'Hub state', 'worker-journal': 'Worker journal',
         'worker-tables': 'Worker tables', 'session-store': 'Session store', 'other': 'Other files'}
phases = {'compile-and-relink': 'Compile / relink', 'execution-and-jobs': 'Execute / jobs',
          'garbage-collection': 'GC', 'finalizer-callbacks': 'Finalizers', 'extraction-compilation': 'Extraction compile',
          'outbound-extraction': 'Extract frames'}
requests = {'deliver': 'Native delivery', 'dispatch': 'Dispatch', 'drain': 'Outbound drain', 'other': 'Other evaluation'}
ops = {'file-fsync': 'File fsync', 'directory-fsync': 'Directory fsync', 'writeFile': 'Write bytes',
       'open': 'Open', 'close': 'Close', 'rename': 'Rename', 'rm': 'Remove scratch'}
root_colors = {'Filesystem only': '#2563eb', 'VM only': '#7c3aed',
               'Filesystem + VM': '#0d9488', 'Host JS only': '#d97706',
               'Host JS + VM': '#be185d', 'Parallel VMs': '#a855f7',
               'Other / unmeasured': '#94a3b8'}
bounds = sorted({start, end, *[max(start, min(end, t)) for e in active_events
                            for t in [e['start'], e['end']]]})
leaves = defaultdict(float)
stage_totals = defaultdict(float)
segments = []
for lo, hi in zip(bounds, bounds[1:]):
    if hi <= lo:
        continue
    mid = (lo + hi) / 2
    events = [e for e in active_events if e['start'] <= mid < e['end']]
    fs = [e for e in events if e['kind'] == 'filesystem']
    calls = [e for e in events if e['kind'] == 'syscall']
    vm = [e for e in events if e['kind'] == 'vm']
    host = [e for e in events if e['kind'] == 'host']
    stage = next((e['name'] for e in events if e['kind'] == 'stage'), 'bridge-completion')
    stage_totals[stage] += hi - lo
    # The host executes synchronous filesystem operations serially. Native VMs
    # run in separate processes, so overlap gets its own sector.
    if fs or calls:
        file = files.get((fs or calls)[-1].get('file'), 'Other files')
        operation = ops.get(calls[-1]['name'], calls[-1]['name']) if calls else 'Filesystem setup'
        if vm:
            vm_label = phases.get(vm[0]['name'], vm[0]['name']) if len(vm) == 1 else 'Parallel VM phases'
            path = ('Filesystem + VM', file, f'{operation} + {vm_label}')
        else:
            path = ('Filesystem only', file, operation)
    elif host:
        path = ('Host JS + VM' if vm else 'Host JS only', host[-1]['name'])
    elif len(vm) == 1:
        path = ('VM only', requests.get(vm[0]['request'], vm[0]['request']), phases.get(vm[0]['name'], vm[0]['name']))
    elif vm:
        path = ('Parallel VMs', 'Multiple worker phases')
    else:
        waiting = any(e['kind'] == 'worker-request' for e in events)
        path = ('Other / unmeasured', 'Worker reply gap' if waiting else 'Bridge / IPC gap')
    leaves[path] += hi - lo
    segments.append({'startMs': lo-start, 'endMs': hi-start, 'path': list(path)})
assert abs(sum(leaves.values()) - total) < 0.001

def clipped(e):
    return max(0, min(end, e['end']) - max(start, e['start']))

def grouped(kind, keys):
    result = defaultdict(float)
    counts = defaultdict(int)
    for event in active_events:
        if event['kind'] != kind:
            continue
        key = ' / '.join(str(event.get(k, '')) for k in keys)
        result[key] += clipped(event)
        counts[key] += 1
    return [{'name': k, 'ms': result[k], 'count': counts[k]} for k in sorted(result)]

roots = defaultdict(float)
for path, ms in leaves.items():
    roots[path[0]] += ms
# Check clock alignment against host request envelopes when available.
clock_violations = []
unmatched_phases = 0
for event in active_events:
    if event['kind'] != 'vm':
        continue
    envelopes = [e for e in data['events'] if e['kind'] == 'worker-request'
                 and e.get('pid') == event.get('pid') and e['name'] == event['request']
                 and e['start'] < event['end'] + 1 and e['end'] > event['start'] - 1]
    if envelopes:
        best = min(max(0, e['start']-event['start'], event['end']-e['end']) for e in envelopes)
        clock_violations.append(best)
    else:
        unmatched_phases += 1
summary = {
    'trial': window['trial'], 'totalMs': total,
    **({'label': args.label} if args.label else {}),
    'trialElapsedMs': [w['end']-w['start'] for w in windows],
    'selectedBy': 'explicit trial' if args.trial is not None else 'median elapsed-time trial',
    'results': next(r for r in data['results'] if r['trial'] == window['trial']),
    'wallPartition': [{'name': name, 'ms': ms, 'percent': ms/total*100} for name, ms in roots.items()],
    'causalStages': dict(stage_totals),
    'filesystemIntervals': grouped('filesystem', ['file', 'name']),
    'syscalls': grouped('syscall', ['file', 'name']),
    'workerPhases': grouped('vm', ['request', 'name']),
    'protocolInbound': dict(Counter(e['frameType'] for e in active_events if e['kind'] == 'worker-request' and e.get('frameType'))),
    'protocolOutbound': dict(Counter(op for e in active_events if e['kind'] == 'worker-request' for op in e.get('outbound') or [])),
    'hostSpans': grouped('host', ['name']),
    'maxWorkerPhaseOutsideRequestMs': max(clock_violations, default=0),
    'unmatchedWorkerPhases': unmatched_phases,
    'leaves': [{'path': list(path), 'ms': ms} for path, ms in leaves.items()],
    **({'segments': segments} if args.segments else {}),
    'notes': [
        'Sunburst sectors partition elapsed wall time. Concurrent filesystem and VM work occupies its own sector.',
        'Filesystem and VM diagnostic totals include that overlap and must not be summed together.',
        'Worker phases are elapsed intervals, not CPU samples. Execution includes promise jobs; finalizer callbacks are measured separately from collector time.',
        'Other / unmeasured retains IPC, scheduling, profiling overhead and uninstrumented host work; no CPU attribution is inferred.',
        'Endpoint requires send acceptance and pushed inbox state; it excludes HTTP and browser rendering.',
        'High-resolution cross-process epoch clocks are checked against host request envelopes; interpret sub-millisecond differences cautiously.',
    ],
}
args.output.with_suffix('.json').write_text(json.dumps(summary, indent=2)+'\n')

# Three rings: mutually exclusive wall owner, subsystem/request, fine operation.
W, H, cx, cy = 1400, 1000, 402, 456
parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
         '<title id="title">Colocated mail latency: fine-grained wall-time sunburst</title>',
         '<desc id="desc">Concurrent filesystem and VM work is represented separately, so every millisecond is counted once. Rings show wall owner, subsystem, and operation.</desc>',
         '<rect width="1400" height="1000" fill="#f8fafc"/><g font-family="system-ui, sans-serif">']
def text(x, y, value, size=16, color='#334155', weight='400', anchor='start'):
    parts.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}">{html.escape(value)}</text>')
def shade(color, depth):
    alpha = [0, .17, .33][depth]
    rgb = [int(color[i:i+2], 16) for i in (1,3,5)]
    return '#'+''.join(f'{round(v*(1-alpha)+255*alpha):02x}' for v in rgb)
def arc(begin, ms, inner, outer, color, label):
    a = begin / total*2*math.pi-math.pi/2
    b = (begin+ms) / total*2*math.pi-math.pi/2
    def point(r,t): return f'{cx+r*math.cos(t):.3f},{cy+r*math.sin(t):.3f}'
    large = int(b-a>math.pi)
    d = f'M {point(outer,a)} A {outer},{outer} 0 {large} 1 {point(outer,b)} L {point(inner,b)} A {inner},{inner} 0 {large} 0 {point(inner,a)} Z'
    parts.append(f'<path d="{d}" fill="{color}" stroke="#f8fafc" stroke-width="1"><title>{html.escape(label)}: {ms:.3f} ms ({ms/total*100:.2f}%)</title></path>')
    return (a+b)/2
text(44, 54, args.label or 'Where the mail time goes', 32, weight='650')
selection = f'explicit selection from {len(windows)} sends' if args.trial is not None else f'median of {len(windows)} instrumented sends'
text(44, 86, f'Colocated mailbox · fresh measured send · trial {window["trial"]} · {selection}', 17, '#64748b')
text(44, 114, f'Contact lookup {stage_totals["contact-lookup"]:.1f} ms → Send / notification {stage_totals["send-and-notify"]:.1f} ms', 17, '#64748b')
order = [k for k in root_colors if k in roots]
cursor = 0
for root in order:
    root_ms = roots[root]
    color = root_colors[root]
    arc(cursor, root_ms, 88, 163, color, root)
    root_leaves = {p: v for p,v in leaves.items() if p[0] == root}
    children = list(dict.fromkeys(p[1] for p in root_leaves))
    child_cursor = cursor
    for child in children:
        items = [(p,v) for p,v in root_leaves.items() if p[1] == child]
        child_ms = sum(v for _,v in items)
        angle = arc(child_cursor, child_ms, 166, 242, shade(color,1), root+' / '+child)
        if child_ms/total > .055:
            label = {'Other / unmeasured':'Other','Outbound drain':'Drain','Worker reply gap':'Reply gap','Bridge / IPC gap':'Bridge / IPC'}.get(child,child)
            x,y = cx+205*math.cos(angle),cy+205*math.sin(angle)
            degrees = angle*180/math.pi+90
            if 90 < degrees%360 < 270: degrees += 180
            parts.append(f'<text x="{x:.2f}" y="{y:.2f}" transform="rotate({degrees:.2f} {x:.2f} {y:.2f})" font-size="14" fill="#fff" font-weight="600" text-anchor="middle">{html.escape(label)}</text>')
        leaf_cursor = child_cursor
        for path,ms in items:
            label = path[2] if len(path)>2 else child
            angle = arc(leaf_cursor,ms,245,321,shade(color,2),' / '.join(path))
            if ms/total > .052 and len(label)<27:
                x,y = cx+284*math.cos(angle),cy+284*math.sin(angle)
                degrees = angle*180/math.pi+90
                if 90 < degrees%360 < 270: degrees += 180
                parts.append(f'<text x="{x:.2f}" y="{y:.2f}" transform="rotate({degrees:.2f} {x:.2f} {y:.2f})" font-size="13" fill="#243247" font-weight="600" text-anchor="middle">{html.escape(label)}</text>')
            leaf_cursor += ms
        child_cursor += child_ms
    cursor += root_ms
text(cx,cy-4,f'{total:.1f} ms',27,weight='650',anchor='middle')
text(cx,cy+24,'accepted + inbox ready',12,'#64748b',anchor='middle')
text(785,179,'EXCLUSIVE WALL-TIME SECTORS',15,'#64748b','600')
y = 216
for root in order:
    parts.append(f'<rect x="785" y="{y-13}" width="14" height="14" rx="3" fill="{root_colors[root]}"/>')
    text(813,y,root,18,weight='600')
    text(1348,y,f'{roots[root]:.1f} ms · {roots[root]/total*100:.1f}%',17,anchor='end')
    y += 31
    children = defaultdict(float)
    for path, ms in leaves.items():
        if path[0] == root: children[path[1]] += ms
    for child, ms in sorted(children.items(), key=lambda item:-item[1]):
        if ms < .15: continue
        text(813,y,child,15,'#64748b')
        text(1348,y,f'{ms:.1f} ms',15,'#64748b',anchor='end')
        y += 24
    y += 17
text(44,837,'Read the rings outward: wall-time owner → subsystem / request → operation.',17)
text(44,869,'Filesystem + VM sectors are simultaneous work, not extra time added to either total.',16,'#64748b')
text(44,899,'Other includes IPC, scheduling, instrumentation and host work not covered by explicit spans.',16,'#64748b')
text(44,929,'Execution includes promise jobs. Finalizer callbacks are separate from garbage collection.',16,'#64748b')
text(44,959,'Service endpoint only: HTTP, browser rendering and screen presentation are excluded.',16,'#64748b')
parts.append('</g></svg>')
args.output.with_suffix('.svg').write_text('\n'.join(parts)+'\n')
print(json.dumps({k:summary[k] for k in ['trial','totalMs','wallPartition','causalStages','maxWorkerPhaseOutsideRequestMs']},indent=2))
