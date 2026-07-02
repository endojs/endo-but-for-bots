// trace-viz-sankey.js — a Tier-2 confined trace visualization: the SANKEY / AUTHORITY-&-DATA FLOW lens.
//
// This is the ocap-native gallery view: "how a complicated agent task got done" rendered as flowing
// ribbons of DATA and AUTHORITY between the prompt, the granted scope, the entry agent, the tools, the
// sub-agents, and the result. Width = volume/importance; COLOR encodes kind — cyan DATA, amber
// CAPABILITY-GRANT, violet DELEGATION. The ocap thesis made visual: least-authority is a NARROWING
// silhouette (a WIDENING ribbon is a visible red flag), composition is a braid converging on the result.
// Spec: scratchpad/trace-viz-sankey-flow.md. It is also the concrete build of dan's "second lens" — the
// data-flow / trusted-path view (voice-agent/designs/data-flow-trusted-path-view.md): the honest,
// un-spoofable "how were you enabled, and how do you get out" surface. Here it ships as the default
// CONFINED gallery card; promoting the flow-fiber into the host trusted path is future work.
//
// WHY A TIER-2 IFRAME (see public/confined.html): the SES no-iframe sanitizer has no <canvas>/<svg>, so
// WebGL/canvas trace views are impossible there. The Tier-2 runtime is a UNIQUE OPAQUE ORIGIN
// (sandbox="allow-scripts", NO allow-same-origin, CSP default-src 'none' = NO network). Inside that jail
// the source gets a REAL <canvas>, real WebGL, and requestAnimationFrame — all pure, authority-free
// computation. The PARENT holds the cap and brokers the trace cell IN over a private MessagePort; the
// frame never sees the cap and cannot fetch. This view holds NO capability — it visualizes *descriptions*
// of authority (petnames, widths, directions), it never touches authority. Read-only lens; the map, not
// the steering wheel (grant/revoke stay in the Shares panel).
//
// CAP HYGIENE IS CRITICAL HERE (the view is ABOUT capability flow). Three layers: (1) upstream is already
// scrubbed (trace-cells.mjs folds granted[] to PETNAMES, safeText→scrubCaps on call/result/detail);
// (2) this view adds zero cap surface — EVERY node label (and therefore every HOVER TOOLTIP and every
// spatial per-node LABEL, both built from node.label) is run through PET() at build time, uses call /
// result / detail ONLY for numeric widths (never as text), and never concatenates a field into a
// URL/#cap/href/argv/log; (3) BELT-AND-BRACES: PET() refuses any string matching the cap shapes
// (/#cap=|#k=|#agent=|32-hex swissnum/) and renders «redacted» — so even a future un-scrubbed producer
// cannot leak a swissnum through this lens, on ANY surface (labels, tooltips, caption). NEVER render a cap.
//
// INTERACTIONS (work in BOTH WebGL and canvas2d): HOVER a ribbon → a 2D-overlay tooltip "this
// {data|capability|delegation} went from X → Y" (petnames only). PER-NODE spatial labels on the overlay
// (redacted), plus the caption as an accessible text mirror. CLICK a node → isolate its flows (light its
// ribbons, dim the rest); click background → restore. "caps only" toggle → hide cyan DATA ribbons, leaving
// the amber+violet AUTHORITY skeleton. A rev SCRUB slider replays the flow growing hop-by-hop (steps[0..k]).
// A per-ribbon animated sheen shimmers the strands. Pointer x/y arrive canvas-pixel-scaled from confined
// .html's on(); the overlay canvas is pointer-events:none so events reach the main canvas.
//
// ENCODING (exact): NODES origin(You) → scope{granted union} → entry agent → step nodes → delegation
// children → result. RIBBONS: amber GRANT scope→step (strands = granted.length; EXPLICIT); violet
// DELEGATION entry→delegation-step and step→child, width bounded by the authority behind it so it can
// only NARROW (EXPLICIT: verb ∈ {delegateTask,askSpecialist,research,employ} or children present); cyan
// DATA everywhere else, width ∝ log(payload length) (INFERRED). A failed step/node (ok===false /
// state==='fail') tints its ribbons red. `truncated` draws a faint ghost strand into result. Degrades:
// with no granted[] and no children it is an honest data spine; empty/idle → a bare You→… stub.
//
// It starts with `(ui) =>` (NOT a `//` comment) so it passes break-out's `(ui)=>element` validation; a
// short contract note travels INSIDE the body. Keep it ≤ 16000 chars and fully DEFENSIVE: render-check
// runs it in a Node stub where ui.create().el has no getContext, requestAnimationFrame/document/
// getComputedStyle are undefined, and the grain starts undefined — so every ambient global is
// typeof-guarded and the animation loop is never reached there.
//
// FULL CONTRACT (also in public/confined.html + trace-viz-3d.js):
//   canvas = ui.create('canvas').el          RAW canvas node; getContext('webgl') || getContext('2d')
//   cell   = ui.grain(ui.props.cell)          ui.props.cell === 'trace:<chatId>'; PARENT brokers it IN
//   animate= requestAnimationFrame            iframe global (typeof-guard so render-check passes)
//   value  = { turn, status, progress, rev, truncated, agent?,
//              steps:[{ i,name,status,ok?,detail?,call?,result?,children?:[{name,detail}], granted?:[petname] }],
//              nodes:[{ key,parent?,kind?,label?,detail?,state?,info? }] }
export const TRACE_VIZ_SANKEY_SOURCE = `(ui) => {
// TRACE-VIZ SANKEY (Tier-2, WebGL/canvas2d, no net): ocap authority+data flow — cyan DATA / amber GRANT (steps[].granted) / violet DELEGATION; width=volume. HOVER=from→to tooltip, CLICK node=isolate, "caps only"=authority skeleton, rev slider=replay. PET redacts swissnums on every surface. Cell trace:<chatId>.
var M=Math,AA=Array.isArray;
var RAF=(typeof requestAnimationFrame==='function')?requestAnimationFrame:null;
var DPR=(typeof devicePixelRatio==='number'&&devicePixelRatio>0)?devicePixelRatio:1;
var W=1,H=1,SEG=16,t0=0;
var wrap=ui.create('div').style({position:'relative',width:'100%'});
var cw=ui.create('canvas').style({display:'block',width:'100%',height:'320px',cursor:'crosshair'}),canvas=cw&&cw.el;wrap.push(cw);
var ow=ui.create('canvas').style({position:'absolute',left:'0px',top:'0px',width:'100%',height:'320px',pointerEvents:'none'}),ocan=ow&&ow.el;wrap.push(ow);
var bar=ui.create('div').style({display:'flex',alignItems:'center',gap:'10px',marginTop:'6px'});
var capsBtn=ui.create('button').class('cu-btn').text('caps only');bar.push(capsBtn);
var slider=ui.create('input').attr('type','range').attr('min','0').attr('max','1').attr('value','1').style({flex:'1'});bar.push(slider);
wrap.push(bar);
var cap=ui.create('div').class('cu-meta');wrap.push(cap);
var CAPRE=/#cap=|#k=|#agent=|[0-9a-f]{32}/i;
function PET(s){s=String(s==null?'':s);if(CAPRE.test(s))return'«redacted»';return s.length>26?s.slice(0,25)+'…':s;}
var C={data:[.22,.83,1],grant:[.89,.7,.25],deleg:[.49,.36,1],fail:[.97,.32,.29],node:[.71,.55,1],ghost:[.5,.5,.55]};
var gl=null,g2=null,oc=null,mode='none';
if(canvas&&typeof canvas.getContext==='function'){try{gl=canvas.getContext('webgl');}catch(e){}if(gl)mode='webgl';else{try{g2=canvas.getContext('2d');}catch(e){}if(g2)mode='2d';}}
if(ocan&&typeof ocan.getContext==='function'){try{oc=ocan.getContext('2d');}catch(e){}}
var NODES={},RIBS=[],grow={},truncated=false,frames=0,dirty=false,REV=0;
var capsOnly=false,isolated='',hoverI=-1,hoverText='',hoverX=0,hoverY=0,LASTV=null;
var DELEG={delegateTask:1,askSpecialist:1,research:1,employ:1};
function dl(x){return M.max(2,M.min(40,M.log(1+(x||1))*4));}
function isData(rb){return rb.kind==='data'||rb.kind==='ghost';}
function diag(){try{if(typeof ui.call!=='function')return;var td=0,ta=0,li=0,e;for(e=0;e<RIBS.length;e++){var rb=RIBS[e];if(capsOnly&&isData(rb))continue;if(isData(rb))td++;else ta++;if(!isolated||rb.a===isolated||rb.b===isolated)li++;}ui.call('vizDiag',{rev:REV,frames:frames,mode:mode,ribbons:RIBS.length,drawn:td+ta,dataDrawn:td,authDrawn:ta,lit:li,dim:(td+ta)-li,capsOnly:capsOnly,isolated:isolated||'',hover:hoverText||''});}catch(e){}}
function build(v){if(!v||typeof v!=='object')return;REV=v.rev||0;var st=AA(v.steps)?v.steps:[],rn=AA(v.nodes)?v.nodes:[];truncated=!!v.truncated;var N={},R=[],i,j,k;
function nd(id,l,c,ki){return N[id]||(N[id]={id:id,label:PET(l),col:c,kind:ki,fail:false,nx:0,ny:.5});}
function rib(a,b,ki,w,s2,f){if(a&&b)R.push({a:a,b:b,kind:ki,w:w,strands:s2||1,fail:!!f});}
nd('origin','You',0,'io');
var sc={};for(i=0;i<st.length;i++){var gg=st[i]&&st[i].granted;if(AA(gg))for(j=0;j<gg.length;j++)sc[PET(gg[j])]=1;}
var sk=Object.keys(sc);if(sk.length)nd('scope','scope {'+sk.join(' · ')+'}',0,'scope');
nd('entry',v.agent?PET(v.agent):'agent',1,'agent');rib('origin','entry','data',3,1);
var maxC=1;
for(i=0;i<st.length&&i<60;i++){var s=st[i]||{},sid='s'+i,nm=String(s.name||('step'+i)),kids=AA(s.children)?s.children:[],gr=AA(s.granted)?s.granted:[],isD=DELEG[nm]||kids.length,f=s.ok===false;nd(sid,nm,2,isD?'agent':'tool').fail=f;
if(gr.length&&N.scope)rib('scope',sid,'grant',gr.length*6,gr.length,f);
if(isD){var dw=M.min(kids.length||1,gr.length||kids.length||1);rib('entry',sid,'deleg',M.max(6,dw*6),dw,f);}else rib('entry',sid,'data',4,1,f);
var dv=dl((s.result?(''+s.result).length:0)||(s.call?(''+s.call).length:0)||8);
for(k=0;k<kids.length&&k<8;k++){var cid=sid+'c'+k;nd(cid,(kids[k]||{}).name||('tool'+k),3,'tool');rib(sid,cid,'deleg',6,1,f);rib(cid,'result','data',dv,1,f);maxC=3;}
if(!kids.length)rib(sid,'result','data',dv,1,f);if(maxC<2)maxC=2;}
for(k=0;k<rn.length&&k<40;k++){var r=rn[k]||{},rid='n'+(r.key!=null?r.key:k),par=r.parent!=null?'n'+r.parent:'entry',pn=N[par]||N.entry,pc=pn?pn.col+1:2,rf=r.state==='fail';nd(rid,r.label||r.key||('node'+k),pc,'tool').fail=rf;rib(par,rid,'data',4,1,rf);if(pc>maxC)maxC=pc;}
if(st.length||rn.length){nd('result','result',maxC+1,'io');if(truncated)rib('entry','result','ghost',3,1);}
var cols={},id;for(id in N){var o=N[id];(cols[o.col]=cols[o.col]||[]).push(o);}
var mc=0,cc;for(cc in cols)if(+cc>mc)mc=+cc;
for(cc in cols){var Lz=cols[cc];for(var q=0;q<Lz.length;q++){Lz[q].nx=mc?(+cc)/mc*.92+.04:.5;Lz[q].ny=(q+1)/(Lz.length+1);}}
NODES=N;RIBS=R;frames++;dirty=true;if(isolated&&!N[isolated])isolated='';diag();}
// ── interaction geometry (hit-testing runs in BOTH webgl and 2d; pointer x/y arrive canvas-pixel-scaled)
function bez(a,b,t){var x0=a.nx,y0=a.ny,x1=b.nx,y1=b.ny,mx=(x0+x1)/2,u=1-t;return[u*u*u*x0+3*u*u*t*mx+3*u*t*t*mx+t*t*t*x1,u*u*u*y0+3*u*u*t*y0+3*u*t*t*y1+t*t*t*y1];}
function segd(px,py,ax,ay,bx,by){var dx=bx-ax,dy=by-ay,L=dx*dx+dy*dy,t=L?((px-ax)*dx+(py-ay)*dy)/L:0;t=t<0?0:t>1?1:t;var qx=ax+dx*t,qy=ay+dy*t;return M.sqrt((px-qx)*(px-qx)+(py-qy)*(py-qy));}
function hitRib(px,py){var best=-1,bd=14*DPR,e,i;for(e=0;e<RIBS.length;e++){var rb=RIBS[e];if(capsOnly&&isData(rb))continue;var a=NODES[rb.a],b=NODES[rb.b];if(!a||!b)continue;var pv=null;for(i=0;i<=10;i++){var p=bez(a,b,i/10),qx=p[0]*W,qy=p[1]*H;if(pv){var d=segd(px,py,pv[0],pv[1],qx,qy);if(d<bd){bd=d;best=e;}}pv=[qx,qy];}}return best;}
function hitNode(px,py){var best='',bd=18*DPR,id;for(id in NODES){var o=NODES[id],dx=px-o.nx*W,dy=py-o.ny*H,d=M.sqrt(dx*dx+dy*dy);if(d<bd){bd=d;best=id;}}return best;}
function ribText(rb){if(!rb)return'';var a=NODES[rb.a],b=NODES[rb.b];if(!a||!b)return'';var w=rb.kind==='grant'?'capability':rb.kind==='deleg'?'delegation':rb.kind==='ghost'?'truncated work':'data';return'this '+w+' went from '+a.label+' → '+b.label;}
function setHover(i,px,py){hoverX=px;hoverY=py;var t=(i>=0&&RIBS[i])?ribText(RIBS[i]):'';if(t!==hoverText){hoverI=i;hoverText=t;diag();}}
function litNode(id){if(!isolated)return true;if(id===isolated)return true;var e;for(e=0;e<RIBS.length;e++){var rb=RIBS[e];if((rb.a===isolated&&rb.b===id)||(rb.b===isolated&&rb.a===id))return true;}return false;}
if(cw&&cw.on){cw.on('pointermove',function(e){if(W<2)return;setHover(hitRib(e.x,e.y),e.x,e.y);});cw.on('pointerleave',function(){setHover(-1,0,0);});cw.on('pointerdown',function(e){if(W<2)return;var nid=hitNode(e.x,e.y);isolated=(nid&&nid===isolated)?'':nid;diag();});}
if(capsBtn&&capsBtn.on)capsBtn.on('click',function(){capsOnly=!capsOnly;if(capsBtn.text)capsBtn.text(capsOnly?'all flows':'caps only');diag();});
if(slider&&slider.on)slider.on('input',function(e){if(!LASTV)return;var n=(AA(LASTV.steps))?LASTV.steps.length:0,k=parseInt(e&&e.value,10);if(isNaN(k))k=n;if(k>=n){build(LASTV);return;}build({turn:LASTV.turn,status:LASTV.status,rev:LASTV.rev,truncated:LASTV.truncated,agent:LASTV.agent,steps:LASTV.steps.slice(0,k),nodes:LASTV.nodes});});
var cid=(ui.props&&ui.props.cell)?String(ui.props.cell):'';
if(cid){try{ui.grain(cid).subscribe(function(v){try{LASTV=v;if(slider&&slider.attr){var n=(v&&AA(v.steps))?v.steps.length:0;slider.attr('max',String(n<1?1:n)).attr('value',String(n));}build(v);}catch(e){}});}catch(e){}}
if(!RAF||mode==='none')return wrap;
function fit(){var cwd=(canvas.clientWidth||600),chh=(canvas.clientHeight||320);W=canvas.width=M.round(cwd*DPR);H=canvas.height=M.round(chh*DPR);if(ocan){ocan.width=W;ocan.height=H;}if(gl)gl.viewport(0,0,W,H);}
function col(rb){return rb.fail?C.fail:(C[rb.kind]||C.data);}
function ncol(o){return o.fail?C.fail:(o.kind==='scope'?C.grant:(o.kind==='agent'?C.deleg:C.node));}
function gw(k){return grow[k]=(grow[k]||0)+(1-(grow[k]||0))*.08;}
function cx(x){return x*2-1;}function cy(y){return 1-y*2;}
function labels(){if(!cap||!cap.text)return;var t=[],id;for(id in NODES)t.push(NODES[id].label);cap.text(t.join(' → '));}
function strip(a,b,wpx){var s=[],i;for(i=0;i<=SEG;i++){var t=i/SEG,p=bez(a,b,t),px=p[0]*W,py=p[1]*H,q0=i<SEG?bez(a,b,(i+1)/SEG):p,q1=i>0?bez(a,b,(i-1)/SEG):p,dx=(q0[0]-q1[0])*W,dy=(q0[1]-q1[1])*H,sl=M.sqrt(dx*dx+dy*dy)||1,nx=-dy/sl*wpx*.5,ny=dx/sl*wpx*.5;s.push(cx((px+nx)/W),cy((py+ny)/H),cx((px-nx)/W),cy((py-ny)/H));}return s;}
var glI=false,pT,uT,aTp,aPs,bF;
function shd(t,s){var x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);return x;}
function initGL(){if(glI)return;glI=true;var p=gl.createProgram();gl.attachShader(p,shd(gl.VERTEX_SHADER,'attribute vec2 p;attribute float s;void main(){gl_Position=vec4(p,0.,1.);gl_PointSize=s;}'));gl.attachShader(p,shd(gl.FRAGMENT_SHADER,'precision mediump float;uniform vec4 u;void main(){gl_FragColor=vec4(u.rgb*u.a,u.a);}'));gl.linkProgram(p);pT=p;aTp=gl.getAttribLocation(p,'p');aPs=gl.getAttribLocation(p,'s');uT=gl.getUniformLocation(p,'u');bF=gl.createBuffer();gl.useProgram(p);}
function up(arr){gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(arr),gl.DYNAMIC_DRAW);}
function drawGL(time){initGL();gl.viewport(0,0,W,H);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.bindBuffer(gl.ARRAY_BUFFER,bF);var e,id;
gl.enableVertexAttribArray(aTp);gl.disableVertexAttribArray(aPs);gl.vertexAttribPointer(aTp,2,gl.FLOAT,false,8,0);
for(e=0;e<RIBS.length;e++){var rb=RIBS[e];if(capsOnly&&isData(rb))continue;var a=NODES[rb.a],b=NODES[rb.b];if(!a||!b)continue;var lit=!isolated||rb.a===isolated||rb.b===isolated,g=gw('r'+e),cc=col(rb),sh=.82+.18*M.sin(time*2.2+e*.7),sp=strip(a,b,rb.w*DPR*g),ba=(rb.kind==='ghost'?.14:(rb.kind==='data'?.42:.62))*(lit?sh:.12);up(sp);gl.uniform4f(uT,cc[0],cc[1],cc[2],ba);gl.drawArrays(gl.TRIANGLE_STRIP,0,sp.length/2);}
gl.enableVertexAttribArray(aPs);gl.vertexAttribPointer(aTp,2,gl.FLOAT,false,12,0);gl.vertexAttribPointer(aPs,1,gl.FLOAT,false,12,8);
for(e=0;e<RIBS.length;e++){var r2=RIBS[e];if(capsOnly&&isData(r2))continue;if(isolated&&r2.a!==isolated&&r2.b!==isolated)continue;var a2=NODES[r2.a],b2=NODES[r2.b];if(!a2||!b2)continue;var c2=col(r2),np=M.min(5,1+(r2.strands|0)),pa=[],z;for(z=0;z<np;z++){var tp=(time*.35+z/np+e*.13)%1,pp=bez(a2,b2,tp);pa.push(cx(pp[0]),cy(pp[1]),M.max(3,r2.w*DPR*.8));}up(pa);gl.uniform4f(uT,M.min(1,c2[0]+.3),M.min(1,c2[1]+.3),M.min(1,c2[2]+.3),grow['r'+e]||1);gl.drawArrays(gl.POINTS,0,pa.length/3);}
for(id in NODES){var o=NODES[id],gn=gw('n'+id),nc=ncol(o);up([cx(o.nx),cy(o.ny),M.max(6,13*DPR*gn)]);gl.uniform4f(uT,nc[0],nc[1],nc[2],litNode(id)?.95:.18);gl.drawArrays(gl.POINTS,0,1);}}
function I(x){return M.round(M.max(0,M.min(1,x))*255);}
function rgba(c,a){return'rgba('+I(c[0])+','+I(c[1])+','+I(c[2])+','+a+')';}
function draw2(time){if(!g2)return;g2.clearRect(0,0,W,H);g2.globalCompositeOperation='lighter';g2.lineCap='round';var e,id;
for(e=0;e<RIBS.length;e++){var rb=RIBS[e];if(capsOnly&&isData(rb))continue;var a=NODES[rb.a],b=NODES[rb.b];if(!a||!b)continue;var lit=!isolated||rb.a===isolated||rb.b===isolated,g=gw('r'+e),cc=col(rb),mx=(a.nx+b.nx)/2*W,sh=.82+.18*M.sin(time*2.2+e*.7),ba=(rb.kind==='data'?.4:.62)*(lit?sh:.12);g2.strokeStyle=rgba(cc,ba);g2.lineWidth=M.max(1,rb.w*DPR*g);g2.beginPath();g2.moveTo(a.nx*W,a.ny*H);g2.bezierCurveTo(mx,a.ny*H,mx,b.ny*H,b.nx*W,b.ny*H);g2.stroke();if(lit){var tp=(time*.4+e*.13)%1,p=bez(a,b,tp);g2.fillStyle=rgba(cc,g);g2.beginPath();g2.arc(p[0]*W,p[1]*H,M.max(2,rb.w*DPR*.4),0,6.28);g2.fill();}}
for(id in NODES){var o=NODES[id];g2.fillStyle=rgba(ncol(o),litNode(id)?.95:.22);g2.beginPath();g2.arc(o.nx*W,o.ny*H,M.max(4,8*DPR),0,6.283);g2.fill();}
g2.globalCompositeOperation='source-over';}
function measure(s){var m=oc.measureText&&oc.measureText(s);return(m&&m.width)||s.length*6;}
function overlay(){if(!oc)return;oc.clearRect(0,0,W,H);oc.textBaseline='middle';oc.font=(11*DPR)+'px system-ui,sans-serif';var id;
for(id in NODES){var o=NODES[id],x=o.nx*W,y=o.ny*H,lit=litNode(id),tw=measure(o.label),lx=o.nx>.62?x-tw-12:x+12;oc.globalAlpha=1;oc.fillStyle=lit?'rgba(13,17,23,.72)':'rgba(13,17,23,.4)';oc.fillRect(lx-4,y-9*DPR,tw+8,18*DPR);oc.fillStyle=lit?'rgba(230,237,243,.98)':'rgba(230,237,243,.35)';oc.fillText(o.label,lx,y);}
if(hoverText){oc.globalAlpha=1;oc.font=(12*DPR)+'px system-ui,sans-serif';var w2=measure(hoverText),bx=M.min(M.max(8,hoverX+12),W-w2-16),by=M.max(16*DPR,hoverY-16*DPR);oc.fillStyle='rgba(18,22,31,.95)';oc.fillRect(bx-7,by-12*DPR,w2+14,24*DPR);oc.strokeStyle='rgba(124,92,255,.85)';oc.lineWidth=1;oc.strokeRect(bx-7,by-12*DPR,w2+14,24*DPR);oc.fillStyle='rgba(233,238,245,1)';oc.fillText(hoverText,bx,by);}
oc.globalAlpha=1;}
function loop(ts){if(!RAF)return;if(!t0)t0=ts;var time=(ts-t0)/1000;try{fit();if(dirty){dirty=false;labels();}if(mode==='webgl')drawGL(time);else draw2(time);overlay();}catch(e){}RAF(loop);}
RAF(loop);return wrap;
}`;

