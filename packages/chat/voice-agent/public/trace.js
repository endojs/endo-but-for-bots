// trace.js — 3D conversation-trace visualization (from the voice memo). The
// conversation descends −Y in time; each turn is a wireframe pyramid; tool calls
// branch right, and a delegateTask's sub-agent tools branch FURTHER as a sub-tree;
// generated images render inline (tap to open full-screen); a voice turn's recorded
// audio renders as a waveform you can SCRUB (drag across it) and play. Orbit/zoom/
// pan + WebXR. Vendored Three.js (CSP: /three.module.js, same-origin).
import * as THREE from './three.module.js';

const COL = { you: 0x1f6feb, agent: 0x7c5cff, tool: 0x2ea043, delegate: 0xe3b341, bad: 0xf85149, origin: 0xe3b341, line: 0x8b949e, wave: 0x5fd28a, bg: 0x0a0f1e };
const GAP = 2.4;
const trunc = (s, n = 46) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const line = (a, b, c) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: c }));

const makeLabel = (text, color = '#e6edf3') => {
  const pad = 8, fs = 26, c = document.createElement('canvas'), g = c.getContext('2d');
  g.font = `${fs}px -apple-system,Segoe UI,Roboto,sans-serif`;
  c.width = Math.min(560, g.measureText(text).width + pad * 2); c.height = fs + pad * 2;
  g.font = `${fs}px -apple-system,Segoe UI,Roboto,sans-serif`;
  g.fillStyle = 'rgba(13,17,23,0.78)'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, pad, c.height / 2);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  sp.scale.set(c.width / 90, c.height / 90, 1); return sp;
};
const makePyramid = (size, color) => {
  const m = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.ConeGeometry(size, size * 1.6, 4)), new THREE.LineBasicMaterial({ color }));
  m.rotation.x = Math.PI; return m;
};

