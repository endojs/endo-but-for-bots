// clip-share: every message has a quiet 🔗 corner button that clips it (or a highlighted segment) into a
// shareable page, then offers copy/QR/open. The /clip/create is mocked so the test creates no real clips.
const { startIsolatedServer, loadChromium, launchBrowser } = require('./test-harness.cjs');
let pass=0,fail=0; const ok=(c,m)=>{if(c){pass++;console.log('  ok -',m)}else{fail++;console.error('  FAIL -',m)}};
(async()=>{
  const chromium=loadChromium();
  if(!chromium){console.log('  SKIP');console.log(`\n${pass} passed, ${fail} failed (skipped)`);process.exit(0)}
  const srv=await startIsolatedServer();
  const cap=srv.cap;
  const br=await launchBrowser(chromium);
  try{
    const page=await br.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    let clipBody=null;
    await page.route('**/clip/create',r=>{ try{clipBody=JSON.parse(r.request().postData()||'{}')}catch{} return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,token:'abc123',name:clipBody&&clipBody.title||'Clip',url:'https://x/sites/abc123/'})}); });
    await page.addInitScript(c=>{ try{ localStorage.setItem('field-agent-cap',c); const id='chat-clip-localonly';
      localStorage.setItem('field-agent-chats',JSON.stringify([{id,title:'clip',ts:Date.now(),lastMsgAt:Date.now()}]));
      localStorage.setItem('field-agent-active',id);
      localStorage.setItem('field-agent-tx-'+id,JSON.stringify([{who:'you',text:'plan my fair day'},{who:'agent',text:'### Fair Plan\n\n- 10am animals\n- 12pm magic show\n- 2pm food: allergy-safe options'}]));
    }catch{} },cap);
    await page.goto(`${srv.base}/`,{waitUntil:'load'}); await page.waitForTimeout(3500);
    await page.evaluate(()=>{const it=[...document.querySelectorAll('.chat-item .ci-title')].find(s=>/clip/.test(s.textContent)); if(it)it.click();}); await page.waitForTimeout(600);
    const nbtns=await page.evaluate(()=>document.querySelectorAll('.msg .msg-clip').length);
    ok(nbtns>=2,`every message has a 🔗 clip button (found ${nbtns})`);
    // click the clip button on the agent message (whole-message clip)
    await page.evaluate(()=>{const m=[...document.querySelectorAll('.msg:not(.user)')].find(x=>/Fair Plan/.test(x.textContent)); const b=m&&m.querySelector('.msg-clip'); if(b)b.click();});
    await page.waitForTimeout(700);
    ok(clipBody && /Fair Plan/.test(clipBody.title||'') && /allergy-safe/.test(clipBody.html||''),`clip sent the rendered message (title "${clipBody&&clipBody.title}")`);
    ok(await page.evaluate(()=>/Clip created/.test(document.body.innerText) && !!document.getElementById('clip-copy')),'share sheet shows with copy/QR/open');
    ok(errs.length===0,`no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally{await br.close();srv.close();}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error('test error:',e&&e.stack||e);process.exit(2)});
