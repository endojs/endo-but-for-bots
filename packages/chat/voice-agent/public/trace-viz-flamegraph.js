// trace-viz-flamegraph.js — a Tier-2 trace visualization: an ICICLE / FLAME-CHART of the live reasoning
// trace (time/work × call-depth), drawn with WebGL quad-batches (canvas2d fallback) + a 2D text overlay,
// INSIDE the sandboxed confined.html iframe. A sibling paradigm to the reference trace-viz-3d.js force-graph:
// where the 3D graph shows ORDER/topology, the icicle shows PROPORTION OF EFFORT and NESTING DEPTH at a
// glance ("where did the work go, and what nested inside what"). Same cell contract, same jail, forkable.
//
// WHY A TIER-2 IFRAME (identical to trace-viz-3d.js): the SES no-iframe fork path's sanitizer has NO
// <canvas>/<svg>, so a WebGL view is impossible there. The Tier-2 runtime (public/confined.html) is a UNIQUE
// OPAQUE ORIGIN, sandbox="allow-scripts" with NO allow-same-origin, CSP default-src 'none' (NO network).
// Inside that jail the source gets a REAL <canvas>, real WebGL, requestAnimationFrame — pure, authority-free
// computation. The PARENT holds the cap and brokers the trace cell IN over a private MessagePort; the frame
// never sees the cap and cannot fetch. It never HOLDS a cap; it only receives already-scrubbed render-safe
// frames and re-scrubs defensively (never renders a swissnum/#cap — labels are petname/power only).
//
// FULL CONTRACT (mirror of trace-viz-3d.js + public/confined.html):
//   canvas  = ui.create('canvas').el          RAW canvas; getContext('webgl') || getContext('2d')
//   cell    = ui.grain(ui.props.cell)          ui.props.cell === 'trace:<chatId>'; PARENT brokers it IN
//   animate = requestAnimationFrame            iframe global (typeof-guard so render-check passes)
//   report  = ui.call('vizDiag', {...})        optional host echo (frame count + renderer mode + scrubbed t0)
//   value   = { status:'running'|'done', rev, prompt?, steps:[{name,ok?,status,children?,granted?}], nodes:[{key,parent?,state?}] }
//
// The SOURCE starts with `(ui) =>` (NOT a `//`) so it passes break-out's `(ui)=>element` validation; the
// contract travels inside the body. Kept dense to stay ≤ 16000 chars (the break-out cap) and fully DEFENSIVE:
// render-check.mjs runs it in a Node stub where ui.create().el has no getContext, requestAnimationFrame is
// undefined, and there is no DOM — every environment touch below is typeof-guarded or try/caught.
export const TRACE_VIZ_FLAMEGRAPH_SOURCE = `(ui)=>{
// FLAMEGRAPH trace-viz (Tier-2 iframe; WebGL quads + 2D text overlay, NO net). cell=ui.grain(ui.props.cell)='trace:<chatId>' (parent-brokered, no cap). x=work,y=depth,hue=kind,red-hatch=fail,pulse=running. See trace-viz-flamegraph.js. FORK FREELY.
var RAF=typeof requestAnimationFrame==='function'?requestAnimationFrame:null;
var DPR=typeof devicePixelRatio==='number'&&devicePixelRatio>0?devicePixelRatio:1;
function now(){try{if(typeof performance!=='undefined'&&performance.now)return performance.now();}catch(e){}return Date.now?Date.now():0;}
var wrap=ui.create('div').style({position:'relative',width:'100%'});
var bW=ui.create('canvas').style({display:'block',width:'100%',height:'320px'}),tW=ui.create('canvas').style({position:'absolute',left:'0px',top:'0px',width:'100%',height:'320px',pointerEvents:'none'});
var bc=bW&&bW.el,tc=tW&&tW.el;wrap.push(bW);wrap.push(tW);
var gl=null,g2=null,ov=null,mode='none';
if(bc&&typeof bc.getContext==='function'){try{gl=bc.getContext('webgl',{alpha:true,antialias:true});}catch(e){}if(gl)mode='webgl';else{try{g2=bc.getContext('2d');}catch(e){}if(g2)mode='2d';}}
if(tc&&typeof tc.getContext==='function'){try{ov=tc.getContext('2d');}catch(e){}}
function hx(h){var m=/^#([0-9a-f]{6})$/i.exec(String(h||''));if(!m)return[.49,.36,1];var s=m[1];return[parseInt(s.slice(0,2),16)/255,parseInt(s.slice(2,4),16)/255,parseInt(s.slice(4,6),16)/255];}
var CR=hx('#7c5cff'),CT=hx('#2ea043'),CG=hx('#e3b341'),CS=hx('#58a6ff'),CB=hx('#f85149');
var HEX={root:'#cbbcff',tool:'#7fe0a0',phase:'#e3b341',delegate:'#e3b341',subq:'#9ecbff'};
var POW={notes:'📓',web:'🌐',research:'🔬',browser:'🧭',images:'🎨',editNote:'📝',email:'✉️',roles:'🎭',delegate:'🤝',reference:'📚',specialists:'🧩'};
var DEL={delegateTask:1,askSpecialist:1,research:1,employ:1};
function KO(nm){var s=String(nm||'');if(DEL[s])return'delegate';if(s.charAt(0)==='❓')return'subq';if(/…|^distilled$|^report$|^synthesiz/i.test(s))return'phase';return'tool';}
function CO(k,ok){return ok===false?CB:(k==='delegate'||k==='phase')?CG:k==='subq'?CS:k==='root'?CR:CT;}
function SC(s){s=String(s==null?'':s);try{s=s.replace(/ocapn:\\/\\/[^\\s]+/gi,'⟨cap⟩').replace(/#[A-Za-z0-9_-]{20,}/g,'⟨cap⟩').replace(/[A-Za-z2-7]{40,}/g,'⟨cap⟩');}catch(e){}return s;}
function MD(s,m){s=String(s||'');if(m<3)m=3;if(s.length<=m)return s;var h=Math.max(1,(m-1)>>1);return s.slice(0,h)+'…'+s.slice(s.length-(m-1-h));}
var root,bars=[],maxD=0,rev=0,frames=0,running=true,badge='≡ by count';
function MK(nm,k,ok,run,gr){return{nm:nm,k:k,ok:ok,run:run,gr:gr,kids:[],cnt:1,x:0,w:0,d:0};}
function FS(a,d){var o=[];if(!Array.isArray(a)||d>14)return o;for(var i=0;i<a.length&&i<300;i++){var s=a[i];if(!s||typeof s!=='object')continue;var r=s.name!=null?s.name:s.label,n=MK(SC(r),KO(r),s.ok===false?false:true,s.status==='running'||s.state==='pending',Array.isArray(s.granted)?s.granted:null);n.kids=FS(s.children,d+1);o.push(n);}return o;}
function FN(a){var o=[],i;for(i=0;i<a.length&&i<300;i++){var rn=a[i];if(!rn||typeof rn!=='object')continue;var r=rn.name!=null?rn.name:rn.label!=null?rn.label:'';o.push(MK(SC(r),KO(r),true,rn.state==='pending',null));}return o;}
function WG(n){var s=0,i;for(i=0;i<n.kids.length;i++)s+=WG(n.kids[i]);n.cnt=n.kids.length?s:1;return n.cnt;}
function LY(n,x,w){n.x=x;n.w=w;var t=0,i;for(i=0;i<n.kids.length;i++)t+=n.kids[i].cnt;if(t<=0)t=n.kids.length||1;var c=x;for(i=0;i<n.kids.length;i++){var k=n.kids[i],kw=w*(k.cnt/t);LY(k,c,kw);c+=kw;}}
function FLT(n,d){if(d>maxD)maxD=d;n.d=d;bars.push(n);for(var i=0;i<n.kids.length;i++)FLT(n.kids[i],d+1);}
function build(v){
if(!v||typeof v!=='object')v={};
running=v.status!=='done';rev=typeof v.rev==='number'?v.rev:rev+1;
var st=Array.isArray(v.steps)?v.steps:[],kids=st.length?FS(st,0):Array.isArray(v.nodes)?FN(v.nodes):[];
var pr=SC(v.prompt!=null?v.prompt:v.title!=null?v.title:'this turn');
root=MK(MD(pr,80)||'waiting for the first step…','root',true,running&&!kids.length,null);root.kids=kids;
WG(root);LY(root,0,1);bars=[];maxD=0;FLT(root,0);
var hn=false,i;for(i=0;i<bars.length;i++)if(bars[i].kids.length){hn=true;break;}
badge=hn?'▦ by work':'≡ by count';frames++;
try{if(typeof ui.call==='function')ui.call('vizDiag',{rev:rev,frames:frames,mode:mode,steps:st.length,t0:MD(root.nm,60)});}catch(e){}
}
var cid=ui.props&&ui.props.cell?String(ui.props.cell):'';
if(cid){try{ui.grain(cid).subscribe(function(v){try{build(v);}catch(e){}});}catch(e){}}
if(!RAF||mode==='none')return wrap;
var W=1,H=1,RH=1,GAP=0,MW=2,shown=0;
function I(c){return Math.round(c*255);}
function fit(){var a=bc.clientWidth||320,b=bc.clientHeight||320,nw=Math.max(1,Math.round(a*DPR)),nh=Math.max(1,Math.round(b*DPR));if(nw!==W||nh!==H){W=nw;H=nh;bc.width=W;bc.height=H;if(tc){tc.width=W;tc.height=H;}if(gl)gl.viewport(0,0,W,H);}RH=H/(maxD+1);GAP=Math.min(3*DPR,RH*0.16);MW=2*DPR;}
var gi=false,PR,ap,ac,buf;
function sh(t,s){var x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);return x;}
function iG(){if(gi||!gl)return;gi=true;PR=gl.createProgram();gl.attachShader(PR,sh(gl.VERTEX_SHADER,'attribute vec2 p;attribute vec4 c;varying vec4 vc;void main(){gl_Position=vec4(p,0.,1.);vc=c;}'));gl.attachShader(PR,sh(gl.FRAGMENT_SHADER,'precision mediump float;varying vec4 vc;void main(){gl_FragColor=vc;}'));gl.linkProgram(PR);ap=gl.getAttribLocation(PR,'p');ac=gl.getAttribLocation(PR,'c');buf=gl.createBuffer();}
function VT(pw){var A=[],lim=Math.ceil(shown),i;for(i=0;i<bars.length&&i<lim;i++){var n=bars[i],x0=n.x*W,x1=Math.max(x0+MW,(n.x+n.w)*W),y0=n.d*RH,y1=y0+Math.max(2,RH-GAP),pt=i===lim-1?shown-(lim-1):1;if(pt<0)pt=0;var c=CO(n.k,n.ok),a=(n.run?pw:0.95)*pt,ax=x0/W*2-1,bx=x1/W*2-1,ay=1-y0/H*2,by=1-y1/H*2,r=c[0],g=c[1],b=c[2];A.push(ax,ay,r,g,b,a,bx,ay,r,g,b,a,bx,by,r,g,b,a,ax,ay,r,g,b,a,bx,by,r,g,b,a,ax,by,r,g,b,a);}return A;}
function dG(A){iG();gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);if(!A.length)return;gl.useProgram(PR);gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(A),gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(ap);gl.vertexAttribPointer(ap,2,gl.FLOAT,false,24,0);gl.enableVertexAttribArray(ac);gl.vertexAttribPointer(ac,4,gl.FLOAT,false,24,8);gl.drawArrays(gl.TRIANGLES,0,A.length/6);}
function HA(c,x,y,w,h){try{c.save();c.beginPath();c.rect(x,y,w,h);c.clip();c.strokeStyle='rgba(255,255,255,0.4)';c.lineWidth=Math.max(1,DPR);for(var d=-h;d<w;d+=6*DPR){c.beginPath();c.moveTo(x+d,y+h);c.lineTo(x+d+h,y);c.stroke();}c.restore();}catch(e){}}
function TX(c,fb,pw){if(!c)return;c.clearRect(0,0,W,H);var lim=Math.ceil(shown),i,fs=Math.max(9,Math.min(13,RH*0.5));c.textBaseline='middle';c.font=fs+'px system-ui,sans-serif';for(i=0;i<bars.length&&i<lim;i++){var n=bars[i],x0=n.x*W,bw=Math.max(MW,(n.x+n.w)*W-x0),y0=n.d*RH,bh=Math.max(2,RH-GAP),pt=i===lim-1?shown-(lim-1):1;if(pt<0)pt=0;if(fb){var c2=CO(n.k,n.ok);c.globalAlpha=(n.run?pw:0.95)*pt;c.fillStyle='rgb('+I(c2[0])+','+I(c2[1])+','+I(c2[2])+')';c.fillRect(x0,y0,bw,bh);c.globalAlpha=1;}if(n.ok===false)HA(c,x0,y0,bw,bh);if(bw>26*DPR&&bh>10*DPR){var pd=4*DPR,tx=x0+pd;if(n.gr&&n.gr.length&&bw>44*DPR){var g='',j;for(j=0;j<n.gr.length&&j<3;j++)g+=POW[n.gr[j]]||'🔑';c.fillStyle='#fff';c.fillText(g,tx,y0+bh/2);tx+=c.measureText(g).width+pd;}c.fillStyle=n.ok===false?'#ffb4ae':HEX[n.k]||'#7fe0a0';var mc=Math.max(1,Math.floor((bw-(tx-x0)-pd)/(fs*0.55)));c.fillText(MD(n.nm,mc),tx,y0+bh/2);}}c.font=Math.max(9,11*DPR)+'px system-ui,sans-serif';c.textAlign='right';c.fillStyle='#c9d1d9';c.fillText(badge+(running?' · live':''),W-8*DPR,12*DPR);c.textAlign='left';}
function frame(){if(!RAF)return;try{fit();if(bars.length){var tg=bars.length;if(shown<tg)shown+=Math.max(0.6,(tg-shown)*0.16);if(shown>tg)shown=tg;var pw=0.5+0.28*(0.5+0.5*Math.sin(now()/1000*5));if(mode==='webgl'){dG(VT(pw));TX(ov,false,pw);}else TX(g2,true,pw);}}catch(e){}RAF(frame);}
RAF(frame);return wrap;
}`;

