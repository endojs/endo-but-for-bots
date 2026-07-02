// trace-viz-timeline.js — a Tier-2 trace visualization: the "Critical Path" swimlanes + waterfall view.
// The 2-D, time-first sibling of the 3-D pendant (public/trace-viz-3d.js): horizontal lanes per agent /
// sub-agent, tool spans placed in time, fork/join connectors for sub-agent spawn+return, and the chain that
// DETERMINED completion time lit as a bright ribbon while slack lanes dim.
//
// SAME TIER-2 CONTRACT as trace-viz-3d.js (see that file's header for the full rationale). It runs INSIDE
// public/confined.html: a UNIQUE OPAQUE ORIGIN, sandbox="allow-scripts" (NO allow-same-origin), CSP
// default-src 'none' (NO network). Inside that jail the source gets a REAL <canvas> (ui.create('canvas').el),
// real WebGL, and requestAnimationFrame — pure, authority-free computation. The PARENT holds the cap and
// brokers the trace cell IN over a private MessagePort; the frame never sees the cap and cannot fetch.
//
//   canvas  = ui.create('canvas').el          RAW canvas node; getContext('webgl') || getContext('2d')
//   cell    = ui.grain(ui.props.cell)          ui.props.cell === 'trace:<chatId>'; PARENT brokers it IN
//   animate = requestAnimationFrame            iframe global (typeof-guard so render-check passes)
//   value   = { turn, status:'running'|'done', progress, rev, truncated,
//               steps:[{ i, name, status, ok?, detail?, children?:[{name,detail}], granted?, t0?, t1?, agent? }],
//               nodes:[{ key, parent?, kind?, label?, state? }] }
//
// Timing is ORDINAL in the real cell (no wall-clock). Concurrency is still recoverable: the set of steps
// `status:'running'` at a rev = what ran in parallel. LIVE regime stamps t0/t1 from observation and gets real
// widths; REPLAY degrades to ordinal x + structural-cost widths (badged "ordinal timing — estimated"). This
// source reads optional numeric `t0`/`t1`/`agent` hints when present (the splash + live regimes) and falls
// back to ordinal packing otherwise; either way it COMPUTES the critical path (a happens-before DAG over
// lane-sequence + fork + join edges, longest weighted path) and lights it.
//
// RENDERING: WebGL instanced unit-quads (one draw call for all span bodies via ANGLE_instanced_arrays) with a
// Canvas2D overlay for ruler / lane labels / fork-join connectors / the critical-path ribbon / span outcome
// borders / labels / the metrics chip. Canvas2D-only fallback when WebGL/instancing is unavailable.
//
// Cap-hygiene (stack-wide law): NAMES only, never a swissnum. All display strings are scrubbed (a #cap-shaped
// or long base32/64 token is masked) and truncated before paint; nothing is ever put in the DOM / a URL / an
// href / the clipboard. `granted[]` would render as power-kind glyphs, never the capability reference.
//
// Keep ≤ 8000 chars (break-out cap) and fully DEFENSIVE: render-check runs it in a Node stub where
// ui.create().el has no getContext, requestAnimationFrame/document/getComputedStyle/devicePixelRatio are
// undefined, and there is no DOM. Every ambient is typeof-guarded; a missing canvas/context returns the
// wrapper without throwing (mode 'none', no loop).
export const TRACE_VIZ_TIMELINE_SOURCE = `(ui)=>{
 // TRACE-VIZ "Critical Path": Tier-2 swimlanes; WebGL instanced quads + 2d overlay, NO net; cell=ui.grain(ui.props.cell)='trace:<chatId>' (NAMES only, no swissnum); critical path lit as a ribbon. Contract: trace-viz-3d.js. FORK FREELY.
 var RAF=typeof requestAnimationFrame=='function'?requestAnimationFrame:null;
 var DPR=typeof devicePixelRatio=='number'&&devicePixelRatio>0?Math.min(2,devicePixelRatio):1;
 var wrap=ui.create('div').style({position:'relative',width:'100%',height:'300px'});
 var gw=ui.create('canvas').style({position:'absolute',left:0,top:0,width:'100%',height:'100%',display:'block'});
 var ow=ui.create('canvas').style({position:'absolute',left:0,top:0,width:'100%',height:'100%',display:'block'});
 var gc=gw&&gw.el,oc=ow&&ow.el,gl=null,ix=null,ov=null,md='none';
 if(gc&&typeof gc.getContext=='function'){try{gl=gc.getContext('webgl')||gc.getContext('experimental-webgl');}catch(e){}if(gl){try{ix=gl.getExtension('ANGLE_instanced_arrays');}catch(e){}}}
 if(oc&&typeof oc.getContext=='function'){try{ov=oc.getContext('2d');}catch(e){}}
 if(gl&&ix&&ov){md='gl';wrap.push(gw);wrap.push(ow);}else if(ov){md='2d';gl=null;wrap.push(ow);}
 var GOLD='rgba(227,179,65,.95)';
 var CR=[.49,.36,1],CD=[.89,.7,.25],CT=[.18,.63,.26],CQ=[.35,.65,1],CB=[.97,.32,.29];
 var DL={delegateTask:1,askSpecialist:1,research:1,employ:1};
 function KD(n){n=''+(n||'');if(DL[n])return'd';if(n.charAt(0)=='❓')return'q';if(/^synthesiz|^distilled$|^report$/i.test(n))return'p';return't';}
 function KC(k){return k=='q'?CQ:k=='d'||k=='p'?CD:CT;}
 function SC(s){s=''+(s==null?'':s);s=s.replace(/#?[A-Za-z0-9_\\-]{22,}/g,'…');return s.length>40?s.slice(0,39)+'…':s;}
 function NM(x){return typeof x=='number'&&isFinite(x)?x:null;}
 function build(v){
  var st=v&&v.steps&&v.steps.length?v.steps:[],K=['orchestrator'],LB={orchestrator:'orchestrator'},S=[],lv=0,i,c;
  function ln(k,l){if(K.indexOf(k)<0){K.push(k);LB[k]=l||k;}return k;}
  for(i=0;i<st.length;i++){var q=st[i]||{};if(NM(q.t0)!=null&&NM(q.t1)!=null)lv=1;}
  for(i=0;i<st.length&&i<200;i++){var s=st[i]||{},k=KD(s.name),L=s.agent?ln(''+s.agent):k=='d'?ln('d'+i,SC(s.detail||s.name)):'orchestrator',kd=s.children&&s.children.length?s.children:null;
   if(k=='d'&&kd&&!s.agent)for(c=0;c<kd.length&&c<40;c++){var h=kd[c]||{};S.push({L:L,n:''+(h.name||'tool'),k:KD(h.name),ok:h.ok!==false,r:0,a:NM(h.t0),b:NM(h.t1)});}
   else S.push({L:L,n:''+(s.name||'step'),k:k,ok:s.ok!==false,r:s.status=='running',a:NM(s.t0),b:NM(s.t1)});}
  var us={};for(i=0;i<S.length;i++)us[S[i].L]=1;K=K.filter(function(k){return us[k];});if(!K.length)K=['orchestrator'];
  var BL={},mn=1e9,mx=-1e9,cur={};
  for(i=0;i<S.length;i++){var s=S[i];if(s.a==null){var cc=cur[s.L]||0;s.a=cc;s.b=cc+(s.k=='p'?1.3:s.k=='d'?1.6:1);}if(s.b==null||s.b<=s.a)s.b=s.a+.4;cur[s.L]=s.b;(BL[s.L]=BL[s.L]||[]).push(s);if(s.a<mn)mn=s.a;if(s.b>mx)mx=s.b;}
  if(mn>mx){mn=0;mx=1;}for(var kk in BL)BL[kk].sort(function(a,b){return a.a-b.a;});
  return crit({K:K,LB:LB,S:S,BL:BL,orc:BL.orchestrator||[],mn:mn,mx:mx,lv:lv,tr:!!(v&&v.truncated)});}
 // critical path for a fork/join turn = every orchestrator span (they run serially) + the heaviest child lane; the rest is slack (float)
 function crit(M){var S=M.S,i,tot=0,osum=0,best=-1,cl=null;
  for(i=0;i<S.length;i++){S[i].p=0;tot+=S[i].b-S[i].a;if(S[i].L=='orchestrator')osum+=S[i].b-S[i].a;}
  for(var k=0;k<M.K.length;k++){var L=M.K[k];if(L=='orchestrator')continue;var ar=M.BL[L]||[],w=0;for(i=0;i<ar.length;i++)w+=ar[i].b-ar[i].a;if(w>best){best=w;cl=L;}}
  if(best<0)best=0;var bn=null;
  for(i=0;i<S.length;i++){if(S[i].L=='orchestrator'||S[i].L==cl)S[i].p=1;if(S[i].L==cl&&(!bn||(S[i].b-S[i].a)>(bn.b-bn.a)))bn=S[i];}
  var cp=0;for(i=0;i<S.length;i++)if(S[i].p)cp++;M.work=tot;M.crit=(osum+best)||1;M.wall=(M.mx-M.mn)||1;M.bn=bn;M.cp=cp;return M;}
 var gI=0,pr,qb,ib,aQ,aR,aC;
 function SH(t,s){var x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);return x;}
 function IG(){if(gI||!gl)return;gI=1;var p=gl.createProgram();gl.attachShader(p,SH(gl.VERTEX_SHADER,'attribute vec2 q;attribute vec4 r;attribute vec4 c;varying vec4 v;void main(){gl_Position=vec4(r.xy+q*r.zw,0.,1.);v=c;}'));gl.attachShader(p,SH(gl.FRAGMENT_SHADER,'precision mediump float;varying vec4 v;void main(){gl_FragColor=v;}'));gl.linkProgram(p);pr=p;aQ=gl.getAttribLocation(p,'q');aR=gl.getAttribLocation(p,'r');aC=gl.getAttribLocation(p,'c');qb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,qb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),gl.STATIC_DRAW);ib=gl.createBuffer();}
 function DG(R){IG();gl.viewport(0,0,W,H);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);if(!R.length)return;var n=R.length/8;gl.useProgram(pr);gl.bindBuffer(gl.ARRAY_BUFFER,qb);gl.enableVertexAttribArray(aQ);gl.vertexAttribPointer(aQ,2,gl.FLOAT,0,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,ib);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(R),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(aR);gl.vertexAttribPointer(aR,4,gl.FLOAT,0,32,0);ix.vertexAttribDivisorANGLE(aR,1);gl.enableVertexAttribArray(aC);gl.vertexAttribPointer(aC,4,gl.FLOAT,0,32,16);ix.vertexAttribDivisorANGLE(aC,1);ix.drawArraysInstancedANGLE(gl.TRIANGLES,0,6,n);}
 var M=null,W=1,H=1;
 function fit(){var nw=Math.max(1,(oc&&oc.clientWidth||600)*DPR|0),nh=Math.max(1,(oc&&oc.clientHeight||300)*DPR|0);if(nw!=W||nh!=H){W=nw;H=nh;gc.width=W;gc.height=H;oc.width=W;oc.height=H;}}
 function ap(v){try{M=build(v);if(ui.call)ui.call('vizDiag',{md:md,ag:M.K.length-1,cp:M.cp,bn:M.bn?SC(M.bn.n):''});}catch(e){}}
 var cid=ui.props&&ui.props.cell?''+ui.props.cell:'';
 if(cid){try{ui.grain(cid).subscribe(function(v){if(v)ap(v);});}catch(e){}}
 var SP={steps:[['scope','orchestrator',0,.2],['web','Jaeger',.4,1.9],['read','Jaeger',1.9,2.4],['web','Zipkin',.4,2.1],['read','Zipkin',2.1,2.7],['web','DevTools',.5,6.2],['read','DevTools',6.2,6.4],['synthesize','orchestrator',6.4,7.6]].map(function(r){return{name:r[0],agent:r[1],t0:r[2],t1:r[3]};})};
 if(!M)ap(SP);
 if(md=='none'||!RAF)return wrap;
 var PL=84*DPR,PT=22*DPR,PR=10*DPR,PB=28*DPR;
 function rgb(c){return'rgb('+(c[0]*255|0)+','+(c[1]*255|0)+','+(c[2]*255|0)+')';}
 function draw(){
  fit();if(!M){RAF&&RAF(draw);return;}
  var mn=M.mn,mx=M.mx,sp=(mx-mn)||1,LN=M.K.length,pw=Math.max(10,W-PL-PR),lh=Math.max(10,(H-PT-PB)/LN),i,l,o=ov;
  var X=function(t){return PL+(t-mn)/sp*pw;},R=[],PX=[];
  for(i=0;i<M.S.length;i++){var s=M.S[i],li=M.K.indexOf(s.L),x=X(s.a),w=Math.max(3*DPR,X(s.b)-x),y=PT+li*lh+3*DPR,h=lh-6*DPR,c=s.ok===false?CB:KC(s.k),al=s.p?.95:.4;R.push(x/W*2-1,1-(y+h)/H*2,w/W*2,h/H*2,c[0],c[1],c[2],al);PX.push({x:x,y:y,w:w,h:h,s:s,c:c,al:al});}
  if(md=='gl')DG(R);else{o.clearRect(0,0,W,H);for(i=0;i<PX.length;i++){var p=PX[i];o.globalAlpha=p.al;o.fillStyle=rgb(p.c);o.fillRect(p.x,p.y,p.w,p.h);}o.globalAlpha=1;}
  if(md=='gl')o.clearRect(0,0,W,H);
  o.textBaseline='middle';o.textAlign='left';o.font=(11*DPR)+'px sans-serif';
  for(l=0;l<LN;l++){o.fillStyle=l==0?rgb(CR):'#e6edf3';o.fillText(SC(M.LB[M.K[l]]),6*DPR,PT+l*lh+lh/2);}
  var pt=[];for(i=0;i<PX.length;i++)if(PX[i].s.p)pt.push(PX[i]);pt.sort(function(a,b){return a.s.a-b.s.a;});
  if(pt.length>1){o.strokeStyle=GOLD;o.lineWidth=3*DPR;o.beginPath();for(i=0;i<pt.length;i++){var qq=pt[i];if(i==0)o.moveTo(qq.x+qq.w/2,qq.y+qq.h/2);else o.lineTo(qq.x+qq.w/2,qq.y+qq.h/2);}o.stroke();}
  for(i=0;i<PX.length;i++){var pp=PX[i];if(pp.s.ok===false){o.strokeStyle='#f85149';o.lineWidth=2*DPR;o.strokeRect(pp.x,pp.y,pp.w,pp.h);}}
  var ag=LN-1,su=M.work/M.crit||1,wx=M.work/M.wall||1,ch=' '+ag+' agents · '+wx.toFixed(1)+'× work · '+su.toFixed(1)+'× speedup'+(M.bn?' · bottleneck: '+SC(M.bn.n)+' ('+(M.bn.b-M.bn.a).toFixed(1)+'s)':'')+(M.tr?' · +truncated':'')+' ';
  var cw=o.measureText(ch).width,cy=H-PB+10*DPR;o.fillStyle='#7c5cff';o.fillRect(W-PR-cw,cy,cw,18*DPR);o.fillStyle='#fff';o.fillText(ch,W-PR-cw,cy+9*DPR);
  RAF&&RAF(draw);}
 RAF(draw);return wrap;
}`;

