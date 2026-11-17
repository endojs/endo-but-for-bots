var s = 'QUJD'.repeat(25000); // 100,000 base64 chars
var ok = /^[A-Za-z0-9+\/]*={0,2}$/.test(s);
var j = JSON.stringify({ data: s });
var m = /"data":"([^"]*)"/.exec(j);
throw new Error(ok + ' ' + (m && m[1].length));
