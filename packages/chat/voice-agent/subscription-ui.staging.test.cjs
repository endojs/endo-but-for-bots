const fs=require('node:fs'); const cap=fs.readFileSync(require('node:os').homedir()+'/.config/field-agent/root.swiss','utf8').trim();
let pass=0,fail=0; const ok=(c,m)=>{if(c){pass++;console.log('  ok -',m)}else{fail++;console.error('  FAIL -',m)}};
(async()=>{
  let chromium=null; try{({chromium}=require('/usr/lib/node_modules/@playwright/cli/node_modules/playwright-core'))}catch{}
  if(!chromium){console.log('SKIP');process.exit(0)}
  const http=require('node:http');
  const inv=await new Promise((r,j)=>{const q=http.request('http://127.0.0.1:8778/invite',{method:'POST',headers:{'content-type':'application/json'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>r(JSON.parse(d)))});q.on('error',j);q.end(JSON.stringify({cap,powers:['reference','home'],label:'SubUiGuest'}))});
  const br=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],env:{...process.env,LD_LIBRARY_PATH:'/var/lib/obsidian/oldlibs'}});
  try{
    const page=await br.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.addInitScript(c=>{try{localStorage.setItem('field-agent-cap',c)}catch{}
      window.ethereum={request:async({method})=>{ if(method==='wallet_grantPermissions') return {context:'0xMOCKGRANT'}; return null; }};},inv.scopedCap);
    await page.goto('http://127.0.0.1:8778/',{waitUntil:'load'}); await page.waitForTimeout(3500);
    await page.evaluate(()=>{const f=document.getElementById('drawer-foot'); if(f)f.click();}); await page.waitForTimeout(400);
    await page.evaluate(()=>{const b=[...document.querySelectorAll('.setnav-item')].find(x=>/Provider/.test(x.textContent)); if(b)b.click();}); await page.waitForTimeout(700);
    ok(await page.evaluate(()=>/MetaMask subscription/.test(document.body.innerText) && !!document.getElementById('sub-go')),'subscription card shows when on-chain settlement is available');
    await page.evaluate(()=>document.getElementById('sub-go').click()); await page.waitForTimeout(1500);
    ok(await page.evaluate(()=>/Subscribed/.test(document.body.innerText)||/subscribed/.test(document.body.innerText)),'set-up grants + shows subscribed');
    ok(errs.length===0,`no page errors (${errs.slice(0,2).join(' | ')})`);
    await page.close();
  } finally{await br.close();}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.error('test error:',e&&e.stack||e);process.exit(2)});
