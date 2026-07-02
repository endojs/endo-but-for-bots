// trace-viz-provenance.js — a Tier-2 trace visualization: the PROVENANCE / CAUSALITY DAG. A SIBLING of
// public/trace-viz-3d.js (the reference), honoring the EXACT same confined `(ui) => element` contract, so it
// drops into the same viz gallery / break-out / fork substrate and is fed the same `trace:<chatId>` cell.
//
// WHAT IT ANSWERS (vs the reference's "shape of the reasoning"): *WHY this answer — on what evidence and
// under what AUTHORITY does the final conclusion rest?* It draws the lineage left→right toward a
// right-anchored ANSWER node: which tool results / sub-agent verdicts / retrieved data actually flowed into
// the conclusion (consumption), and — first-class here — which CAPABILITIES (`steps[].granted[]`) authorized
// each step. A failed tool that was correctly NOT used renders red with NO consumed edge into the answer, and
// any node with no path to the answer (unused retrieval) is dimmed. Full paradigm: designs/trace-viz-provenance-dag.md.
//
// WHY A TIER-2 IFRAME (same as trace-viz-3d.js): the SES no-iframe renderer's sanitizer has no <canvas>/<svg>,
// so a graphical trace view needs the opaque-origin confined.html runtime — sandbox="allow-scripts" with NO
// allow-same-origin, CSP default-src 'none' (NO network). Inside that jail the source gets a REAL <canvas>
// (ui.create('canvas').el) and requestAnimationFrame — pure, authority-free compute. The PARENT holds the cap
// and brokers the trace cell IN over a private MessagePort; the frame never sees a cap and cannot fetch.
// Layout (longest-path layering) + consumption-edge INFERENCE are pure functions of the render-safe snapshot.
// Fully DEFENSIVE: render-check.mjs runs it in a Node stub where ui.create().el has no getContext,
// requestAnimationFrame is undefined, and there is no DOM — it must not throw and must return an element.
// ≤ 16000 chars (break-out cap).
//
// RENDERER: canvas2d, colorblind-considered. color = PROV kind (blue step, violet sub-agent, teal data, amber
// capability, light-violet answer); diamond = capability, ring = answer, red stroke = failed. EDGE STYLE is
// load-bearing and honest: SOLID = asserted (produced / spawned / granted), DASHED = INFERRED consumed (from
// result→argument token matching — a guess, drawn as one), dotted-amber = granted (authority). Consumption
// inference is the strongest rule only (distinctive shared token in an earlier result and a later call).
// Failed-tool results are tokenized too (they get no data node): if a downstream call reuses a failed result's
// token, the red failed node draws a consumed edge INTO the answer — the "failed-tool-laundered-into-a-
// conclusion" defect this view exists to surface (exposed as badIntoAnswer in the vizDiag echo; see the test).
// Capability nodes float in a top gutter lane above the step they authorize (authority "raining down").
// (WebGL for very large graphs, per-kind PROV shapes, richer inference rules, and hover focus-ancestry are the
// spec's next layers, deferred here to fit the 16000-char confinement cap; a fork can add any of them on this
// same contract — that is the point of the break-out substrate.)
//
// CAP HYGIENE (stack-wide `cap_hygiene_no_render`): capability nodes + granted edges show the power NAME only
// (`email-send`, `contacts`) — the SHAPE of authority, never a swissnum/#cap. This view REVEALS; it never
// grants or revokes (read-only). It renders no secret into DOM/label/tooltip.
//
// SPLASH CONVENTION (introduced here; mirrors trace-viz-3d's gallery-tile need): a viz that wants an offline
// gallery tile ships (a) a named `*_SPLASH` export = a canned render-safe cell VALUE and (b) a sibling
// `<basename>.splash.json` with the same object (for non-JS/gallery readers). The tile mounts the viz with
// `ui.props.splash = <that value>`; with NO live cell + NO port the source renders the canned frame at once.
// See TRACE_VIZ_PROVENANCE_SPLASH + trace-viz-provenance.splash.json.
//
// FULL CONTRACT (also in trace-viz-3d.js header + public/confined.html):
//   canvas  = ui.create('canvas').el          RAW canvas node; getContext('2d')
//   cell    = ui.grain(ui.props.cell)          ui.props.cell === 'trace:<chatId>'; PARENT brokers it IN
//   splash  = ui.props.splash                  optional canned cell VALUE for an offline gallery tile
//   animate = requestAnimationFrame            iframe global (typeof-guard so render-check passes)
//   report  = ui.call('vizDiag', {...})        host echo (frames + mode; also graph summary for tests)
export const TRACE_VIZ_PROVENANCE_SOURCE = `(ui) => {
// PROVENANCE DAG (Tier-2 iframe; canvas2d, NO net). WHY-this-answer: layered L->R to right-anchored ANSWER; color=kind;
// SOLID=asserted, DASHED=inferred consumed, amber-dotted=granted; red=failed(+NO edge in); dim=unused. NAMES only.
var RAF=(typeof requestAnimationFrame==='function')?requestAnimationFrame:null,GCS=(typeof getComputedStyle==='function')?getComputedStyle:null,DPR=(typeof devicePixelRatio==='number'&&devicePixelRatio>0)?Math.min(devicePixelRatio,2):1;
var wrap=ui.create('div').style({position:'relative',width:'100%'}),cw=ui.create('canvas').style({display:'block',width:'100%',height:'320px'}),cv=cw&&cw.el; wrap.push(cw);
function cvar(n,f){ try{ if(!GCS)return f; var v=GCS(document.documentElement).getPropertyValue(n); return (v&&v.trim())||f; }catch(e){ return f; } }
var C={step:cvar('--acc','#7c5cff'),agent:'#c491ff',data:cvar('--acc2','#39d3ff'),cap:'#f5b642',answer:'#a99cff',bad:cvar('--trace-bad','#ff7d7d'),txt:cvar('--fg','#e9e9f2'),ed:'#8b8bb4'};
function clip(s,n){ s=String(s==null?'':s).replace(/[\\u0000-\\u001f]+/g,' ').trim(); return s.length>n?s.slice(0,n-1)+'\\u2026':s; }
var SW={the:1,and:1,for:1,with:1,that:1,this:1,from:1,http:1,https:1,www:1};
function tks(s){ s=String(s||'').toLowerCase(); var o={},m,c=0,re=/https?:\\/\\/\\S+|[a-z0-9_.\\-]+\\/[a-z0-9_.\\-\\/]+|#\\d{2,}|\\b\\d{4,}\\b|[a-z][a-z0-9_\\-]{5,}/g; while((m=re.exec(s))&&c<40){ var t=m[0]; if(t.length>=4&&!SW[t]){o[t]=1;c++;} } return o; }
function sh(a,b){ if(a&&b)for(var k in a)if(b[k])return k; return null; }
var mode='none',g=null,fr=0,W=1,H=1,G={N:[],E:[],K:{},maxL:0,ans:null,note:'',dirty:true};
function build(v){
if(!v||typeof v!=='object')return; var N=[],E=[],K={};
function nd(k,o){ if(K[k])return K[k]; var n={key:k,kind:'step',lab:k,st:'done',ok:true,L:0,orph:false,ans:false,gut:false,ix:0}; for(var p in o)n[p]=o[p]; K[k]=n; N.push(n); return n; }
function ed(a,b,t,inf,cf){ if(K[a]&&K[b]&&a!==b)E.push({a:a,b:b,t:t,inf:!!inf,cf:cf==null?1:cf}); }
var st=Array.isArray(v.steps)?v.steps:[],L=Math.min(st.length,200),ai=-1,i,rt=[];
for(i=L-1;i>=0;i--){ if(/^(answer|final|respond)/i.test(String((st[i]||{}).name||''))&&(st[i]||{}).ok!==false){ai=i;break;} }
if(ai<0)for(i=L-1;i>=0;i--)if((st[i]||{}).ok!==false){ai=i;break;}
for(i=0;i<L;i++){ var s=st[i]||{},A=i===ai,ks=Array.isArray(s.children)?s.children:[];
var kd=A?'answer':((ks.length||/agent|delegate|special|reader|verify|judge/i.test(String(s.name||'')))?'agent':'step');
nd('s'+i,{kind:kd,lab:clip(s.name||('step '+i),16),st:s.status==='running'?'run':(s.ok===false?'fail':'done'),ok:s.ok!==false,ans:A,ix:i});
var hr=s.result!=null&&String(s.result).trim()!==''&&!A;
if(hr&&s.ok!==false){ nd('d'+i,{kind:'data',lab:clip(s.result,16),ix:i+0.5}); ed('s'+i,'d'+i,'prod'); }
rt[i]=hr?tks(s.result):null;
for(var c=0;c<ks.length&&c<6;c++){ nd('s'+i+'c'+c,{kind:'agent',lab:clip((ks[c]||{}).name||'sub-agent',18),ix:i+0.1}); ed('s'+i,'s'+i+'c'+c,'spawn'); }
var gr=Array.isArray(s.granted)?s.granted:[]; for(var gj=0;gj<gr.length&&gj<6;gj++){ var gn=clip(gr[gj],16); nd('c:'+gn,{kind:'cap',lab:gn,gut:true}); ed('c:'+gn,'s'+i,'grant'); }
}
for(var j=0;j<L;j++){ var sj=st[j]||{},ct=tks((sj.call!=null?sj.call:'')+' '+(sj.detail!=null?sj.detail:'')),k; // rule 1: result->arg token match => INFERRED consumed edge
for(k=0;k<j;k++)if(rt[k]&&sh(rt[k],ct))ed(K['d'+k]?'d'+k:'s'+k,'s'+j,'use',true,0.9);
}
if(v.truncated)nd('more',{kind:'step',lab:'+ more (truncated)',st:'ghost'});
var rn=Array.isArray(v.nodes)?v.nodes:[]; for(var r=0;r<rn.length&&r<200;r++){ var R=rn[r]||{},rk='n'+(R.key!=null?R.key:r); nd(rk,{kind:R.kind==='agent'?'agent':(/source|doc|result/.test(String(R.kind))?'data':'step'),lab:clip(R.label||R.key||'node',20),st:R.state==='fail'?'fail':(R.state==='running'?'run':'done')}); if(R.parent!=null&&K['n'+R.parent])ed('n'+R.parent,rk,'deriv',true,0.5); }
var fl=E.filter(function(e){return e.t!=='grant';});
for(var it=0;it<N.length+2;it++){ var ch=false; for(var e=0;e<fl.length;e++){ var a=K[fl[e].a],b=K[fl[e].b]; if(a&&b&&b.L<a.L+1){b.L=a.L+1;ch=true;} } if(!ch)break; }
var mx=0; for(i=0;i<N.length;i++)if(!N[i].gut&&N[i].L>mx)mx=N[i].L; if(ai>=0&&K['s'+ai])K['s'+ai].L=mx;
var rc={}; if(K['s'+ai]){ var adj={},q=['s'+ai]; rc['s'+ai]=1; for(var e2=0;e2<E.length;e2++)(adj[E[e2].b]=adj[E[e2].b]||[]).push(E[e2].a); while(q.length){ var u=q.pop(),I=adj[u]||[]; for(var z=0;z<I.length;z++)if(!rc[I[z]]){rc[I[z]]=1;q.push(I[z]);} } }
var bad=false,caps=0,fails=0; for(i=0;i<N.length;i++){ var n=N[i]; if(!n.gut&&!n.ans)n.orph=!rc[n.key]&&(n.L>0||n.st==='fail'); if(n.kind==='cap')caps++; if(n.st==='fail'){fails++; if(rc[n.key])bad=true;} }
G.note=v.truncated?'truncated':''; G.N=N;G.E=E;G.K=K;G.maxL=mx;G.ans=ai>=0?'s'+ai:null;G.dirty=true;
try{ if(typeof ui.call==='function')ui.call('vizDiag',{frames:fr,rev:(typeof v.rev==='number')?v.rev:0,mode:mode,steps:st.length,nodes:N.length,edges:E.length,caps:caps,fails:fails,badIntoAnswer:bad}); }catch(e){}
}
var cid=(ui.props&&ui.props.cell)?String(ui.props.cell):'',got=false;
if(cid){ try{ ui.grain(cid).subscribe(function(v){ try{ if(v){got=true;build(v);} }catch(e){} }); }catch(e){} }
try{ var sp=ui.props&&ui.props.splash; if(sp&&typeof sp==='object'&&!got)build(sp); }catch(e){}
if(!RAF||!cv||typeof cv.getContext!=='function')return wrap;
try{ g=cv.getContext('2d'); if(g)mode='2d'; }catch(e){}
function fit(){ var a=cv.clientWidth||520,b=cv.clientHeight||320,nw=Math.max(1,Math.round(a*DPR)),nh=Math.max(1,Math.round(b*DPR)); if(nw!==W||nh!==H){W=nw;H=nh;cv.width=W;cv.height=H;G.dirty=true;} }
function pos(){ var M=Math.max(38,W*0.07),gu=H*0.15,tp=gu+H*0.05,bt=H*0.82,co=G.maxL+1,cd=co>1?(W-2*M)/(co-1):0,pc={},i;
for(i=0;i<G.N.length;i++){ var n=G.N[i]; if(!n.gut)(pc[n.L]=pc[n.L]||[]).push(n); }
for(var Lk in pc){ var ar=pc[Lk]; ar.sort(function(a,b){return (a.orph-b.orph)||(a.ix||0)-(b.ix||0);}); var x=co>1?(M+Lk*cd):W/2,rw=ar.length; for(var r=0;r<rw;r++){ ar[r].x=x; ar[r].y=rw>1?(tp+(bt-tp)*(r/(rw-1))):(tp+bt)/2; } }
var sn={}; for(i=0;i<G.E.length;i++){ if(G.E[i].t!=='grant')continue; var ca=G.K[G.E[i].a],tb=G.K[G.E[i].b]; if(!ca||!tb)continue; var ix=sn[tb.key]=(sn[tb.key]||0); sn[tb.key]++; ca.x=(tb.x||W/2)-(ix?ix*66:0); ca.y=gu*0.55; }
}
function dia(x,y,r){ g.beginPath();g.moveTo(x,y-r);g.lineTo(x+r,y);g.lineTo(x,y+r);g.lineTo(x-r,y);g.closePath(); }
function shp(n,R){ if(n.kind==='cap'){dia(n.x,n.y,R);}else{g.beginPath();g.arc(n.x,n.y,R,0,6.29);} }
function draw(){ var S=DPR,i,e; g.clearRect(0,0,W,H); g.lineJoin='round';
for(e=0;e<G.E.length;e++){ var o=G.E[e],A=G.K[o.a],B=G.K[o.b]; if(!A||A.x==null||!B||B.x==null)continue; var gt=o.t==='grant'; g.strokeStyle=gt?C.cap:C.ed; g.globalAlpha=(A.orph||B.orph?0.35:1)*(gt?0.85:(o.inf?0.22+o.cf*0.5:0.7)); g.lineWidth=(gt?1:1.3)*S; if(g.setLineDash)g.setLineDash(gt?[2*S,4*S]:(o.inf?[6*S,5*S]:[])); g.beginPath();g.moveTo(A.x,A.y);g.lineTo(B.x,B.y);g.stroke(); }
g.globalAlpha=1; if(g.setLineDash)g.setLineDash([]);
for(i=0;i<G.N.length;i++){ var n=G.N[i]; if(n.x==null)continue; var bd=n.st==='fail',dm=n.orph||n.st==='run'||n.st==='ghost',R=(n.ans?13:(n.kind==='cap'?8:10))*S,col=C[n.kind]||C.step;
g.globalAlpha=dm?0.42:0.95; g.fillStyle=col; shp(n,R); g.fill();
g.globalAlpha=dm?0.55:1; g.lineWidth=(n.ans?2.4:1.4)*S; g.strokeStyle=bd?C.bad:(n.ans?C.answer:col); shp(n,R); g.stroke();
if(n.ans){ g.globalAlpha=0.55; g.beginPath();g.arc(n.x,n.y,R+5*S,0,6.29);g.stroke(); }
g.globalAlpha=dm?0.6:1; g.fillStyle=C.txt; g.font=(n.ans?11:9.5)*S+'px system-ui'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(String(n.lab||''),n.x,n.y+R+9*S);
}
g.globalAlpha=1; g.textAlign='left'; g.fillStyle=C.ed; g.font=9.5*S+'px system-ui'; g.fillText('\\u2504 inferred \\u2508 granted'+(G.note?'  \\u2022 '+G.note:''),8*S,H-8*S);
if(!G.N.length){ g.textAlign='center'; g.fillText('no trace yet',W/2,H/2); }
}
function loop(){ if(!RAF)return; try{ fit(); if(G.dirty){pos();G.dirty=false;} fr++; if(mode==='2d')draw(); }catch(e){} RAF(loop); }
RAF(loop); return wrap;
}`;