export const makeTrace = canvas => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(COL.bg, 1); renderer.xr.enabled = true;
  const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(COL.bg, 0.012);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
  let group = new THREE.Group(); scene.add(group);
  let pickables = [];      // meshes the raycaster can hit (images + audio waveforms)
  const audios = [];       // { el, plane, playhead } for per-frame playhead updates
  let audioCtx = null;
  const target = new THREE.Vector3(); let radius = 16, theta = 0.5, phi = 1.15;
  const applyCam = () => { camera.position.set(target.x + radius * Math.sin(phi) * Math.sin(theta), target.y + radius * Math.cos(phi), target.z + radius * Math.sin(phi) * Math.cos(theta)); camera.lookAt(target); };

  // ---- full-screen image viewer (DOM overlay, lazy) ----
  let viewer = null;
  const openImage = src => {
    if (!viewer) { viewer = document.createElement('div'); viewer.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center'; viewer.onclick = () => { viewer.style.display = 'none'; }; document.body.appendChild(viewer); }
    viewer.innerHTML = `<img src="${src}" style="max-width:94vw;max-height:94vh;border-radius:8px">`; viewer.style.display = 'flex';
  };

  // ---- recursive step tree, FANNED OUT IN 3D: each parent's children spread
  //      radially in the XZ plane (it's a 3D graph — don't pile them to the right).
  //      Sub-agents (delegateTask children) fan again around their own outward dir. ----
  const renderSteps = (steps, y0) => {
    const R = 2.4;
    const walk = (list, p, outward, depth) => {
      const n = (list && list.length) || 1;
      (list || []).forEach((st, j) => {
        const spread = depth === 0 ? Math.PI * 1.3 : Math.PI * 0.8;     // level-0 fans wide; deeper fans narrower around its parent
        const a = n === 1 ? outward : outward + (j / (n - 1) - 0.5) * spread;
        const pos = new THREE.Vector3(p.x + R * Math.cos(a), p.y - 0.5 - depth * 0.25, p.z + R * Math.sin(a));
        const col = st.name === 'delegateTask' ? COL.delegate : (st.ok === false ? COL.bad : COL.tool);
        const sn = makePyramid(0.3, col); sn.position.copy(pos); group.add(sn);
        group.add(line(p, pos, col));
        const lab = makeLabel(`⚙ ${st.name}`, depth ? '#e3b341' : '#5fd28a');
        lab.position.set(pos.x + 0.9 * Math.cos(a), pos.y, pos.z + 0.9 * Math.sin(a)); group.add(lab);
        if (st.children && st.children.length) walk(st.children, pos, a, depth + 1); // SUB-BRANCH TREE, fanned in 3D
      });
    };
    walk(steps, new THREE.Vector3(0, y0, 0), 0, 0);
  };

  // ---- a scrubbable audio waveform plane (drag across to seek + play) ----
  const addAudio = (url, x, y) => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 150;
    const g = c.getContext('2d'); g.fillStyle = 'rgba(13,17,23,0.9)'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#8b949e'; g.fillRect(0, 73, c.width, 4); // placeholder line until decoded
    const tex = new THREE.CanvasTexture(c);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.0), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    plane.position.set(x - 2.6, y, 0); group.add(plane);
    group.add(line(new THREE.Vector3(0, y, 0), new THREE.Vector3(x - 0.6, y, 0), COL.line));
    const el = new Audio(url); el.preload = 'auto';
    const playhead = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 1.0), new THREE.MeshBasicMaterial({ color: 0xffffff })); playhead.position.set(plane.position.x - 2.2, y, 0.01); group.add(playhead);
    plane.userData = { type: 'audio', el, plane }; pickables.push(plane);
    audios.push({ el, plane, playhead });
    // decode → draw real waveform
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      fetch(url).then(r => r.arrayBuffer()).then(b => audioCtx.decodeAudioData(b)).then(buf => {
        const d = buf.getChannelData(0), N = 158, blk = Math.floor(d.length / N) || 1;
        g.fillStyle = 'rgba(13,17,23,0.9)'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#5fd28a';
        for (let i = 0; i < N; i++) { let m = 0; for (let k = 0; k < blk; k++) { const v = Math.abs(d[i * blk + k] || 0); if (v > m) m = v; } const h = Math.max(2, m * c.height); g.fillRect(i * 4 + 1, (c.height - h) / 2, 3, h); }
        tex.needsUpdate = true;
      }).catch(() => {});
    } catch {}
  };

  const build = messages => {
    scene.remove(group); group = new THREE.Group(); scene.add(group); pickables = []; audios.length = 0;
    const origin = makePyramid(1.5, COL.origin); origin.position.set(0, GAP, 0); group.add(origin);
    const l0 = makeLabel('conversation', '#e3b341'); l0.position.set(2.2, GAP + 0.2, 0); group.add(l0);
    let prev = new THREE.Vector3(0, GAP - 0.8, 0);
    (messages || []).forEach((m, i) => {
      const y = -i * GAP, who = m.who === 'you' ? 'you' : 'agent', last = i === messages.length - 1;
      const node = makePyramid(last ? 0.85 : 0.6, COL[who]); node.position.set(0, y, 0); group.add(node);
      if (last) { const halo = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1.15, 8, 6)), new THREE.LineBasicMaterial({ color: 0xffffff })); halo.position.set(0, y, 0); group.add(halo); const hl = makeLabel('● latest', '#fff'); hl.position.set(-2.4, y + 0.9, 0); group.add(hl); }
      group.add(line(prev, new THREE.Vector3(0, y + 0.5, 0), COL.line)); prev = new THREE.Vector3(0, y - 0.5, 0);
      const lab = makeLabel(`${who === 'you' ? '🧑 ' : '🤖 '}${trunc(m.text)}`, who === 'you' ? '#7aa7ff' : '#c2b2ff'); lab.position.set(2.0, y + 0.15, 0); group.add(lab);
      // sub-branch step tree (falls back to flat tool names if no structured steps)
      renderSteps(m.steps && m.steps.length ? m.steps : (m.tools || []).map(n => ({ name: n })), y);
      // inline images (tap to open full-screen)
      (m.images || []).forEach((src, k) => { const tex = new THREE.TextureLoader().load(src); const pl = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), new THREE.MeshBasicMaterial({ map: tex, transparent: true })); const px = -3.4 - k * 2.8; pl.position.set(px, y, 0); pl.userData = { type: 'image', src }; group.add(pl); pickables.push(pl); group.add(line(new THREE.Vector3(0, y, 0), new THREE.Vector3(px + 1.2, y, 0), COL.line)); });
      // recorded voice → scrubbable waveform
      if (m.audio) addAudio(m.audio, -3.4, y);
    });
    const span = (messages?.length || 1) * GAP; target.set(1.5, -span / 2 + GAP, 0); radius = Math.max(10, span * 0.9 + 6); applyCam();
  };

  // ---- raycast picking ----
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pick = (cx, cy, objs) => {
    const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera); const h = rc.intersectObjects(objs || pickables, false)[0];
    return h ? { obj: h.object, uv: h.uv, type: h.object.userData.type, data: h.object.userData } : null;
  };
  const seek = (a, u) => { try { audioCtx && audioCtx.resume(); const d = a.el.duration || 0; a.el.currentTime = Math.max(0, Math.min(d, (u || 0) * d)); a.el.play().catch(() => {}); } catch {} };

  // ---- input: drag=orbit, drag-on-waveform=scrub, tap-image=open, scroll/pinch=zoom ----
  let drag = null, pan = false, scrub = null, down = null;
  const onDown = e => {
    const hit = pick(e.clientX, e.clientY);
    if (hit && hit.type === 'audio') { scrub = hit.data; seek(scrub, hit.uv.x); return; }
    down = hit; drag = { x: e.clientX, y: e.clientY, moved: 0 }; pan = e.button === 2 || e.shiftKey;
  };
  const onMove = e => {
    if (scrub) { const h = pick(e.clientX, e.clientY, [scrub.plane]); if (h) seek(scrub, h.uv.x); return; }
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    if (pan) { const s = radius * 0.0016; const right = new THREE.Vector3().subVectors(camera.position, target).cross(camera.up).normalize(); target.addScaledVector(right, dx * s); target.y += dy * s; }
    else { theta -= dx * 0.008; phi = Math.max(0.15, Math.min(Math.PI - 0.15, phi - dy * 0.008)); }
    applyCam();
  };
  const onUp = e => { if (scrub) { scrub = null; return; } if (drag && drag.moved < 6 && down && down.type === 'image') openImage(down.data.src); drag = null; down = null; };
  const onWheel = e => { e.preventDefault(); radius = Math.max(3, Math.min(160, radius * (1 + Math.sign(e.deltaY) * 0.1))); applyCam(); };
  let pinch = 0, pinchMid = null;
  const onTouch = e => {
    if (e.touches.length === 1) { const t = e.touches[0]; if (!drag && !scrub) onDown({ clientX: t.clientX, clientY: t.clientY, button: 0 }); else onMove({ clientX: t.clientX, clientY: t.clientY }); }
    else if (e.touches.length === 2) {
      // two fingers: pinch = zoom, AND drag = truck/pan (same as desktop shift/right-drag)
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const mx = (a.clientX + b.clientX) / 2, my = (a.clientY + b.clientY) / 2;
      if (pinch && pinchMid) {
        radius = Math.max(3, Math.min(160, radius * (pinch / d)));
        const s = radius * 0.0016; const right = new THREE.Vector3().subVectors(camera.position, target).cross(camera.up).normalize();
        target.addScaledVector(right, (mx - pinchMid.x) * s); target.y += (my - pinchMid.y) * s;
        applyCam();
      }
      pinch = d; pinchMid = { x: mx, y: my }; drag = null;
    }
  };
  const onTouchEnd = e => { onUp(e); pinch = 0; pinchMid = null; };
  canvas.addEventListener('pointerdown', onDown); window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('touchmove', onTouch, { passive: false }); canvas.addEventListener('touchend', onTouchEnd);

  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h || 1; camera.updateProjectionMatrix(); };
  const enterVR = async () => { if (!navigator.xr) throw new Error('WebXR not available'); const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] }); group.position.set(-1.5, 1.4, -4); group.scale.setScalar(0.25); await renderer.xr.setSession(s); };

  renderer.setAnimationLoop(() => {
    for (const a of audios) { const d = a.el.duration || 0; if (d) { const p = a.el.currentTime / d; a.playhead.position.x = a.plane.position.x - 2.2 + p * 4.4; a.playhead.visible = !a.el.paused; } }
    renderer.render(scene, camera);
  });
  return { render: m => { build(m); resize(); }, resize, enterVR, hasVR: () => !!navigator.xr, dispose: () => { renderer.setAnimationLoop(null); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); audios.forEach(a => { try { a.el.pause(); } catch {} }); renderer.dispose(); } };
};
