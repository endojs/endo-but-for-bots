import '/home/user/endo-but-for-bots/packages/ses/index.js';
globalThis.tag = 'start';
function hoisted() { return tag; }
lockdown();
const afterLock = () => tag;
const writer = () => { globalThis.w = 1; };
const c = new Compartment({ __options__: true, globals: { hoisted, afterLock, writer, tag: 'child' } });
const afterFlip = () => tag;
const c2 = new Compartment({ __options__: true, globals: { afterFlip, tag: 'child2' } });
const r = {
  hoisted: c.evaluate('hoisted()'),
  afterLock: c.evaluate('afterLock()'),
  afterFlip: c2.evaluate('afterFlip()'),
  startCall: afterLock(),
};
c.evaluate('writer()');
r.wOnStart = typeof globalThis.w;
r.wOnChild = c.evaluate('typeof w');
console.log(JSON.stringify(r));
