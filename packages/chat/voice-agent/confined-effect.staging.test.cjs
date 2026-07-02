const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
const ok=(c,m)=>{console.log((c?'  ok - ':'  FAIL - ')+m); if(!c)process.exitCode=1;};
(async()=>{
  const chromium=loadChromium();
  if(!chromium){console.log('SKIP');return}
  const srv=await startIsolatedServer();
  const br=await launchBrowser(chromium);
  const run=async (grant)=>{
    const page=await br.newPage();
    await page.route('**/app.js',r=>r.fulfill({status:200,contentType:'application/javascript',body:'/*blocked*/'}));
    await page.route('**/__t.mjs',r=>r.fulfill({status:200,contentType:'application/javascript',body:`
      import { renderWidgets } from '/grain-ui.js';
      const box=document.createElement('div'); document.body.appendChild(box);
      const src=String((ui)=>{ ui.effect('theme:apply',{name:'Cyber',vars:{'--acc':'#abcdef','--bg':'#010203'}}); return ui.create('div').text('themed'); });
      renderWidgets(box,[{type:'component',source:src,height:60 ${grant?", effects:['theme']":''} }],{});
      window.__d=true;`}));
    await page.goto(`${srv.base}/`,{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{const s=document.createElement('script');s.type='module';s.src='/__t.mjs';document.body.appendChild(s);});
    await page.waitForFunction(()=>window.__d===true,{timeout:5000});
    await page.waitForTimeout(2500); // iframe ready→mount→component fires ui.effect→parent applies
    const acc=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
    await page.close(); return acc;
  };
  const granted=await run(true);
  ok(granted==='#abcdef',`GRANTED effects:['theme'] → ui.effect applied the theme to :root (--acc=${granted})`);
  const denied=await run(false);
  ok(denied!=='#abcdef',`NOT granted → ui.effect IGNORED (no restyle; --acc=${denied})`);
  await br.close();
  srv.close();
})();
