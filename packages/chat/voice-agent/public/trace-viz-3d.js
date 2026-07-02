// trace-viz-3d.js — the REFERENCE Tier-2 trace visualization: a 3D neon force-directed graph of the
// live reasoning trace, drawn with WebGL (canvas2d fallback) INSIDE the sandboxed confined.html iframe.
//
// WHY A TIER-2 IFRAME (not the SES no-iframe chrome/fork path): the no-iframe renderer's sanitizer
// (preact-container DEFAULT_ALLOWED_TAGS) has NO <svg>/<canvas>, so WebGL/SVG trace views are impossible
// there. The Tier-2 runtime (public/confined.html) is a UNIQUE OPAQUE ORIGIN, sandbox="allow-scripts"
// with NO allow-same-origin, CSP default-src 'none' (NO network). Inside that jail the source gets a REAL
// <canvas> (ui.create('canvas').el), real WebGL, and requestAnimationFrame — all pure, authority-free
// computation. The PARENT holds the cap and brokers the trace cell IN over a private MessagePort; the frame
// never sees the cap and cannot fetch. Canvas/WebGL where the sanitizer can't reach, ocap boundary intact.
//
// The SOURCE below is committed to component-git (via /components/break-out) as a `uicomp-…` object, so it
// is a first-class fork/riff/backlog island. Any OTHER (ui)=>element honoring the same contract can replace
// it — the same cell feeds every fork the same frames. This is the substrate the viz gallery rides.
//
// It starts with `(ui) =>` (NOT a `//` comment) so it passes break-out's `(ui)=>element` validation; the
// contract doc lives INSIDE the body so it travels with the git object (shown in the alt-click edit chat).
// Keep it ≤ 16000 chars (break-out cap) and fully DEFENSIVE: render-check.mjs runs it in a Node stub where
// ui.create().el has no getContext, requestAnimationFrame is undefined, and there is no DOM.
//
// FULL CONTRACT (also summarized in the source header + public/confined.html):
//   canvas  = ui.create('canvas').el          RAW canvas node; getContext('webgl') || getContext('2d')
//   cell    = ui.grain(ui.props.cell)          ui.props.cell === 'trace:<chatId>'; PARENT brokers it IN
//   animate = requestAnimationFrame            iframe global (typeof-guard so render-check passes)
//   report  = ui.call('vizDiag', {...})        optional host echo (frame count + renderer mode)
//   value   = { status:'running'|'done', rev, steps:[{name,ok?,status,children?}], nodes:[{key,parent?,state?}] }
export const TRACE_VIZ_3D_SOURCE = `(ui) => {
  // TRACE-VIZ (Tier-2 iframe; WebGL/canvas, NO net). (ui)=>element; canvas=ui.create('canvas').el; cell=ui.grain(ui.props.cell)='trace:<chatId>' (parent-brokered, no cap in frame); RAF=iframe global. Full contract: trace-viz-3d.js header. FORK FREELY on this contract.
  var RAF=(typeof requestAnimationFrame==='function')?requestAnimationFrame:null;
  var GCS=(typeof getComputedStyle==='function')?getComputedStyle:null;
  var DPR=(typeof devicePixelRatio==='number'&&devicePixelRatio>0)?devicePixelRatio:1;
  var wrap=ui.create('div').style({position:'relative',width:'100%'});
  var cw=ui.create('canvas').style({display:'block',width:'100%',height:'280px'});
  var canvas=cw&&cw.el;
  wrap.push(cw);
  var gl=null,g2=null,mode='none';
  if(canvas&&typeof canvas.getContext==='function'){
    try{ gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:true})||canvas.getContext('experimental-webgl'); }catch(e){}
    if(gl)mode='webgl'; else{ try{ g2=canvas.getContext('2d'); }catch(e){} if(g2)mode='2d'; }
  }
  function cvar(n,f){ try{ if(!GCS)return f; var v=GCS(document.documentElement).getPropertyValue(n); v=v&&v.trim(); return v||f; }catch(e){ return f; } }
  function hx(h){ h=String(h||'').trim(); var m=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h); if(!m)return[.49,.36,1]; var s=m[1]; if(s.length===3)s=s[0]+s[0]+s[1]+s[1]+s[2]+s[2]; return[parseInt(s.slice(0,2),16)/255,parseInt(s.slice(2,4),16)/255,parseInt(s.slice(4,6),16)/255]; }
  var C_ROOT=hx(cvar('--acc','#b58cff')),C_ACC=hx(cvar('--acc','#7c5cff')),C_OK=hx(cvar('--trace-ok','#8fd0a8')),C_BAD=hx(cvar('--trace-bad','#ff9e9e')),C_RES=hx(cvar('--acc2','#39d3ff'));
  var nodes=[],edges=[],byId={},running=true,steps=0,ang=0,frames=0,rev=0;
  function node(id,col,size){ var n=byId[id]; if(n){n.col=col;n.size=size;return n;} n={id:id,x:(Math.random()*2-1)*.6,y:(Math.random()*2-1)*.6,z:(Math.random()*2-1)*.6,vx:0,vy:0,vz:0,col:col,size:size}; if(id==='root'){n.x=0;n.y=0;n.z=0;} byId[id]=n; nodes.push(n); return n; }
  function edge(a,b){ var k='e:'+a+'>'+b; if(byId[k])return; byId[k]=1; edges.push([a,b]); }
  function build(v){
    if(!v||typeof v!=='object')return;
    running=v.status!=='done'; rev=v.rev||rev; node('root',C_ROOT,20);
    var st=Array.isArray(v.steps)?v.steps:[]; steps=st.length;
    for(var i=0;i<st.length&&i<60;i++){ var s=st[i]||{},col=s.status==='running'?C_ACC:(s.ok===false?C_BAD:C_OK),kids=Array.isArray(s.children)?s.children.length:0; node('s'+i,col,9+Math.min(kids,6)*1.6); edge('root','s'+i); }
    var nd=Array.isArray(v.nodes)?v.nodes:[];
    for(var k=0;k<nd.length&&k<80;k++){ var rn=nd[k]||{},key='n'+(rn.key!=null?rn.key:k); node(key,rn.state==='pending'?C_ACC:C_RES,7); edge(rn.parent!=null?('n'+rn.parent):'root',key); }
    frames++;
    try{ if(typeof ui.call==='function')ui.call('vizDiag',{rev:rev,frames:frames,mode:mode,steps:steps}); }catch(e){}
  }
  var cellId=(ui.props&&ui.props.cell)?String(ui.props.cell):'';
  if(cellId){ try{ ui.grain(cellId).subscribe(function(v){ try{build(v);}catch(e){} }); }catch(e){} }
  if(!RAF||mode==='none')return wrap;
  var W=1,H=1;
  function fit(){ var a=canvas.clientWidth||300,b=canvas.clientHeight||280,nw=Math.max(1,Math.round(a*DPR)),nh=Math.max(1,Math.round(b*DPR)); if(nw!==W||nh!==H){ W=nw;H=nh;canvas.width=W;canvas.height=H; if(gl)gl.viewport(0,0,W,H); } }
  function proj(p){ var ca=Math.cos(ang),sa=Math.sin(ang),rx=p.x*ca-p.z*sa,rz=p.x*sa+p.z*ca,per=3/(3-rz*.85),ax=(W>=H)?H/W:1,ay=(H>W)?W/H:1; return{sx:(rx*per/1.9)*.9*ax,sy:(p.y*per/1.9)*.9*ay,per:per,depth:rz}; }
  function sim(dt){ var n=nodes.length; if(!n)return; var i,j;
    for(i=0;i<n;i++){ var a=nodes[i]; for(j=i+1;j<n;j++){ var b=nodes[j],dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z,d2=dx*dx+dy*dy+dz*dz+.02,d=Math.sqrt(d2),f=.01/d2; dx/=d;dy/=d;dz/=d; a.vx+=dx*f;a.vy+=dy*f;a.vz+=dz*f; b.vx-=dx*f;b.vy-=dy*f;b.vz-=dz*f; } }
    for(var e=0;e<edges.length;e++){ var A=byId[edges[e][0]],B=byId[edges[e][1]]; if(!A||!B)continue; var x=B.x-A.x,y=B.y-A.y,z=B.z-A.z,dd=Math.sqrt(x*x+y*y+z*z)+.001,ff=(dd-.72)*.9; x/=dd;y/=dd;z/=dd; A.vx+=x*ff*dt*6;A.vy+=y*ff*dt*6;A.vz+=z*ff*dt*6; B.vx-=x*ff*dt*6;B.vy-=y*ff*dt*6;B.vz-=z*ff*dt*6; }
    for(var q=0;q<n;q++){ var p=nodes[q]; if(p.id==='root'){p.x*=.8;p.y*=.8;p.z*=.8;p.vx=p.vy=p.vz=0;continue;} p.vx+=-p.x*.02;p.vy+=-p.y*.02;p.vz+=-p.z*.02; p.vx*=.86;p.vy*=.86;p.vz*=.86; p.x+=p.vx*dt*6;p.y+=p.vy*dt*6;p.z+=p.vz*dt*6; } }
  function X(s){ return (s*.5+.5)*W; } function Y(s){ return (.5-s*.5)*H; } function I(c){ return Math.round(c*255); }
  function sh(t,s){ var x=gl.createShader(t); gl.shaderSource(x,s); gl.compileShader(x); return x; }
  function prog(vs,fs){ var p=gl.createProgram(); gl.attachShader(p,sh(gl.VERTEX_SHADER,vs)); gl.attachShader(p,sh(gl.FRAGMENT_SHADER,fs)); gl.linkProgram(p); return p; }
  function va(l,n,st,o){ gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l,n,gl.FLOAT,false,st,o); }
  var glI=false,pP,lP,pB,lB,pA={},lA={};
  function initGL(){ if(glI||!gl)return; glI=true;
    pP=prog('attribute vec2 p;attribute float s;attribute vec4 c;varying vec4 vc;void main(){gl_Position=vec4(p,0.,1.);gl_PointSize=s;vc=c;}','precision mediump float;varying vec4 vc;void main(){vec2 d=gl_PointCoord-vec2(.5);float r=length(d);if(r>.5)discard;float a=smoothstep(.5,0.,r);float k=smoothstep(.3,0.,r);gl_FragColor=vec4(vc.rgb+k*.7,vc.a*a);}');
    lP=prog('attribute vec2 p;attribute vec4 c;varying vec4 vc;void main(){gl_Position=vec4(p,0.,1.);vc=c;}','precision mediump float;varying vec4 vc;void main(){gl_FragColor=vc;}');
    pA.p=gl.getAttribLocation(pP,'p');pA.s=gl.getAttribLocation(pP,'s');pA.c=gl.getAttribLocation(pP,'c');
    lA.p=gl.getAttribLocation(lP,'p');lA.c=gl.getAttribLocation(lP,'c'); pB=gl.createBuffer(); lB=gl.createBuffer();
  }
  function drawGL(pts,lns){ initGL(); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
    if(lns.length){ gl.useProgram(lP); gl.bindBuffer(gl.ARRAY_BUFFER,lB); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(lns),gl.DYNAMIC_DRAW); va(lA.p,2,24,0); va(lA.c,4,24,8); gl.drawArrays(gl.LINES,0,lns.length/6); }
    if(pts.length){ gl.useProgram(pP); gl.bindBuffer(gl.ARRAY_BUFFER,pB); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(pts),gl.DYNAMIC_DRAW); va(pA.p,2,28,0); va(pA.s,1,28,8); va(pA.c,4,28,12); gl.drawArrays(gl.POINTS,0,pts.length/7); }
  }
  function drawC2(pts,lns){ if(!g2)return; g2.clearRect(0,0,W,H); g2.globalCompositeOperation='lighter'; var i;
    for(i=0;i<lns.length;i+=12){ g2.strokeStyle='rgba('+I(lns[i+2])+','+I(lns[i+3])+','+I(lns[i+4])+','+lns[i+5]+')'; g2.lineWidth=Math.max(1,DPR); g2.beginPath(); g2.moveTo(X(lns[i]),Y(lns[i+1])); g2.lineTo(X(lns[i+6]),Y(lns[i+7])); g2.stroke(); }
    for(i=0;i<pts.length;i+=7){ var r=pts[i+2]*.5,cs=I(pts[i+3])+','+I(pts[i+4])+','+I(pts[i+5]); g2.shadowColor='rgba('+cs+',.9)'; g2.shadowBlur=r*2; g2.fillStyle='rgba('+cs+','+pts[i+6]+')'; g2.beginPath(); g2.arc(X(pts[i]),Y(pts[i+1]),r,0,6.283); g2.fill(); }
    g2.shadowBlur=0; g2.globalCompositeOperation='source-over';
  }
  function draw(){ var pr={},i; for(i=0;i<nodes.length;i++)pr[nodes[i].id]=proj(nodes[i]); var pts=[],lns=[];
    for(var e=0;e<edges.length;e++){ var A=byId[edges[e][0]],B=byId[edges[e][1]]; if(!A||!B)continue; var a=pr[A.id],b=pr[B.id]; if(!a||!b)continue; var al=running?.30:.20; lns.push(a.sx,a.sy,A.col[0],A.col[1],A.col[2],al,b.sx,b.sy,B.col[0],B.col[1],B.col[2],al); }
    for(var k=0;k<nodes.length;k++){ var nn=nodes[k],p=pr[nn.id],sz=nn.size*DPR*(.6+p.per*.5),aa=.55+(p.depth+1)*.2; if(aa>1)aa=1; if(aa<.35)aa=.35; pts.push(p.sx,p.sy,sz,nn.col[0],nn.col[1],nn.col[2],aa); }
    if(mode==='2d')drawC2(pts,lns); else drawGL(pts,lns);
  }
  var last=0;
  function loop(t){ if(!RAF)return; var dt=last?Math.min(.05,(t-last)/1000):.016; last=t; try{ fit(); sim(dt); ang+=dt*.25; draw(); }catch(e){} RAF(loop); }
  RAF(loop); return wrap;
}`;

export const TRACE_VIZ_NAME = 'Trace 3D (force graph)';
export const TRACE_VIZ_CELLS = ['trace:<chatId>'];
