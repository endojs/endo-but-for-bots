// pendant.js — a small, REAL-TIME 3D "trace pendant" that hangs beneath the latest
// prompt in the main chat and animates the agent's fan-out (tool uses, delegates,
// sub-agents, and a research team's plan → searches → distill → synthesis) as it
// happens — so you can see/feel how the system allocates work, and inspect EVERY
// action (hover or click any node → its query / URL / sub-question / summary).
//
// Classic animation principles, on purpose:
//   • every motion EASES IN and OUT (cubic in-out for travel, easeOutBack for "pops")
//   • things GROW TO APPEAR (scale 0 → 1 with a little overshoot = appeal/anticipation)
//   • every shape has a gentle IDLE SPIN
//   • the wireframe is drawn by a SHADER with a subtle NEON GLOW (an additive fresnel
//     shell behind a shader-lit wireframe — no post-processing dependency needed)
//
// One reused WebGL context. Fed by app.js: reset(prompt) on send; live toolStart/
// toolDone (top-level tools) + rnode (research subtree) from the SSE stream;
// applyFinal(steps) to reconcile; and showSteps(steps) to RE-RENDER a saved trace
// when you re-open a chat (so the trace persists across navigation).
import * as THREE from './three.module.js';

// palette mirrors trace.js: tools = green, delegate-ish = gold, sub-question = blue, root = violet, fail = red
const COL = { root: 0x7c5cff, tool: 0x2ea043, delegate: 0xe3b341, subq: 0x58a6ff, bad: 0xf85149, line: 0x6b7a99, view: 0x39d3ff };
// A step that PUBLISHED an embedded VIEW (a developer/agent publishing a site/widget). The result
// carries a /sites/ (or .html) URL — we surface it as a distinct 📺 node so the trace shows the
// developer → published-view lineage. Returns the view URL, or '' if this step published nothing.
const publishedViewUrl = nd => { try { if (!nd) return ''; const m = /(https?:\/\/[^\s"')]+?\/sites\/[^\s"')]+|\/sites\/[\w./-]+|https?:\/\/[^\s"')]+?\.html\b)/.exec(String(nd.resultText || '')); if (m) return m[1]; if (String(nd.name) === 'publishSite') return '(published)'; return ''; } catch { return ''; } };
const DELEGATE = new Set(['delegateTask', 'askSpecialist', 'research', 'employ']); // these fan out further
const ROOT_Y = 1.35;
// inspectable satellites: every node "unfurls" the EXACT call (cyan) + EXACT result (amber)
// as two small shapes that orbit it; click one → a scrollable modal with the full text.
const SAT = { call: 0x39c5cf, result: 0xd29922 };
// Granovetter: a delegation edge IS the conveyed authority. The granted powers ride the line as
// pickable icons (hover = name+what-it-does; click = inspect; room for an interactive control later).
const POWER_ICON = { notes: '📓', reference: '📚', web: '🌐', research: '🔬', youtube: '▶️', images: '🎨', feed: '📣', phone: '📱', timers: '⏰', browser: '🧭', home: '🏠', vm: '🖥️', agents: '👥', selfPrompt: '✍️', delegate: '🤝', roles: '🎭', editNote: '📝', homeassistant: '💡', email: '✉️', subagent: '🌱', contacts: '👤', specialists: '🧩', kazputer: '🎮', dietician: '🥗', app: '⚙️' };
const POWER_LABEL = { notes: 'Read your personal notes', reference: 'Consult library + Wikipedia', web: 'Search & fetch the web', research: 'A research team', youtube: 'YouTube transcripts', images: 'Generate images on the GPU', feed: 'Post to feed / notifications', phone: 'Push a phone notification', timers: 'Schedule wake-ups', browser: 'Headless browser', home: 'A private home folder', vm: 'Dev-VM terminal', agents: 'Agent + machine roster', selfPrompt: 'Edit its own system prompt', delegate: 'Delegate to an Opus agent', roles: 'Employ a role sub-agent', editNote: 'Propose note edits', homeassistant: 'Home Assistant', email: 'Propose an email', subagent: 'Propose a system sub-agent', contacts: 'Address book', specialists: 'Spawn specialists', kazputer: 'Manage Kazputers', dietician: 'Dietician pipeline', app: 'App state' };
const powerIcon = p => POWER_ICON[p] || '🔑';

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
const now = () => performance.now() / 1000;

// classify a node by its name (used when re-rendering a SAVED trace, which has no kind tag)
const nameKind = name => { const s = String(name || ''); if (DELEGATE.has(s)) return 'delegate'; if (s.startsWith('❓')) return 'subq'; if (/…|^distilled$|^report$|^synthesiz/i.test(s)) return 'phase'; return 'tool'; };
const KIND_COL = { subq: COL.subq, tool: COL.tool, phase: COL.delegate, delegate: COL.delegate, root: COL.root };
const labelHex = t => (t === 'subq' ? '#9ecbff' : (t === 'phase' || t === 'delegate') ? '#e3b341' : t === 'root' ? '#cbbcff' : '#7fe0a0');

// neon-glow shaders ---------------------------------------------------------------
const WIRE_V = 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
const WIRE_F = 'precision mediump float; uniform vec3 uColor; uniform float uIntensity; void main(){ gl_FragColor = vec4(uColor * (0.85 + uIntensity*0.6), 1.0); }';
const GLOW_V = 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
const GLOW_F = 'precision mediump float; uniform vec3 uColor; uniform float uIntensity; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 3.0); gl_FragColor = vec4(uColor * (0.6 + uIntensity*0.4), f * 0.28 * (0.5 + uIntensity*0.6)); }';

const makeLabel = (text, color = '#9fb0c9') => {
  const fs = 30, pad = 6, c = document.createElement('canvas'), g = c.getContext('2d');
  const font = `${fs}px -apple-system,Segoe UI,Roboto,sans-serif`;
  g.font = font; const s = String(text || '').slice(0, 22);
  c.width = Math.ceil(g.measureText(s).width) + pad * 2; c.height = fs + pad * 2;
  g.font = font; g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(s, pad, c.height / 2);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, depthWrite: false }));
  sp.scale.set(c.width / 150, c.height / 150, 1);
  return sp;
};

