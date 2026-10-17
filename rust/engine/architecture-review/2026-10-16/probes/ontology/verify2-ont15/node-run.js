const vm = require('vm'); const fs = require('fs');
try { vm.runInThisContext(fs.readFileSync(process.argv[2], 'utf8')); console.log('completed'); } catch (e) { console.log(String(e)); }
