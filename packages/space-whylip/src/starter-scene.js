// @ts-check

/** Reader state belongs to the book session and survives scene source edits. */
export const STARTER_STATE = harden({
  title: 'The forest that remembered',
  chapter: 'I · A light in the leaves',
  lanternLit: false,
  firefliesAwake: false,
  path: null,
  narration: '',
});
harden(STARTER_STATE);

/** A keyed Three.js diorama and accessible Preact controls share durable state. */
export const STARTER_SCENE = `({ h }, { state, act, update }) => {
  const lit = Boolean(state.lanternLit);
  const awake = Boolean(state.firefliesAwake);
  const rings = Number(state.bellRings || 0);
  const choose = path => {
    update({ path, narration: '' });
    act('choose-path', { path, lanternLit: lit, firefliesAwake: awake });
  };
  const ring = () => {
    const next = rings + 1;
    update({ bellRings: next });
    act('ring-bell', { rings: next });
  };
  const material = (color, extra = {}) => ({ color, roughness: 0.85, ...extra });
  const mesh = (key, geometry, paint, position, extra = {}) =>
    h('mesh', { key, geometry, material: paint, position, ...extra });
  const box = (width, height, depth) => ({ type: 'box', width, height, depth });
  const sphere = radius => ({ type: 'sphere', radius, widthSegments: 12, heightSegments: 8 });
  const tree = (key, x, z, scale) => h('group', { key, position: [x, 0, z], scale: [scale, scale, scale] },
    mesh(key + '-trunk', { type: 'cylinder', radiusTop: 0.13, radiusBottom: 0.22, height: 2.8, radialSegments: 7 }, material('#594e42'), [0, 1.2, 0]),
    mesh(key + '-lower', { type: 'cone', radius: 1.15, height: 2.9, radialSegments: 7 }, material('#244b43'), [0, 2.4, 0]),
    mesh(key + '-upper', { type: 'cone', radius: 0.85, height: 2.4, radialSegments: 7 }, material('#326056'), [0, 3.5, 0])
  );
  const scene = h('scene', { key: 'world', background: '#0c1b25' },
    h('perspectiveCamera', { key: 'camera', position: [10, 9, 16], lookAt: [0, 0.6, 0], fov: 43, near: 0.1, far: 100 }),
    h('ambientLight', { key: 'ambient', color: '#a8cbd5', intensity: 1.15 }),
    h('directionalLight', { key: 'moonlight', color: '#c4e1ed', intensity: 2.2, position: [-4, 10, 3], target: [0, 0, 0] }),
    mesh('island', { type: 'cylinder', radiusTop: 7.3, radiusBottom: 6.5, height: 0.8, radialSegments: 16 }, material('#233e38'), [0, -0.6, 0]),
    mesh('river', box(2.2, 0.08, 13), material('#367d91', { emissive: '#143947', emissiveIntensity: state.path === 'river' ? 0.8 : 0.35, metalness: 0.3, roughness: 0.35 }), [0, -0.14, 0]),
    ...[-5.5, -4.4, -3.3, -2.2, -1.1, 1.7, 2.8, 3.9, 5].map((z, i) =>
      mesh('water-glint-' + i, box(0.35 + (i % 3) * 0.2, 0.018, 0.035), material('#a3cdd0', { emissive: '#648d9a', emissiveIntensity: 0.4 }), [(i % 2 ? 1 : -1) * 0.3, -0.085, z])
    ),
    mesh('left-path', box(3.6, 0.055, 1.15), material('#998568'), [-3, -0.12, 0.35], { rotation: [0, -0.18, 0] }),
    mesh('right-path', box(3.5, 0.055, 1.15), material('#998568'), [3, -0.12, 0.35], { rotation: [0, 0.16, 0] }),
    h('group', { key: 'bridge', position: [0, 0.05, 0.35] },
      ...[-3, -2, -1, 0, 1, 2, 3].map(i => mesh('bridge-plank-' + i, box(0.43, 0.16, 1.5), material(i % 2 ? '#a58b65' : '#b99c75'), [i * 0.44, 0.14, 0])),
      ...[-1, 1].flatMap(x => [-1, 1].map(z => mesh('bridge-post-' + x + '-' + z, box(0.12, 0.8, 0.12), material('#7c684d'), [x * 1.35, 0.48, z * 0.7]))),
      ...[-1, 1].map(z => mesh('bridge-rail-' + z, box(2.9, 0.09, 0.09), material('#d0b487'), [0, 0.78, z * 0.7]))
    ),
    ...[[-4.8,-3.5,1.1],[-2.7,-4.7,1.25],[2.6,-4.9,1.05],[4.7,-3.3,1.2],[-5.7,-0.6,0.9],[5.7,-0.7,0.9],[-4.8,2.6,0.65],[4.8,2.8,0.7],[-2.5,-2.8,0.8],[3.4,-2.6,0.8]].map(([x,z,s],i) => tree('pine-' + i, x,z,s)),
    ...[[-1.4,4.6,0.45],[1.6,4.1,0.35],[-3.7,1.8,0.28],[2.5,2.8,0.3]].map(([x,z,r],i) => mesh('stone-' + i, sphere(r), material('#81918e'), [x, r * 0.35, z], { scale: [1.4, 0.65, 1] })),
    mesh('moon', sphere(0.85), material('#f1e8bb', { emissive: '#f1e8bb', emissiveIntensity: 1 }), [-4.5, 7, -6]),
    h('group', { key: 'lantern', position: [-2.2, 0, 1.8] },
      mesh('lantern-post', box(0.12, 1.9, 0.12), material('#775e44'), [0, 0.85, 0]),
      mesh('lantern-arm', box(0.7, 0.1, 0.12), material('#775e44'), [0.25, 1.75, 0]),
      mesh('lantern-base', { type: 'cylinder', radiusTop: 0.23, radiusBottom: 0.23, height: 0.09, radialSegments: 8 }, material('#ba9552', { metalness: 0.65 }), [0.5, 1.05, 0]),
      mesh('lantern-glow', sphere(0.21), material(lit ? '#ffdf83' : '#718b84', { emissive: lit ? '#ffbb45' : '#152826', emissiveIntensity: lit ? 2 : 0 }), [0.5, 1.3, 0], { scale: [0.8, 1.25, 0.8], onClick: () => update({ lanternLit: !lit }) }),
      mesh('lantern-roof', { type: 'cone', radius: 0.29, height: 0.23, radialSegments: 8 }, material('#ba9552', { metalness: 0.65 }), [0.5, 1.62, 0]),
      h('pointLight', { key: 'lantern-light', position: [0.5, 1.3, 0.35], color: '#ffd28b', intensity: lit ? 9 : 0, distance: 5, decay: 2 })
    ),
    h('group', { key: 'fireflies', visible: awake },
      ...[[-2.8,1.9,2.6],[-3.2,1.2,1.3],[-1.5,2.2,2.3],[1.6,1.8,2.5],[2.2,2.4,1.9]].map((position,i) => mesh('firefly-' + i, sphere(0.045), material('#e7f9a1', { emissive: '#e7f9a1', emissiveIntensity: 2 }), position))
    ),
    h('group', { key: 'owl', position: [3.45, 1.85, -2.1], visible: state.showOwl !== false && (Boolean(state.showOwl) || state.path === 'river' || Boolean(state.showBell)) },
      mesh('owl-body', sphere(0.36), material('#43526a'), [0,0,0], { scale: [0.85,1.25,0.7] }),
      mesh('owl-head', sphere(0.31), material('#63718a'), [0,0.4,0]),
      ...[-1,1].map(side => mesh('owl-eye-' + side, sphere(0.09), material('#ffca62', { emissive: '#d79a36', emissiveIntensity: 0.4 }), [side * 0.13,0.43,0.25])),
      ...[-1,1].map(side => mesh('owl-pupil-' + side, sphere(0.042), material('#172532'), [side * 0.13,0.43,0.32])),
      mesh('owl-beak', { type:'cone',radius:0.07,height:0.17,radialSegments:4 }, material('#ddb578'), [0,0.27,0.3], { rotation:[Math.PI / 2,0,0] })
    ),
    h('group', { key: 'bell-frame', position: [2.15,0,1.85], visible: Boolean(state.showBell) },
      ...[-1,1].map(side => mesh('bell-post-' + side, box(0.12,1.75,0.12), material('#80684b'), [side * 0.55,0.78,0])),
      mesh('bell-beam', box(1.35,0.13,0.17), material('#ac8e5d'), [0,1.65,0]),
      h('group', { key: 'bell-swing', position: [0,1.45,0], rotation: [0,0,rings ? (rings % 2 ? 0.18 : -0.18) : 0] },
        mesh('bell-body', { type:'cylinder',radiusTop:0.12,radiusBottom:0.35,height:0.48,radialSegments:12 }, material('#d3ac58', { metalness:0.65,roughness:0.3,emissive:rings ? '#73511c' : '#17120a',emissiveIntensity:rings ? 0.65 : 0 }), [0,-0.24,0], { onClick:ring }),
        mesh('bell-lip', { type:'torus',radius:0.34,tube:0.045,radialSegments:6,tubularSegments:12 }, material('#ebca77',{metalness:0.6}), [0,-0.48,0], { rotation:[Math.PI / 2,0,0],onClick:ring }),
        mesh('bell-clapper', sphere(0.075), material('#674822'), [0,-0.54,0], { onClick:ring })
      )
    )
  );
  const chip = { border:'1px solid #adbeaa55',borderRadius:'999px',padding:'10px 14px',background:'#10252ee6',color:'#f2e7ca',font:'inherit',fontSize:'13px',cursor:'pointer',pointerEvents:'auto' };
  const overlay = h('section', { key:'storybook',class:'book-world-overlay','aria-label':'The forest that remembered',style:{width:'100%',height:'100%',minHeight:'calc(100dvh - 76px)',boxSizing:'border-box',padding:'clamp(16px,3vw,40px)',display:'flex',flexDirection:'column',justifyContent:'space-between',gap:'20px',pointerEvents:'none'} },
    h('div', { key:'explore',style:{display:'flex',flexWrap:'wrap',gap:'8px',maxWidth:'540px'} },
      h('button', { key:'lantern',type:'button','aria-label':lit ? 'Dim the lantern' : 'Light the lantern','aria-pressed':lit,style:chip,onClick:()=>update({lanternLit:!lit}) }, lit ? '✦ Lantern lit' : '✦ Light the lantern'),
      h('button', { key:'fireflies',type:'button','aria-label':awake ? 'Let the fireflies rest' : 'Wake the fireflies','aria-pressed':awake,style:chip,onClick:()=>update({firefliesAwake:!awake}) }, awake ? '· Fireflies awake' : '· Wake the fireflies'),
      state.showBell && h('button', { key:'bell',type:'button','aria-label':'Ring the bell',style:chip,onClick:ring }, rings ? '♫ Ring again' : '♫ Ring the bell'),
      rings > 0 && h('span', { key:'bell-feedback','aria-live':'polite',style:{padding:'10px 4px',color:'#f3d99b',fontSize:'13px'} }, 'The bell sings.')
    ),
    h('div', { key:'page',style:{alignSelf:'flex-end',width:'min(460px,100%)',boxSizing:'border-box',padding:'clamp(18px,3vw,28px)',border:'1px solid #9eae9d44',borderRadius:'18px',background:'#0d202bea',boxShadow:'0 16px 60px #0004',color:'#f2e8ce',pointerEvents:'auto'} },
      h('p', { key:'chapter',style:{margin:'0 0 10px',fontSize:'10px',letterSpacing:'0.2em',textTransform:'uppercase',color:'#d8bf84'} }, state.chapter || 'I · A light in the leaves'),
      h('h1', { key:'title',style:{margin:'0 0 14px',fontFamily:'Georgia,serif',fontSize:'clamp(24px,3vw,38px)',fontWeight:400,lineHeight:1.05,letterSpacing:'-0.035em'} }, state.title || 'The forest that remembered'),
      h('div', { key:'narration','aria-live':'polite',style:{fontFamily:'Georgia,serif',fontSize:'14px',lineHeight:1.5,color:'#d0d9ce'} },
        !state.narration && !state.path && h('p', {style:{margin:'0 0 8px'}}, 'At the edge of a very ordinary evening, you found a forest that had not been there before.'),
        h('p', {style:{margin:'0 0 16px'}}, state.narration || (state.path ? (state.path === 'river' ? 'You turn toward the water. Somewhere ahead, a small bell answers your footsteps.' : 'The leaves lean closer, as if remembering your name.') : lit ? 'Two paths appear: one follows the silver river; the other disappears into whispering leaves.' : 'An unlit lantern waits by the bridge. Perhaps the forest is waiting for you.'))
      ),
      h('div', {key:'choices',style:{display:'flex',flexWrap:'wrap',gap:'8px'},'aria-label':'Choose where the story goes'},
        h('button', {key:'river',type:'button','aria-pressed':state.path === 'river',style:{...chip,borderRadius:'8px',flex:'1 1 150px',background:state.path === 'river' ? '#24434c' : '#152d37'},onClick:()=>choose('river')}, '≈ Follow the river'),
        h('button', {key:'woods',type:'button','aria-pressed':state.path === 'woods',style:{...chip,borderRadius:'8px',flex:'1 1 150px',background:state.path === 'woods' ? '#24434c' : '#152d37'},onClick:()=>choose('woods')}, '✧ Enter the whispering woods')
      ),
      h('p', {key:'hint',style:{margin:'14px 0 0',fontSize:'11px',color:'#9caeaa'}}, 'Explore the world. Choose a path. This book listens.')
    )
  );
  return { scene, overlay };
}`;
harden(STARTER_SCENE);
