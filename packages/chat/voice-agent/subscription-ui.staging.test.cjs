const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
let pass=0,fail=0; const ok=(c,m)=>{if(c){pass++;console.log('  ok -',m)}else{fail++;console.error('  FAIL -',m)}};
(async()=>{
  const chromium=loadChromium();
  if(!chromium){console.log('SKIP');process.exit(0)}
  const srv=await startIsolatedServer();
  const cap=srv.cap;
  // seed the ISOLATED gator-pay config so gatorConfigured()→true and the on-chain subscription card renders
  // (was: relied on the LIVE box's real gator-pay.json). The wallet grant itself still fails — the test's
  // window.ethereum mock answers the OLD wallet_grantPermissions, but the client now calls
  // wallet_requestExecutionPermissions, so the "subscribed" step fails here exactly as it does against live.
  const fs=require('node:fs'); const path=require('node:path');
  fs.writeFileSync(path.join(srv.dir,'config','gator-pay.json'), JSON.stringify({ chargeServerUrl:'http://127.0.0.1:1/noop', treasury:'0x0000000000000000000000000000000000000001', chain:'sepolia', chainId:'0xaa36a7', weiPerUusd:'1' }));
  const http=require('node:http');
  const inv=await new Promise((r,j)=>{const q=http.request(`${srv.base}/invite`,{method:'POST',headers:{'content-type':'application/json'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r(JSON.parse(d)))});q.on('error',j);q.end(JSON.stringify({cap,powers:['reference','home'],label:'SubUiGuest'}))});
  const br=await launchBrowser(chromium);
  try{
    const page=await br.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.addInitScript(c=>{try{localStorage.setItem('field-agent-cap',c)}catch{}
      window.ethereum={request:async({method})=>{ if(method==='wallet_grantPermissions') return {context:'0xMOCKGRANT'}; return null; }};},inv.scopedCap);
    await page.goto(`${srv.base}/`,{waitUntil:'load'}); await page.waitForTimeout(3500);
    await page.evaluate(()=>{const f=document.getElementById('drawer-foot'); if(f)f.click();}); await page.waitForTimeout(400);
    await page.evaluate(()=>{const b=[...document.querySelectorAll('.setnav-item')].find(x=>/Provider/.test(x.textContent)); if(b)b.click();}); await page.waitForTimeout(700);
    ok(await page.evaluate(()=>/MetaMask subscription/.test(document.body.innerText) && !!document.getElementById('sub-go')),'subscription card shows when on-chain settlement is available');
    await page.evaluate(()=>document.getElementById('sub-go').click()); await page.waitForTimeout(1500);
    ok(await page.evaluate(()=>/Subscribed/.test(document.body.innerText)||/subscribed/.test(document.body.innerText)),'set-up grants + shows subscribed');
    ok(errs.length===0,`no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally{await br.close();srv.close();}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error('test error:',e&&e.stack||e);process.exit(2)});