export const TRACE_VIZ_FLAMEGRAPH_NAME = 'Trace flame graph (icicle)';
export const TRACE_VIZ_FLAMEGRAPH_CELLS = ['trace:<chatId>'];

// ── SPLASH sample (gallery card preview) ────────────────────────────────────────────────────────────────
// Convention: a trace-viz module exports `<PREFIX>_SPLASH` — a CANNED trace-cell VALUE (the exact
// `{status,rev,prompt,steps[]}` shape a live `trace:<chatId>` cell pushes) that the gallery feeds the source
// through the SAME MessagePort path (no server cell, no cap) to preview what this view is good at. The
// reference trace-viz-3d.js ships no splash; this establishes the convention for the gallery-assembly worker:
// read `<module>.<NAME>_SPLASH`; if absent, fall back to grain-ui's dummyForCell. status:'done' so it renders
// instantly and rests after the build-in sweep. Scenario: "compare 3 vector DBs → recommendation" — the gold
// `research` bar is visibly the widest (the long pole), with one retry (red-hatch + green) under the middle
// sub-question, 4 levels of clean nesting, and a granted 📝 on the final editNote bar.
export const TRACE_VIZ_FLAMEGRAPH_SPLASH = {
  status: 'done',
  rev: 12,
  prompt: 'Compare 3 vector DBs → recommendation',
  steps: [
    { name: 'notes', ok: true, status: 'done' },
    {
      name: 'research',
      ok: true,
      status: 'done',
      children: [
        {
          name: '❓ pgvector at our scale?',
          status: 'done',
          children: [
            { name: 'web: search', ok: true, status: 'done' },
            { name: 'web: fetch benchmark', ok: true, status: 'done' },
          ],
        },
        {
          name: '❓ Qdrant vs Weaviate ops cost?',
          status: 'done',
          children: [
            { name: 'web: search', ok: false, status: 'done' },
            { name: 'web: search', ok: true, status: 'done' },
            { name: 'browser: read pricing page', ok: true, status: 'done' },
          ],
        },
        {
          name: '❓ Milvus HA story?',
          status: 'done',
          children: [{ name: 'web: fetch docs', ok: true, status: 'done' }],
        },
      ],
    },
    { name: 'distilled', ok: true, status: 'done' },
    { name: 'editNote', ok: true, status: 'done', granted: ['editNote'] },
  ],
};
