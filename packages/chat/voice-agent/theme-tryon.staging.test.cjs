const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
const ok=(c,m)=>{console.log((c?'  ok - ':'  FAIL - ')+m); if(!c)process.exitCode=1;};
(async()=>{
  const chromium=loadChromium();
  if(!chromium){console.log('SKIP');return}
  const srv=await startIsolatedServer();
  const br=await launchBrowser(chromium);
  try{
    const page=await br.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.route('**/app.js',r=>r.fulfill({status:200,contentType:'application/javascript',body:'/*blocked*/'}));
    await page.route('**/__t.mjs',r=>r.fulfill({status:200,contentType:'application/javascript',body:`
      import { renderWidgets } from '/grain-ui.js';
      const box=document.createElement('div'); box.id='b'; document.body.appendChild(box);
      renderWidgets(box,[{type:'theme-preview',themes:[
        {name:'Cyber',vars:{'--acc':'#ff0066','--bg':'#0a0a14','--panel':'#15151f','--edge':'#333','--ink':'#eee','--mut':'#999'}},
        {name:'Forest',vars:{'--acc':'#22cc66','--bg':'#0c130c','--panel':'#162016','--edge':'#2a3','--ink':'#eef','--mut':'#9a9'}},
        {name:'Amber',vars:{'--acc':'#ffaa22','--bg':'#1a1206','--panel':'#241a0c','--edge':'#420','--ink':'#fed','--mut':'#a97'}}]}],{});
      window.__d=true;`}));
    await page.goto(`${srv.base}/`,{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{const s=document.createElement('script');s.type='module';s.src='/__t.mjs';document.body.appendChild(s);});
    await page.waitForFunction(()=>window.__d===true,{timeout:5000});
    const r1=await page.evaluate(()=>{const w=document.querySelector('.gw-theme'); return {chips:w.querySelectorAll('button').length, hasKeep:/Keep/.test(w.textContent), hasRevert:/Revert/.test(w.textContent), tryOn:/Try on a theme/.test(w.textContent), acc0:getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()};});
    ok(r1.tryOn,'shows "Try on a theme"');
    ok(r1.chips>=5,`a swatch per theme + Keep + Revert (buttons: ${r1.chips})`);
    ok(r1.hasKeep && r1.hasRevert,'has Keep + Revert');
    // click the 2nd swatch (Forest #22cc66) → applies live
    await page.evaluate(()=>{const w=document.querySelector('.gw-theme'); const sw=[...w.querySelectorAll('button')].find(b=>/Forest/.test(b.textContent)); sw.click();});
    await page.waitForTimeout(200);
    ok((await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()))==='#22cc66','clicking a swatch applies it LIVE to :root');
    // Revert restores the original accent
    await page.evaluate(()=>{const w=document.querySelector('.gw-theme'); [...w.querySelectorAll('button')].find(b=>/Revert/.test(b.textContent)).click();});
    await page.waitForTimeout(200);
    const accAfter=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
    ok(accAfter!=='#22cc66','Revert restores the original (not the tried-on accent)');
    ok(errs.length===0,'no page errors ('+errs.slice(0,2).join(' | ')+')');
    await page.close();
  } finally{await br.close();srv.close();}
})();
