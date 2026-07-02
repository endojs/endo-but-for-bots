// widget-tail: a widget box has a 💬 chat-tail; tapping it focuses the composer + carries the widget as
// context, so the next message reaches the entrypoint agent knowing which widget the user meant.
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
    let chatText=null;
    await page.route('**/chat',r=>{ if(r.request().method()==='POST'){ try{chatText=JSON.parse(r.request().postData()||'{}').text}catch{} return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,answer:'ok',steps:[],ui:[]})}); } r.continue(); });
    await page.route('**/chat/steps**',r=>r.fulfill({status:200,contentType:'text/event-stream',body:''}));
    await page.addInitScript(c=>{ try{ localStorage.setItem('field-agent-cap',c); const id='chat-tail-localonly';
      localStorage.setItem('field-agent-chats',JSON.stringify([{id,title:'tail',ts:Date.now(),lastMsgAt:Date.now()}]));
      localStorage.setItem('field-agent-active',id);
      localStorage.setItem('field-agent-tx-'+id,JSON.stringify([{who:'you',text:'theme me'},{who:'agent',text:'here is a theme',ui:[{type:'theme-preview',name:'Dweb',vars:{'--bg':'#0a0a18','--acc':'#5c7cff'}}]}]));
    }catch{} },cap);
    await page.goto(`${srv.base}/`,{waitUntil:'load'}); await page.waitForTimeout(3500);
    await page.evaluate(()=>{const it=[...document.querySelectorAll('.chat-item .ci-title')].find(s=>/tail/.test(s.textContent)); if(it)it.click();}); await page.waitForTimeout(700);
    ok(await page.evaluate(()=>!!document.querySelector('.gw-tail')),'the theme widget box has a 💬 chat-tail');
    await page.evaluate(()=>{const t=document.querySelector('.gw-tail'); if(t)t.click();}); await page.waitForTimeout(300);
    ok(await page.evaluate(()=>/About the 🎨 theme above/.test(document.getElementById('text').value)),'tapping the tail seeds + focuses the composer about the theme widget');
    // type a request + send → the widget context rides along to the agent
    await page.evaluate(()=>{const t=document.getElementById('text'); t.value='let me try on different themes'; });
    await page.evaluate(()=>{const b=document.getElementById('send'); if(b)b.click();}); await page.waitForTimeout(700);
    ok(chatText && /try on different themes/.test(chatText) && /theme-preview/.test(chatText) && /discuss or change it/.test(chatText),'the sent message carries the user text + the widget context');
    ok(errs.length===0,`no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally{await br.close();srv.close();}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error('test error:',e&&e.stack||e);process.exit(2)});