export const TRACE_VIZ_SANKEY_NAME = 'Trace Sankey (authority & data flow)';
export const TRACE_VIZ_SANKEY_CELLS = ['trace:<chatId>'];

// ── SPLASH: the canned gallery-hero trace (the card that makes ocap superiority obvious). Task:
//   "Make a birthday card for Alex on the shared GPU, then email it to them." — a shared GPU minted into
//   an attenuated, time-boxed lease, DELEGATED across two hops with visible narrowing, then COMPOSED with
//   contacts + email caps into one result. Exercises every showcase point at once: wide authority at the
//   source, thin authority at the edge, a result woven from several caps (the wide→narrow→braid
//   silhouette = the whole ocap thesis in one still frame). Splash convention (shared with the sibling
//   viz workers): a SPLASH export + a sibling `<name>.splash.json` so the gallery can seed a card WITHOUT
//   a live turn. The result strings are already scrubbed (`a***@…`, `lease#… (attenuated)`) — the view
//   never renders them as text anyway (widths only), and PET() would «redact» a swissnum regardless.
export const TRACE_VIZ_SANKEY_SPLASH = {
  turn: 1,
  status: 'done',
  progress: 1,
  rev: 22,
  truncated: false,
  agent: 'field-agent',
  steps: [
    {
      i: 0,
      name: 'mintLease',
      status: 'done',
      ok: true,
      detail: 'GPU · TTL 5m · rate 3',
      granted: ['gpu'],
      result: 'lease#… (attenuated)',
    },
    {
      i: 1,
      name: 'delegateTask',
      status: 'done',
      ok: true,
      detail: '→ artist: draw the card',
      granted: ['images'],
      children: [
        { name: 'renderImage', detail: 'balloons, watercolor' },
        { name: 'upscale', detail: '2x' },
      ],
    },
    {
      i: 2,
      name: 'lookupContact',
      status: 'done',
      ok: true,
      detail: 'Alex',
      result: 'a***@…',
    },
    {
      i: 3,
      name: 'sendEmail',
      status: 'done',
      ok: true,
      granted: ['email'],
      detail: 'to Alex · 1 attachment',
      result: 'sent ✓',
    },
  ],
  nodes: [],
};

export default TRACE_VIZ_SANKEY_SOURCE;
