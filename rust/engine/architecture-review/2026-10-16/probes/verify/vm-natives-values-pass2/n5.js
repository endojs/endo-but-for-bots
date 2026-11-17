const r=[new Intl.Collator('en',{sensitivity:'base'}).compare('a','á'), new Intl.Collator('en',{numeric:true}).compare('b1','a2'), new Intl.Collator('en',{numeric:true}).compare('a10b2','a10b10'), ['ä','a','z'].sort(new Intl.Collator('de').compare).join()];
throw new Error(JSON.stringify(r));