export const makePendant = canvas => {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1.4, 0.1, 100);
  let sceneGroup = new THREE.Group(); scene.add(sceneGroup);

  let root = null;
  const nodes = [];        // every node record (incl. root) — spin + fit
  const level1 = [];       // top-level tool nodes, in completion order
  const pendingQ = [];     // toolStart'd top-level nodes awaiting their toolDone (FIFO match)
  const byKey = new Map(); // keyed nodes (research subtree) for live upsert
  const pickables = [];    // invisible hit-spheres for hover/click inspection
  const tweens = [];
  let visible = true, buildInstant = false, activeResearch = null;
  let hovered = null; // the userData {nd, sat?} currently under the pointer

  const camTarget = new THREE.Vector3(0, 0.3, 0);
  let camDist = 5; const desiredCenter = new THREE.Vector3(0, 0.3, 0); let desiredDist = 5;
  let userZoom = 1, panX = 0, panY = 0; // wheel/pinch zoom + drag-pan, layered on top of the auto-fit framing
  let autoAz = 0; // the spiral's continuous slow turn — the camera orbits the helix gently over time

  const tween = (dur, ease, apply) => { if (buildInstant) { apply(1); return; } tweens.push({ t0: now(), dur, ease, apply }); };

  // the permissioning (scoping) agent gets a distinct base shape — a DODECAHEDRON — so you can tell
  // "figuring out what powers this needs" apart from the working agent (octahedron). rootShape switches it.
  let rootShape = 'octahedron';
  const geoFor = type => type === 'root' ? (rootShape === 'dodecahedron' ? new THREE.DodecahedronGeometry(0.62) : new THREE.OctahedronGeometry(0.6))
    : type === 'delegate' ? new THREE.OctahedronGeometry(0.4)
    : type === 'subq' ? new THREE.OctahedronGeometry(0.32)
    : type === 'phase' ? new THREE.TetrahedronGeometry(0.32)
    : new THREE.TetrahedronGeometry(0.34);

  const makeNodeRecord = (type, color, name) => {
    const geo = geoFor(type);
    const col = new THREE.Color(color);
    const wireMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: col.clone() }, uIntensity: { value: 1 } }, vertexShader: WIRE_V, fragmentShader: WIRE_F, transparent: true });
    const glowMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: col.clone() }, uIntensity: { value: 1 } }, vertexShader: GLOW_V, fragmentShader: GLOW_F, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
    const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat);
    const glow = new THREE.Mesh(geo, glowMat); glow.scale.setScalar(1.25);
    const group = new THREE.Group(); group.add(glow); group.add(wire);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })); // invisible, raycast-only
    group.add(pick);
    const axis = new THREE.Vector3(Math.random() * 2 - 1, 1, Math.random() * 2 - 1).normalize();
    const rec = { group, wire, glow, wireMat, glowMat, geo, pick, label: null, labelText: name, line: null, lineMat: null, lineGeo: null,
      backLine: null, backLineMat: null, backLineGeo: null, tCall: now(), tDone: 0, crown: [], lifeline: null,
      name, type, axis, spin: 0.45 + Math.random() * 0.6, pending: false, settled: false, parent: null, children: [], target: new THREE.Vector3(), key: null, detail: '', info: '', callText: '', resultText: '', sats: [], granted: null, powerIcons: [] };
    pick.userData.nd = rec;
    return rec;
  };
  const setColor = (nd, color) => { nd.wireMat.uniforms.uColor.value.set(color); nd.glowMat.uniforms.uColor.value.set(color); };
  const setLabel = (nd, text) => {
    if (nd.label) { nd.group.remove(nd.label); try { nd.label.material.map.dispose(); nd.label.material.dispose(); } catch { /* ignore */ } }
    nd.labelText = String(text || nd.name); nd.label = makeLabel(nd.labelText, labelHex(nd.type)); nd.label.position.set(0, -0.7, 0); nd.group.add(nd.label);
  };

  const makeLine = color => {
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const lineMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: 0.4 } }, vertexShader: WIRE_V, fragmentShader: WIRE_F, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    return { line: new THREE.Line(lineGeo, lineMat), lineGeo, lineMat };
  };
  // the point on a PARENT agent's lifeline at time t (root's lifeline = the vertical time axis; a delegate's
  // = its own column). Tools edge to this point, so the connection lands at the right moment on the timeline.
  const _v = new THREE.Vector3();
  const axisAt = (parent, t) => parent === root ? _v.set(parent.group.position.x, yOf(t), parent.group.position.z) : parent.group.position;
  const updateLine = nd => {
    const par = nd.parent; if (!par) return;
    if (nd.line) { nd.lineGeo.setFromPoints([axisAt(par, nd.tCall).clone(), nd.group.position]); nd.lineGeo.attributes.position.needsUpdate = true; } // OUT: message went out at call-time
    if (nd.backLine) { // BACK: message returned at done-time (only once settled)
      if (nd.tDone) { nd.backLine.visible = true; nd.backLineGeo.setFromPoints([nd.group.position, axisAt(par, nd.tDone).clone()]); nd.backLineGeo.attributes.position.needsUpdate = true; }
      else nd.backLine.visible = false;
    }
    positionPowerIcons(nd);
  };

  // the EXACT call (LLM tool invocation) and EXACT result, resolved per node — falling back to the
  // research subtree's existing query(detail)/summary(info) fields so research leaves get them for free.
  const callOf = nd => nd.callText || nd.detail || '';
  const resultOf = nd => nd.resultText || nd.info || '';
  const addSat = (nd, which, offset) => {
    const col = new THREE.Color(SAT[which]); const geo = new THREE.OctahedronGeometry(0.14);
    const wireMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: col.clone() }, uIntensity: { value: 0.7 } }, vertexShader: WIRE_V, fragmentShader: WIRE_F, transparent: true });
    const glowMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: col.clone() }, uIntensity: { value: 0.7 } }, vertexShader: GLOW_V, fragmentShader: GLOW_F, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide });
    const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat);
    const glow = new THREE.Mesh(geo, glowMat); glow.scale.setScalar(1.5);
    const g = new THREE.Group(); g.add(glow); g.add(wire);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    pick.userData.nd = nd; pick.userData.sat = which; g.add(pick);
    g.position.copy(nd.group.position).add(offset);
    sceneGroup.add(g); pickables.push(pick);
    nd.sats.push({ g, glow, wire, wireMat, glowMat, geo, offset: offset.clone(), which, axis: new THREE.Vector3(Math.random() * 2 - 1, 1, Math.random() * 2 - 1).normalize() });
    if (buildInstant) g.scale.setScalar(1); else { g.scale.setScalar(0.001); tween(0.4, easeOutBack, e => g.scale.setScalar(Math.max(0.001, e))); }
  };
  const ensureSats = nd => {
    if (!nd || !nd.sats) return;
    const has = w => nd.sats.some(s => s.which === w);
    if (callOf(nd) && !has('call')) addSat(nd, 'call', new THREE.Vector3(0.52, -0.04, 0.42));
    if (resultOf(nd) && !has('result')) addSat(nd, 'result', new THREE.Vector3(-0.52, -0.04, 0.42));
  };

  // ---- granted-power icons along the delegation edge (Granovetter authority) ----
  const grantedOf = nd => {
    if (Array.isArray(nd.granted) && nd.granted.length) return nd.granted;
    try { const a = JSON.parse(nd.callText || '{}'); const g = a.powers || a.tools; if (Array.isArray(g)) return g.filter(x => typeof x === 'string'); } catch { /* not json */ }
    return [];
  };
  const positionPowerIcons = nd => {
    if (!nd.powerIcons || !nd.powerIcons.length || !nd.parent) return;
    const a = nd.parent.group.position, b = nd.group.position, n = nd.powerIcons.length;
    nd.powerIcons.forEach((pi, i) => { const t = n > 1 ? 0.30 + 0.40 * (i / (n - 1)) : 0.5; pi.g.position.lerpVectors(a, b, t); pi.g.position.y += 0.17; });
  };
  const ensurePowerIcons = nd => {
    if (!nd || !nd.parent || !nd.powerIcons || nd.powerIcons.length) return;
    const g = grantedOf(nd); if (!g.length) return;
    g.slice(0, 8).forEach(power => {
      const sprite = makeLabel(powerIcon(power), '#cbbcff'); sprite.scale.multiplyScalar(0.8);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      pick.userData.nd = nd; pick.userData.power = power; // hover/click identify the power (inspectable)
      const grp = new THREE.Group(); grp.add(sprite); grp.add(pick);
      sceneGroup.add(grp); pickables.push(pick);
      nd.powerIcons.push({ g: grp, sprite, pick, power });
      if (buildInstant) grp.scale.setScalar(1); else { grp.scale.setScalar(0.001); tween(0.42, easeOutBack, e => grp.scale.setScalar(Math.max(0.001, e))); }
    });
    positionPowerIcons(nd);
  };

  // ── a hovering "CROWN" of an agent's powers above it — clickable/inspectable (reuses the power modal).
  //    The root's crown = the chat's powers (app sets them via setRootPowers); a delegate's = its granted set.
  const positionCrown = nd => {
    if (!nd.crown || !nd.crown.length) return;
    const n = nd.crown.length, R = 0.5 + n * 0.035, cy = nd.group.position.y + 0.9;
    nd.crown.forEach((c, i) => { const a = (i / n) * Math.PI * 2; c.g.position.set(nd.group.position.x + R * Math.cos(a), cy, nd.group.position.z + R * Math.sin(a)); });
  };
  const buildCrown = (nd, powers) => {
    if (!nd || !Array.isArray(powers) || !powers.length || (nd.crown && nd.crown.length)) return;
    nd.crown = [];
    powers.slice(0, 14).filter(p => typeof p === 'string').forEach(power => {
      const sprite = makeLabel(powerIcon(power), '#ffd479'); sprite.scale.multiplyScalar(0.66);
      const pick = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
      pick.userData.nd = nd; pick.userData.power = power; // hover/click → inspect the power
      const grp = new THREE.Group(); grp.add(sprite); grp.add(pick);
      sceneGroup.add(grp); pickables.push(pick); nd.crown.push({ g: grp, power });
      if (buildInstant) grp.scale.setScalar(1); else { grp.scale.setScalar(0.001); tween(0.4, easeOutBack, e => grp.scale.setScalar(Math.max(0.001, e))); }
    });
    positionCrown(nd);
  };
  // the lifeline (the agent's time-extruded body) grows down to the latest step + spins gently.
  const updateLifeline = dt => {
    if (!root || !root.lifeline) return;
    const top = ROOT_Y - 0.5;
    const bottom = level1.length ? Math.min(top - 0.3, Math.min(...level1.map(n => n.group.position.y)) - 0.35) : top - 0.3;
    const h = Math.max(0.1, top - bottom), m = root.lifeline.mesh;
    m.scale.y = h; m.position.set(root.group.position.x, top - h / 2, root.group.position.z); m.rotation.y += dt * 0.3;
  };

  const grow = nd => { if (buildInstant) { nd.group.scale.setScalar(1); return; } nd.group.scale.setScalar(0.001); tween(0.44, easeOutBack, e => nd.group.scale.setScalar(Math.max(0.001, e))); };
  const tweenPos = (nd, target, dur = 0.5) => {
    nd.target.copy(target);
    if (buildInstant) { nd.group.position.copy(target); updateLine(nd); return; }
    const from = nd.group.position.clone();
    tween(dur, easeInOut, e => { nd.group.position.lerpVectors(from, target, e); updateLine(nd); });
  };

  // create a node under `parent`, pushing into `arr` for relayout. opts: {key,color,type,detail,info,label,persistLabel}
  const addNode = (name, parent, arr, opts = {}) => {
    const isDel = DELEGATE.has(name);
    const type = opts.type || (isDel ? 'delegate' : 'tool');
    const color = opts.color || (isDel ? COL.delegate : COL.tool);
    const nd = makeNodeRecord(type, color, name);
    nd.key = opts.key || null; nd.detail = opts.detail || ''; nd.info = opts.info || '';
    nd.callText = opts.call || ''; nd.resultText = opts.result || ''; nd.granted = Array.isArray(opts.granted) ? opts.granted : null;
    nd.parent = parent;
    nd.group.position.copy(parent.group.position); // grow OUT of its parent
    sceneGroup.add(nd.group);
    const lk = makeLine(SEQ_OUT); nd.line = lk.line; nd.lineGeo = lk.lineGeo; nd.lineMat = lk.lineMat; // OUT edge (call)
    const bk = makeLine(SEQ_BACK); nd.backLine = bk.line; nd.backLineGeo = bk.lineGeo; nd.backLineMat = bk.lineMat; nd.backLine.visible = false; // BACK edge (return)
    sceneGroup.add(nd.line); sceneGroup.add(nd.backLine); updateLine(nd);
    const labelText = opts.label || (arr === level1 ? '⚙ ' + name : '');
    if (labelText && (opts.persistLabel || arr === level1)) setLabel(nd, labelText);
    nodes.push(nd); pickables.push(nd.pick); arr.push(nd); grow(nd);
    ensurePowerIcons(nd); if (nd.granted) buildCrown(nd, nd.granted); // a sub-agent wears a CROWN of the powers it was granted
    return nd;
  };

  // DESCENDING SPIRAL (helix): top-level steps wind down a gentle spiral in the order they HAPPENED —
  // the root (prompt) at the top, each later step turned a little further around the axis and dropped a
  // little (so it descends FAR less per step than a straight stack → compact). The connector of each
  // step chains to the PREVIOUS step, so the line itself spirals = the arrow of time. Fixed params →
  // existing steps stay put as new ones wind on below. The camera also turns slowly (see the loop).
  const SPIRAL_R = 1.05;     // helix radius around the vertical axis below the root
  const SPIRAL_TURN = 0.7;   // radians turned per step (the continuous spiral)
  const SPIRAL_DROP = 0.5;   // vertical descent per step — ~half a straight stack, so it's compact
  // ── 3D SEQUENCE DIAGRAM: the agent is a vertical TIME LIFELINE (a 4D octahedron — its rotating head +
  //    its body extruded down the time axis). Each tool use connects to the lifeline at the Y of WHEN the
  //    message went OUT (call) and WHEN it came BACK (return) — two coloured edges = a sequence diagram. ──
  const TIME_SCALE = 0.085;  // vertical world-units per SECOND of elapsed time (the time-scale of the axis)
  const SEQ_OUT = 0x39c5cf;  // call edge — the message OUT to the tool (teal)
  const SEQ_BACK = 0xd29922; // return edge — the message BACK to the agent (amber)
  let t0 = 0;                // the turn's start time (set in makeRoot); the lifeline's origin
  const yOf = t => ROOT_Y - 0.6 - Math.max(0, (Number(t) || t0) - t0) * TIME_SCALE; // a time → its Y on the lifeline
  const relayoutLevel1 = () => {
    const n = level1.length; if (!n) return;
    const cx = root.group.position.x;
    // Each step spirals around the agent's lifeline, positioned at the Y of ITS time (mid of call→return),
    // so the spiral now reads on the time-scale axis. Its two edges connect to the lifeline at call/return Y.
    level1.forEach((nd, j) => {
      const a = j * SPIRAL_TURN;
      const midT = nd.tDone ? (nd.tCall + nd.tDone) / 2 : nd.tCall;
      tweenPos(nd, new THREE.Vector3(cx + SPIRAL_R * Math.sin(a), yOf(midT), SPIRAL_R * Math.cos(a)));
    });
  };
  const relayoutChildren = parent => {
    const kids = parent.children, m = kids.length; if (!m) return; const R = parent === root ? 1.4 : 0.95;
    // A timeline step's sub-tree (delegate/research children) branches OUT TO THE RIGHT of the spine so
    // it doesn't collide with the steps continuing downward. Deeper nodes keep fanning along their own
    // growth direction.
    let base;
    if (parent.parent === root) base = 0; // +x, branch rightward off the vertical spine
    else { const dir = parent.target.clone().sub(parent.parent ? parent.parent.group.position : root.group.position); if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0); base = Math.atan2(dir.y, dir.x); }
    const spread = Math.min(Math.PI * 0.72, 0.4 + m * 0.3); const step = m > 1 ? spread / (m - 1) : 0;
    kids.forEach((nd, j) => {
      const ang = base + (j - (m - 1) / 2) * step;
      tweenPos(nd, parent.target.clone().add(new THREE.Vector3(R * Math.cos(ang), R * Math.sin(ang), (j - (m - 1) / 2) * 0.1)), 0.46);
    });
  };

  const fit = () => {
    if (!root) return; const box = new THREE.Box3(); box.expandByPoint(new THREE.Vector3(0, ROOT_Y, 0));
    nodes.forEach(nd => box.expandByPoint(nd.target.lengthSq() ? nd.target : nd.group.position));
    box.expandByScalar(0.8);
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    const aspect = (canvas.clientWidth / Math.max(1, canvas.clientHeight)) || 1.4;
    const vFov = (camera.fov * Math.PI) / 180;
    const distH = (size.y / 2) / Math.tan(vFov / 2);
    const distW = (size.x / 2) / (Math.tan(vFov / 2) * aspect);
    desiredCenter.copy(c); desiredDist = Math.max(3, Math.max(distH, distW) + 1.3);
  };

  const settle = (nd, ok) => {
    nd.settled = true; nd.pending = false; nd.tDone = now(); updateLine(nd); // record the RETURN time → the back-edge lands on the lifeline
    if (ok === false) { setColor(nd, COL.bad); return; }
    // Developer → published view: a step that published an embedded view glows as a distinct 📺 node
    // (edged from whoever published it), so the trace shows the lineage from the developer to the view.
    const vu = publishedViewUrl(nd);
    if (vu) { nd.viewUrl = vu; setColor(nd, COL.view); setLabel(nd, `📺 ${nd.labelText || nd.name}`); if (!nd.info) nd.info = `published view: ${vu}`; }
  };

  // recursively build a saved subtree under `parent` (children may nest: research → sub-question → fetch)
  const buildChildren = (children, parent) => {
    (children || []).forEach(c => {
      const k = nameKind(c.name); const nd = addNode(c.name, parent, parent.children, { color: KIND_COL[k], type: k === 'delegate' ? 'delegate' : k, detail: c.detail || '', info: c.info || '', call: c.call || '', result: c.result || '', granted: c.granted, label: (k !== 'tool' ? c.name : ''), persistLabel: k !== 'tool' });
      settle(nd, c.ok);
      if (c.children && c.children.length) buildChildren(c.children, nd);
    });
    relayoutChildren(parent);
  };

  // ---- public API ----
  const makeRoot = (descend, promptText, color = COL.root) => {
    root = makeNodeRecord('root', color, 'prompt'); root.labelText = 'prompt'; root.detail = String(promptText || '');
    t0 = now(); // the lifeline's time origin
    sceneGroup.add(root.group); nodes.push(root); pickables.push(root.pick);
    // the agent's LIFELINE — its body extruded down the time axis (the 4D octahedron: the rotating head
    // above + this vertical column). Grows downward as the turn unfolds; tool edges land on it by time.
    const llGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 6, 1, true);
    const llMat = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: 0.5 } }, vertexShader: WIRE_V, fragmentShader: WIRE_F, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const llMesh = new THREE.LineSegments(new THREE.EdgesGeometry(llGeo), llMat);
    sceneGroup.add(llMesh); root.lifeline = { mesh: llMesh, mat: llMat };
    if (descend && !buildInstant) {
      root.group.position.set(0, ROOT_Y + 2.1, 0); const from = root.group.position.clone(), to = new THREE.Vector3(0, ROOT_Y, 0);
      tween(0.62, easeInOut, e => root.group.position.lerpVectors(from, to, e));
      root.group.scale.setScalar(0.001); tween(0.55, easeOutBack, e => root.group.scale.setScalar(Math.max(0.001, e)));
    } else { root.group.position.set(0, ROOT_Y, 0); }
  };
  const clearScene = () => {
    scene.remove(sceneGroup);
    sceneGroup.traverse(o => { if (o.geometry) o.geometry.dispose?.(); if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose?.(); m.dispose?.(); }); } });
    sceneGroup = new THREE.Group(); scene.add(sceneGroup);
    nodes.length = 0; level1.length = 0; pendingQ.length = 0; pickables.length = 0; tweens.length = 0; byKey.clear();
    root = null; activeResearch = null; hovered = null; hideTip(); closeModal();
  };
  const reset = promptText => { listenLvl = -1; rootShape = 'octahedron'; clearScene(); makeRoot(true, promptText); camTarget.set(0, 0.4, 0); desiredCenter.set(0, 0.4, 0); camDist = 5; desiredDist = 5; userZoom = 1; panX = 0; panY = 0; };
  // PERMISSIONING phase: a DODECAHEDRON root in a distinct cyan, animating the scoper's private
  // round-trips (notes / Wikipedia / agent docs) before powers are proposed.
  const scopeBegin = label => { listenLvl = -1; rootShape = 'dodecahedron'; clearScene(); makeRoot(true, label || 'figuring out what this needs', 0x39c5cf); camTarget.set(0, 0.4, 0); desiredCenter.set(0, 0.4, 0); camDist = 5; desiredDist = 5; userZoom = 1; panX = 0; panY = 0; };

  const toolStart = (name, detail, call) => {
    if (!root) reset();
    const nd = addNode(name, root, level1, { detail: detail || '', call: call || '' }); nd.pending = true; pendingQ.push(nd);
    if (name === 'research') activeResearch = nd;
    relayoutLevel1(); fit();
  };
  const toolDone = (name, ok, detail, children, call, result, granted) => {
    if (!root) reset();
    let nd = pendingQ.find(x => !x.settled && x.name === name) || pendingQ.find(x => !x.settled);
    if (nd) pendingQ.splice(pendingQ.indexOf(nd), 1); else nd = addNode(name, root, level1, { detail: detail || '' });
    if (nd.name !== name) { nd.name = name; setLabel(nd, '⚙ ' + name); }
    if (detail && !nd.detail) nd.detail = detail;
    if (call && !nd.callText) nd.callText = call;
    if (result) nd.resultText = result;
    if (Array.isArray(granted) && granted.length) { nd.granted = granted; buildCrown(nd, granted); }
    settle(nd, ok);
    ensurePowerIcons(nd); // (moons removed — clicking the node opens the call/result modal)
    if (children && children.length && !nd.children.length) buildChildren(children, nd); // only if live didn't already stream them
    relayoutLevel1(); fit();
  };
  // upsert a keyed research-subtree node (live): plan sub-questions, each search/fetch, the distill/synthesis phases
  const rnode = ev => {
    if (!root || !ev || !ev.key) return;
    let nd = byKey.get(ev.key);
    if (!nd) {
      let parent = (ev.parent === 'research' || !ev.parent) ? (activeResearch || root) : (byKey.get(ev.parent) || activeResearch || root);
      if (!parent) return;
      const kind = ev.kind || 'tool';
      nd = addNode(ev.label || kind, parent, parent.children, { key: ev.key, color: KIND_COL[kind], type: kind, detail: ev.detail || '', info: ev.info || '', label: ev.label, persistLabel: kind !== 'tool' });
      byKey.set(ev.key, nd);
      relayoutChildren(parent);
    } else if (ev.label) { setLabel(nd, ev.label); }
    if (ev.detail !== undefined) nd.detail = ev.detail;
    if (ev.info !== undefined && ev.info !== '') nd.info = ev.info;
    if (ev.state === 'done') settle(nd, true);
    else if (ev.state === 'fail') settle(nd, false);
    else if (ev.state === 'pending') nd.pending = true;
    ensurePowerIcons(nd);
    fit();
  };
  // legacy flat child (kept for safety; research now uses rnode)
  const childDone = (parentName, name, ok) => {
    if (!root) return; let parent = null;
    for (let i = level1.length - 1; i >= 0; i -= 1) if (level1[i].name === parentName) { parent = level1[i]; break; }
    if (!parent) return; const k = addNode(name, parent, parent.children); settle(k, ok); relayoutChildren(parent); fit();
  };
  // reconcile against the authoritative final steps[] (covers a dropped/never-opened stream)
  const applyFinal = steps => {
    if (!root) reset();
    (steps || []).forEach((st, i) => {
      let nd = level1[i]; if (!nd) nd = addNode(st.name, root, level1, { detail: st.detail || '', call: st.call || '', result: st.result || '', granted: st.granted });
      if (!nd.detail && st.detail) nd.detail = st.detail;
      if (st.call && !nd.callText) nd.callText = st.call;
      if (st.result && !nd.resultText) nd.resultText = st.result;
      if (Array.isArray(st.granted) && st.granted.length) nd.granted = st.granted;
      if (!nd.settled) settle(nd, st.ok);
      ensurePowerIcons(nd);
      if (st.children && st.children.length && !nd.children.length) buildChildren(st.children, nd);
    });
    pendingQ.slice().forEach(nd => { if (!nd.settled) settle(nd, true); });
    pendingQ.length = 0; relayoutLevel1(); fit();
  };
  const finish = () => { pendingQ.slice().forEach(nd => { if (!nd.settled) settle(nd, true); }); pendingQ.length = 0; };
  // re-render a SAVED trace instantly (no descend/animation) — persistence across navigation
  const showSteps = steps => {
    clearScene(); buildInstant = true; makeRoot(false);
    (steps || []).forEach(st => {
      const k = nameKind(st.name); const nd = addNode(st.name, root, level1, { color: KIND_COL[k], type: k === 'delegate' ? 'delegate' : k, detail: st.detail || '', info: st.info || '', call: st.call || '', result: st.result || '', granted: st.granted });
      settle(nd, st.ok);
      if (st.children && st.children.length) buildChildren(st.children, nd);
    });
    relayoutLevel1(); buildInstant = false; camDist = 5; camTarget.set(0, 0.3, 0); userZoom = 1; panX = 0; panY = 0; fit();
  };

  // ---- hover tooltip (quick peek) ----
  let tip = null;
  const ensureTip = () => { if (tip) return tip; tip = document.createElement('div'); tip.style.cssText = 'position:fixed;z-index:90;max-width:300px;background:#0d1117f2;border:1px solid #30363d;border-radius:8px;padding:7px 9px;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#e6edf3;box-shadow:0 6px 20px rgba(0,0,0,.55);display:none;pointer-events:none'; document.body.appendChild(tip); return tip; };
  function hideTip() { if (tip) tip.style.display = 'none'; }
  const previewOf = ud => {
    const nd = ud.nd;
    if (ud.power) return { title: `${powerIcon(ud.power)} ${ud.power}`, body: `${POWER_LABEL[ud.power] || ud.power} — granted along this edge. Click to inspect.` };
    if (ud.sat === 'call') return { title: '▸ called with', body: callOf(nd) };
    if (ud.sat === 'result') return { title: '◂ returned', body: resultOf(nd) };
    if (nd && nd.viewUrl) return { title: `📺 ${nd.labelText || nd.name}`, body: `Published an embedded view here:\n${nd.viewUrl}` };
    return { title: nd.labelText || nd.name, body: nd.detail || callOf(nd) };
  };
  const showTip = (ud, cx, cy) => {
    const el = ensureTip(); el.innerHTML = ''; const p = previewOf(ud);
    const add = (txt, css) => { if (!txt) return; const d = document.createElement('div'); d.style.cssText = css; d.textContent = txt; el.appendChild(d); };
    add(p.title, 'font-weight:600;margin-bottom:3px');
    add(String(p.body || '').slice(0, 180), 'color:#9fb0c9;word-break:break-word;white-space:pre-wrap;font-size:11px;max-height:84px;overflow:hidden');
    if (p.body) add('click to read…', 'margin-top:4px;color:#6e7681;font-size:10px');
    el.style.display = 'block'; el.style.left = '0px'; el.style.top = '0px';
    const r = el.getBoundingClientRect(); let x = cx + 14, y = cy + 14;
    if (x + r.width > innerWidth - 8) x = Math.max(8, cx - r.width - 14);
    if (y + r.height > innerHeight - 8) y = Math.max(8, cy - r.height - 14);
    el.style.left = x + 'px'; el.style.top = y + 'px';
  };

  // ---- scrollable, draggable modal hovering over the 3D trace (the "read it all" surface) ----
  let modal = null, modalBody = null;
  const closeModal = () => { if (modal) modal.style.display = 'none'; };
  const section = (label, body, color) => {
    const wrap = document.createElement('div'); wrap.style.cssText = 'margin-bottom:10px';
    const h = document.createElement('div'); h.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:4px;color:${color};font-weight:600;font-size:11px`;
    const lbl = document.createElement('span'); lbl.textContent = label; h.appendChild(lbl);
    const copy = document.createElement('button'); copy.textContent = 'copy'; copy.style.cssText = 'all:unset;cursor:pointer;color:#6e7681;font-size:10px;margin-left:auto;border:1px solid #21262d;border-radius:5px;padding:1px 6px';
    copy.onclick = e => { e.stopPropagation(); try { navigator.clipboard.writeText(body); copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy'; }, 1200); } catch { /* ignore */ } };
    h.appendChild(copy);
    const pre = document.createElement('div'); pre.textContent = body; pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9;line-height:1.5;background:#010409;border:1px solid #21262d;border-radius:8px;padding:7px 9px';
    wrap.append(h, pre); return wrap;
  };
  const ensureModal = () => {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;z-index:95;width:min(440px,calc(100vw - 16px));max-height:min(64vh,480px);display:none;flex-direction:column;background:#0d1117f7;border:1px solid #30363d;border-radius:12px;box-shadow:0 16px 54px rgba(0,0,0,.62);overflow:hidden;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#e6edf3';
    const head = document.createElement('div'); head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;border-bottom:1px solid #21262d;background:#161b22;flex:0 0 auto;touch-action:none';
    const title = document.createElement('div'); title.className = 'm-title'; title.style.cssText = 'font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const close = document.createElement('button'); close.textContent = '✕'; close.style.cssText = 'all:unset;cursor:pointer;color:#8b949e;padding:2px 6px;border-radius:6px;font-size:13px';
    close.onmouseenter = () => { close.style.color = '#e6edf3'; }; close.onmouseleave = () => { close.style.color = '#8b949e'; };
    close.onclick = e => { e.stopPropagation(); closeModal(); };
    head.append(title, close);
    modalBody = document.createElement('div'); modalBody.style.cssText = 'padding:9px 10px;overflow:auto;flex:1 1 auto;-webkit-overflow-scrolling:touch';
    modal.append(head, modalBody);
    modal.addEventListener('click', e => e.stopPropagation());
    modal.addEventListener('pointerdown', e => e.stopPropagation());
    modal.addEventListener('wheel', e => e.stopPropagation()); // scroll the modal, not the page / 3D zoom
    let dragging = false, dx = 0, dy = 0, ox = 0, oy = 0;
    head.addEventListener('pointerdown', e => { if (e.target === close) return; dragging = true; dx = e.clientX; dy = e.clientY; const r = modal.getBoundingClientRect(); ox = r.left; oy = r.top; try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ } });
    head.addEventListener('pointermove', e => { if (!dragging) return; modal.style.left = Math.max(8, Math.min(innerWidth - 40, ox + e.clientX - dx)) + 'px'; modal.style.top = Math.max(8, Math.min(innerHeight - 40, oy + e.clientY - dy)) + 'px'; });
    head.addEventListener('pointerup', e => { dragging = false; try { head.releasePointerCapture(e.pointerId); } catch { /* ignore */ } });
    document.body.appendChild(modal);
    return modal;
  };
  const placeModal = (cx, cy) => { const el = ensureModal(); el.style.display = 'flex'; el.style.left = '0px'; el.style.top = '0px'; const r = el.getBoundingClientRect(); let x = (cx || innerWidth / 2) + 16, y = (cy || 120) + 12; if (x + r.width > innerWidth - 8) x = Math.max(8, (cx || innerWidth / 2) - r.width - 16); if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8); el.style.left = x + 'px'; el.style.top = y + 'px'; };
  const openModal = (ud, cx, cy) => {
    if (ud.power) { // inspect a granted capability (room here for an interactive control for the function)
      const el = ensureModal(); el.querySelector('.m-title').textContent = `${powerIcon(ud.power)}  ${ud.power}`;
      modalBody.innerHTML = '';
      modalBody.appendChild(section('capability', POWER_LABEL[ud.power] || ud.power, '#cbbcff'));
      modalBody.appendChild(section('granted along this edge', `This delegation conveys “${ud.power}” to the sub-agent — the arrow IS the authority. An interactive control for this capability can live here.`, '#9fb0c9'));
      placeModal(cx, cy); return;
    }
    const nd = ud.nd; const el = ensureModal();
    el.querySelector('.m-title').textContent = nd.labelText || nd.name || 'node';
    modalBody.innerHTML = '';
    const call = callOf(nd), result = resultOf(nd);
    if (nd.detail && nd.detail !== call) modalBody.appendChild(section('summary', nd.detail, '#9fb0c9'));
    if (call) modalBody.appendChild(section('▸ called with', call, '#39c5cf'));
    if (result) modalBody.appendChild(section('◂ returned', result, '#d29922'));
    if (!call && !result && !nd.detail) modalBody.appendChild(section('node', nd.name || '(no detail captured)', '#9fb0c9'));
    el.style.display = 'flex'; el.style.left = '0px'; el.style.top = '0px';
    const r = el.getBoundingClientRect(); let x = (cx || innerWidth / 2) + 16, y = (cy || 120) + 12;
    if (x + r.width > innerWidth - 8) x = Math.max(8, (cx || innerWidth / 2) - r.width - 16);
    if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
    el.style.left = x + 'px'; el.style.top = y + 'px';
    if (ud.sat) { const idx = ud.sat === 'call' ? '▸' : '◂'; const target = [...modalBody.children].find(s => s.textContent.startsWith(idx)); if (target) target.scrollIntoView({ block: 'nearest' }); }
  };

  // ---- picking + camera control (wheel/pinch zoom, drag pan) ----
  const rc = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pickAt = (cx, cy) => { const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); rc.setFromCamera(ndc, camera); const h = rc.intersectObjects(pickables, false)[0]; return h ? h.object.userData : null; };
  const ptrs = new Map(); let panning = false, pinchDist = 0, dragMoved = false, suppressClick = false, lastPanX = 0, lastPanY = 0, lastMid = null;
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', e => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); dragMoved = false;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y); lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; panning = false; }
    else if (ptrs.size === 1) { const hit = pickAt(e.clientX, e.clientY); panning = !hit; lastPanX = e.clientX; lastPanY = e.clientY; if (!hit) hideTip(); }
  });
  canvas.addEventListener('pointermove', e => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) { userZoom = Math.max(0.25, Math.min(5, userZoom * (pinchDist / d))); dragMoved = true; }
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; const k = camDist * 0.0016;
      if (lastMid) { panX -= (mx - lastMid.x) * k; panY += (my - lastMid.y) * k; }
      lastMid = { x: mx, y: my }; pinchDist = d; hideTip(); return;
    }
    if (panning && ptrs.size === 1) {
      const k = camDist * 0.0016; panX -= (e.clientX - lastPanX) * k; panY += (e.clientY - lastPanY) * k;
      if (Math.abs(e.clientX - lastPanX) + Math.abs(e.clientY - lastPanY) > 1) dragMoved = true;
      lastPanX = e.clientX; lastPanY = e.clientY; hideTip(); return;
    }
    if (e.buttons === 0) { const ud = pickAt(e.clientX, e.clientY); hovered = ud; canvas.style.cursor = ud ? 'pointer' : ''; if (ud) showTip(ud, e.clientX, e.clientY); else hideTip(); }
  });
  const endPtr = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) { pinchDist = 0; lastMid = null; } if (ptrs.size === 0) { if (panning && dragMoved) suppressClick = true; panning = false; } };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('pointerleave', () => { if (!ptrs.size) { hovered = null; hideTip(); } });
  canvas.addEventListener('wheel', e => { e.preventDefault(); userZoom = Math.max(0.25, Math.min(5, userZoom * Math.exp(e.deltaY * 0.0012))); hideTip(); }, { passive: false });
  canvas.addEventListener('click', e => {
    if (suppressClick) { suppressClick = false; e.stopPropagation(); return; } // a pan/pinch just ended — swallow the click
    const ud = pickAt(e.clientX, e.clientY);
    if (ud) { e.stopPropagation(); openModal(ud, e.clientX, e.clientY); } else closeModal(); // empty click bubbles → app.js opens the full trace
  });
  const onDocPtr = e => { if (modal && modal.style.display !== 'none' && !modal.contains(e.target) && e.target !== canvas) closeModal(); };
  document.addEventListener('pointerdown', onDocPtr);

  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const setVisible = v => { visible = !!v; if (!v) { hideTip(); closeModal(); } };

  let listenLvl = -1; // ≥0 = "listening": the user's mic level pulses the ROOT octahedron, so the
                      // agent's core trace icon IS the voice indicator (one continuous identity).
  let last = now();
  renderer.setAnimationLoop(() => {
    const t = now(); const dt = Math.min(0.05, t - last); last = t;
    if (!visible) return;
    for (let i = tweens.length - 1; i >= 0; i -= 1) { const tw = tweens[i]; const p = clamp01((t - tw.t0) / tw.dur); tw.apply(tw.ease(p)); if (p >= 1) tweens.splice(i, 1); }
    for (const nd of nodes) {
      nd.group.rotateOnAxis(nd.axis, dt * nd.spin); // idle spin
      const hot = !!(hovered && hovered.nd === nd && !hovered.sat);
      let target = nd.pending ? (0.5 + 0.5 * Math.abs(Math.sin(t * 3.0))) : (hot ? 1.7 : 1.0); // pulse while in-flight; brighten on hover
      if (listenLvl >= 0 && nd === root) { // listening: the core octahedron breathes with the user's voice
        target = 1.0 + listenLvl * 2.2;
        const s = 1.0 + listenLvl * 0.22; nd.group.scale.setScalar(nd.group.scale.x + (s - nd.group.scale.x) * Math.min(1, dt * 12));
      }
      const cur = nd.wireMat.uniforms.uIntensity.value + (target - nd.wireMat.uniforms.uIntensity.value) * Math.min(1, dt * 9);
      nd.wireMat.uniforms.uIntensity.value = cur; nd.glowMat.uniforms.uIntensity.value = cur;
      if (nd.lineMat) nd.lineMat.uniforms.uIntensity.value = 0.3 + cur * 0.3; // OUT edge
      if (nd.backLineMat) nd.backLineMat.uniforms.uIntensity.value = 0.25 + cur * 0.25; // BACK edge
      if (nd.powerIcons.length) positionPowerIcons(nd); // granted-power icons ride the delegation edge
      if (nd.crown.length) positionCrown(nd); // the power crown rides above the agent
    }
    updateLifeline(dt); // the agent's time-extruded body grows to the latest step + spins
    camTarget.lerp(desiredCenter, 1 - Math.pow(0.0008, dt));
    camDist += (desiredDist * userZoom - camDist) * (1 - Math.pow(0.0008, dt));
    autoAz += dt * 0.14; // continuous slow turn (~one gentle revolution every ~45s)
    const tx = camTarget.x + panX, ty = camTarget.y + panY;
    const ox = camDist * 0.16, oz = camDist * 0.985; // the base camera offset, rotated around the axis by autoAz
    camera.position.set(tx + ox * Math.cos(autoAz) - oz * Math.sin(autoAz), ty + camDist * 0.06, camTarget.z + ox * Math.sin(autoAz) + oz * Math.cos(autoAz));
    camera.lookAt(tx, ty, camTarget.z);
    renderer.render(scene, camera);
  });

  // Voice-listening: lvl≥0 makes the root octahedron pulse with the mic level (creating it if the
  // scene is empty); lvl<0 stops listening and restores the root to rest. Used INSTEAD of a separate orb.
  const setListen = lvl => { const v = (typeof lvl === 'number') ? lvl : -1; if (v >= 0 && !root) reset(''); listenLvl = v; if (v < 0 && root) root.group.scale.setScalar(1); };
  // the chat's powers → the ROOT agent's crown (the powers it holds, hovering above it, inspectable).
  const setRootPowers = powers => { if (root && Array.isArray(powers) && powers.length) buildCrown(root, powers); };

  return { reset, scopeBegin, toolStart, toolDone, rnode, childDone, applyFinal, finish, showSteps, resize, setVisible, setListen, setRootPowers,
    dispose: () => { renderer.setAnimationLoop(null); document.removeEventListener('pointerdown', onDocPtr); clearScene(); if (tip) tip.remove(); if (modal) modal.remove(); renderer.dispose(); } };
};