export const TRACE_VIZ_PROVENANCE_NAME = 'Provenance DAG (why this answer)';
export const TRACE_VIZ_PROVENANCE_CELLS = ['trace:<chatId>'];

// The canned gallery-tile trace (see designs/trace-viz-provenance-dag.md §5): a council-meeting task with
// (1) a 503'd fetch that renders red with NO consumed edge into the answer, (2) a delegation whose verdict
// WAS used, (3) the email-send/contacts CAPABILITIES the answer depended on. Fed via ui.props.splash; also
// mirrored in trace-viz-provenance.splash.json (the splash convention documented in this file's header).
export const TRACE_VIZ_PROVENANCE_SPLASH = {
  turn: 1,
  status: 'done',
  rev: 22,
  truncated: false,
  steps: [
    { i: 0, name: 'plan', status: 'done', ok: true, detail: 'find meeting status, then draft reminder' },
    {
      i: 1, name: 'web.search', status: 'done', ok: true,
      call: '"Millbrook council" agenda Thursday',
      result: '3 hits: council.gov/agenda-2214, patch.com/millbrook-council, cached patch.com/millbrook-council',
    },
    {
      i: 2, name: 'web.fetch', status: 'done', ok: false,
      call: 'council.gov/agenda-2214',
      result: 'ERR 503 upstream — empty body',
    },
    {
      i: 3, name: 'web.fetch', status: 'done', ok: true,
      call: 'patch.com/millbrook-council',
      result: 'meeting MOVED to Friday 7pm, agenda #2214',
    },
    {
      i: 4, name: 'delegate:verify', status: 'done', ok: true,
      call: 'confirm agenda #2214 date',
      detail: 'cross-check date',
      children: [{ name: 'reader', detail: 'confirms Friday per patch + calendar cache' }],
      result: 'CONFIRMED: Friday, not Thursday, agenda #2214',
    },
    {
      i: 5, name: 'answer', status: 'done', ok: true,
      call: 'draft reminder for agenda #2214',
      result: 'Meeting moved to Friday 7pm — reminder ready to send',
      granted: ['email-send', 'contacts'],
    },
  ],
  nodes: [],
};
