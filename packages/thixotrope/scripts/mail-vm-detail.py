#!/usr/bin/env python3
"""Partition nested GC / execution intervals; retain uncovered wall time explicitly."""
import argparse
from collections import defaultdict
import html
import json
import math
from pathlib import Path
import statistics

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('trace', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--trial', type=int)
args = parser.parse_args()
raw = args.trace.read_text()
records = [json.loads(line) for line in raw.splitlines()] if args.trace.suffix == '.jsonl' else None
data = {**records[0], 'events': records[1:]} if records else json.loads(raw)
windows = [w for w in data['trials'] if 'end' in w]
median = statistics.median(w['end']-w['start'] for w in windows)
w = next(w for w in windows if w['trial'] == args.trial) if args.trial is not None else min(windows, key=lambda w:abs(w['end']-w['start']-median))
events = [e for e in data['events'] if e['kind']=='vm' and e['end']>w['start'] and e['start']<w['end']]
parents = [e for e in events if e['name'] in ['garbage-collection','execution-and-jobs','finalizer-callbacks','outbound-extraction']]
details = [e for e in events if e['request']=='detail']
labels = {'gc-admission':'Admission','gc-roots':'Gather roots','gc-borrow-tables':'Borrow tables','gc-clear-seed':'Clear marks / seed', 'gc-mark-edges':'Trace slots / edges','gc-ephemerons':'Ephemeron fixpoint','gc-prune-weak':'Prune weak state','gc-sweep-slots':'Sweep slots','gc-chunk-roots':'Gather chunk roots','gc-compact-chunks':'Compact chunks','gc-rewrite-chunks':'Rewrite chunk holders','gc-prune-late':'Prune late tables','gc-compact-code':'Compact code','gc-compact-reactions':'Compact reactions','gc-side-ledger':'Rederive side ledger','run-initial-script':'Initial script','run-promise-jobs':'Promise job drain','unattributed':'Unattributed / profiler'}
result=[]
for parent in sorted(parents,key=lambda e:e['start']):
 lo,hi=max(parent['start'],w['start']),min(parent['end'],w['end'])
 ds=[e for e in details if e['pid']==parent['pid'] and e['end']>lo and e['start']<hi]
 bounds=sorted({lo,hi,*[max(lo,min(hi,t)) for e in ds for t in [e['start'],e['end']]]})
 totals=defaultdict(float)
 for a,b in zip(bounds,bounds[1:]):
  active=[e for e in ds if e['start']<=(a+b)/2<e['end']]
  # The spans are sibling intervals. Refuse accidental nesting/overlap.
  assert len(active)<=1, active
  totals[active[0]['name'] if active else 'unattributed']+=b-a
 counters=defaultdict(lambda: {'events':0,'count':0,'secondary':0})
 for e in ds:
  c=counters[e['name']];c['events']+=1;c['count']+=e.get('count',0);c['secondary']+=e.get('secondary',0)
 assert abs(sum(totals.values())-(hi-lo))<.001
 result.append({'parent':parent['name'],'pid':parent['pid'],'startMs':lo-w['start'],'ms':hi-lo,'parts':dict(totals),'counters':dict(counters)})
summary={'trial':w['trial'],'totalMs':w['end']-w['start'],'intervals':result,'notes':['Each parent is partitioned exclusively into sibling spans plus explicit unattributed remainder.','Counts are observed slots/edges/jobs, not unique graph edges. Promise drain secondary counts thenable jobs.','GC sweep secondary is arena slot capacity. GC ephemeron count is proposed edges.','Timing excludes per-opcode clocks and per-job clocks. Short intervals include timer/trace overhead.']}
args.output.with_suffix('.json').write_text(json.dumps(summary,indent=2)+'\n')
svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="940" viewBox="0 0 1500 940"><rect width="1500" height="940" fill="#f8fafc"/><g font-family="system-ui,sans-serif" fill="#334155">']
def text(x,y,s,size=16,anchor='start'):svg.append(f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}">{html.escape(s)}</text>')
text(36,45,'Inside the VM: GC rounds and execution / promise jobs',29)
text(36,76,f'Median instrumented send · trial {w["trial"]} · {summary["totalMs"]:.1f} ms accepted + inbox ready',18)
colors=['#7c3aed','#2563eb','#0d9488','#d97706','#be185d','#64748b','#65a30d','#9333ea','#0284c7','#059669','#b45309','#e11d48','#475569','#84cc16','#a855f7','#94a3b8']
for col,(title,names) in enumerate([('Garbage collection',['garbage-collection']),('Execution and jobs',['execution-and-jobs','finalizer-callbacks','outbound-extraction'])]):
 ps=[p for p in result if p['parent'] in names];total=sum(p['ms'] for p in ps);cx=365+col*750;cy=340
 totals=defaultdict(float)
 for p in ps:
  for k,v in p['parts'].items():totals[k]+=v
 keys=sorted(totals,key=lambda k:-totals[k]);color={k:colors[i%len(colors)] for i,k in enumerate(keys)}
 def arc(start,ms,inner,outer,fill,label):
  if ms<=0:return
  a=start/total*2*math.pi-math.pi/2;b=(start+ms)/total*2*math.pi-math.pi/2
  # A tiny gap avoids the SVG full-circle single-arc singularity.
  b=min(b,a+2*math.pi-1e-9)
  def p(r,t):return f'{cx+r*math.cos(t):.3f},{cy+r*math.sin(t):.3f}'
  d=f'M {p(outer,a)} A {outer},{outer} 0 {int(b-a>math.pi)} 1 {p(outer,b)} L {p(inner,b)} A {inner},{inner} 0 {int(b-a>math.pi)} 0 {p(inner,a)} Z'
  svg.append(f'<path d="{d}" fill="{fill}" stroke="#f8fafc"><title>{html.escape(label)}: {ms:.3f} ms</title></path>')
 cursor=0
 for i,p in enumerate(ps):
  arc(cursor,p['ms'],72,130,['#4c1d95','#1e40af','#115e59'][i%3],f'{p["parent"]} {i+1}')
  sub=cursor
  for k,ms in p['parts'].items():arc(sub,ms,133,216,color[k],labels.get(k,k));sub+=ms
  cursor+=p['ms']
 text(cx,cy+5,f'{total:.2f} ms',27,'middle');text(cx-135,110,title,24)
 y=590
 for k in keys:
  if totals[k]<.02:continue
  svg.append(f'<rect x="{col*750+40}" y="{y-13}" width="14" height="14" rx="3" fill="{color[k]}"/>')
  text(col*750+65,y,labels.get(k,k));text(col*750+560,y,f'{totals[k]:.3f} ms');y+=23
text(36,895,'Inner ring: GC round / run interval. Outer ring: exclusive measured subphase. Hover sectors for values.',16)
text(36,925,'Elapsed time, not CPU samples. Unattributed includes scope setup, trace emission, and uninstrumented work.',16)
svg.append('</g></svg>');args.output.with_suffix('.svg').write_text('\n'.join(svg)+'\n')
print(json.dumps(summary,indent=2))
