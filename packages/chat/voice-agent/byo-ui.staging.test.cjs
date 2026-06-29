const fs=require('node:fs'); const cap=fs.readFileSync(require('node:os').homedir()+'/.config/field-agent/root.swiss','utf8').trim();
let pass=0,fail=0; const ok=(c,m)=>{if(c){pass++;console.log('  ok -',m)}else{fail++;console.error('  FAIL -',m)}};
(async()=>{
  let chromium=null; try{({chromium}=require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core'))}catch{}
  if(!chromium){console.log('  SKIP');process.exit(0)}
  const http=require('node:http');
  const invite=await new Promise((res,rej)=>{const r=http.request('http://127.0.0.1:8778/invite',{method:'POST',headers:{'content-type':'application/json'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res(JSON.parse(d)))});r.on('error',rej);r.end(JSON.stringify({cap,powers:['reference','home'],label:'ByoUiGuest'}))});
  const br=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],env:{...process.env,LD_LIBRARY_PATH:'/var/lib/obsidian/oldlibs'}});
  try{
    const page=await br.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.addInitScript(c=>{try{localStorage.setItem('field-agent-cap',c)}catch{}},invite.scopedCap);
    await page.goto('http://127.0.0.1:8778/',{waitUntil:'load'}); await page.waitForTimeout(3500);
    await page.evaluate(()=>{const f=document.getElementById('drawer-foot'); if(f)f.click();}); await page.waitForTimeout(500);
    // click the Provider nav tab
    await page.evaluate(()=>{const b=[...document.querySelectorAll('.setnav-item')].find(x=>/Provider/.test(x.textContent)); if(b)b.click();}); await page.waitForTimeout(500);
    ok(await page.evaluate(()=>!!document.getElementById('byo-key')),'invitee Settings → Provider tab shows the BYO connect form');
    await page.evaluate(()=>{document.getElementById('byo-prov').value='anthropic'; document.getElementById('byo-model').value='claude-sonnet-4-6'; document.getElementById('byo-key').value='sk-ant-UITESTKEY';});
    await page.evaluate(()=>document.getElementById('byo-save').click()); await page.waitForTimeout(1400);
    ok(await page.evaluate(()=>/Connected/.test(document.body.innerText)),'connecting shows Connected');
    ok(!await page.evaluate(()=>document.body.innerHTML.includes('UITESTKEY')),'API key NOT left in the DOM');
    await page.evaluate(()=>{const b=document.getElementById('byo-clear'); if(b)b.click();}); await page.waitForTimeout(900);
    ok(!await page.evaluate(()=>/Connected/.test(document.body.innerText)),'disconnect clears it');
    ok(errs.length===0,`no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally{await br.close();}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error('test error:',e&&e.stack||e);process.exit(2)});
