const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
const ok=(c,m)=>{console.log((c?'  ok - ':'  FAIL - ')+m); if(!c)process.exitCode=1;};
(async()=>{
  const chromium=loadChromium();
  if(!chromium){console.log('  SKIP');return;}
  const srv=await startIsolatedServer();
  const br=await launchBrowser(chromium);
  try{
    const page=await br.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.route('**/app.js',r=>r.fulfill({status:200,contentType:'application/javascript',body:'/*blocked*/'}));
    await page.route('**/__t.mjs',r=>r.fulfill({status:200,contentType:'application/javascript',body:`
      import { renderWidgets } from '/grain-ui.js';
      const box=document.createElement('div'); box.id='b'; document.body.appendChild(box);
      renderWidgets(box,[{type:'site-preview',url:'https://archua.taildd002.ts.net/sites/a9fabaf058eab534/',name:'SK936 Jet-Lag Plan'}],{});
      window.__d=true;`}));
    await page.goto(`${srv.base}/`,{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{const s=document.createElement('script');s.type='module';s.src='/__t.mjs';document.body.appendChild(s);});
    await page.waitForFunction(()=>window.__d===true,{timeout:5000});
    const r=await page.evaluate(()=>{const w=document.querySelector('.gw-site'); const t=w.textContent; const ifr=w.querySelector('iframe'); return {expand:/⤢/.test(t),share:/Share/.test(t),open:/Open/.test(t),src:ifr&&ifr.getAttribute('src')};});
    ok(r.expand,'Expand (⤢) button present');
    ok(r.share,'Share button present');
    ok(r.open,'Open ↗ button present');
    ok(r.src==='/sites/a9fabaf058eab534/','thumbnail iframe is same-origin');
    // click expand → overlay with interactive iframe appears
    await page.evaluate(()=>{[...document.querySelectorAll('.gw-site button')].find(b=>/⤢/.test(b.textContent)).click();});
    await page.waitForTimeout(200);
    const ov=await page.evaluate(()=>{const f=[...document.querySelectorAll('iframe')].find(i=>i.src.includes('/sites/')&&i.getAttribute('sandbox')&&i.getAttribute('sandbox').includes('allow-forms')); return !!f;});
    ok(ov,'Expand opens a full interactive overlay iframe');
    ok(errs.length===0,'no page errors ('+errs.slice(0,2).join(' | ')+')');
    await page.close();
  } finally{await br.close();srv.close();}
})();