export const TRACE_VIZ_TIMELINE_NAME = 'Critical Path (swimlanes)';
export const TRACE_VIZ_TIMELINE_CELLS = ['trace:<chatId>'];

// ── SPLASH: the canned gallery-card trace (§5 of the spec) ──────────────────────────────────────
// An orchestrator fans out three research specialists (Jaeger, Zipkin, DevTools); DevTools' web fetch is
// slow and gates the synthesis. The card renders parallelism at a glance, names the bottleneck, and shows a
// computed "N agents · work · speedup" chip. Timing here is illustrative (t0/t1 in seconds) so the card has
// real overlap without a live cell — the component embeds an identical trace inline as its standalone default.
//
// This is the splash CONVENTION for the viz gallery, matching the other viz workers: a `*_SPLASH` export (a
// raw trace snapshot the component understands) PLUS a sibling `<basename>.splash.json` for tooling / the
// gallery to load without importing the module.
export const TRACE_VIZ_TIMELINE_SPLASH = {
  turn: 1,
  status: 'done',
  progress: 'compared Jaeger, Zipkin, and Chrome DevTools critical-path features',
  rev: 24,
  truncated: false,
  steps: [
    { i: 0, name: 'scope', agent: 'orchestrator', status: 'done', ok: true, detail: 'grant research team', t0: 0.0, t1: 0.2, granted: ['research'] },
    { i: 1, name: 'web', agent: 'Jaeger', status: 'done', ok: true, detail: 'critical-path in Jaeger', t0: 0.4, t1: 1.9 },
    { i: 2, name: 'read', agent: 'Jaeger', status: 'done', ok: true, detail: 'docs', t0: 1.9, t1: 2.4 },
    { i: 3, name: 'web', agent: 'Zipkin', status: 'done', ok: true, detail: 'dependency graph', t0: 0.4, t1: 2.1 },
    { i: 4, name: 'read', agent: 'Zipkin', status: 'done', ok: true, detail: 'docs', t0: 2.1, t1: 2.7 },
    { i: 5, name: 'web', agent: 'DevTools', status: 'done', ok: true, detail: 'throttled fetch (slow)', t0: 0.5, t1: 6.2 },
    { i: 6, name: 'read', agent: 'DevTools', status: 'done', ok: true, detail: 'perf panel', t0: 6.2, t1: 6.4 },
    { i: 7, name: 'synthesize', agent: 'orchestrator', status: 'done', ok: true, detail: 'recommend one', t0: 6.4, t1: 7.6 },
  ],
  nodes: [],
};
