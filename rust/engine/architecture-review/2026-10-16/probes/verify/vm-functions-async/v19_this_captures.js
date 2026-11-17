const log = [];
class B {}
let pending;
class D extends B {
  constructor() {
    pending = (async () => { const b = () => this; await 0; super(); return b; })();
  }
}
try { new D(); } catch (e) { log.push('ctor ' + e.constructor.name); }
pending.then(function (b) { try { log.push('b() ' + (b() instanceof D)); } catch (e) { log.push('b() threw ' + e.constructor.name); } },
             function (e) { log.push('rejected ' + e.constructor.name); });
after(10, function () { report(JSON.stringify(log)); });
