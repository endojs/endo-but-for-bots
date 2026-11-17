const keys = []; for (let i = 0; i < 30000; i++) keys.push('k' + i); const s = JSON.stringify({}, keys); if (s !== '{}') throw 0;
