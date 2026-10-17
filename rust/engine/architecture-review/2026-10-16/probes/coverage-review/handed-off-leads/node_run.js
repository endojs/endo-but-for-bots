// usage: node node_run.js file.js 'expr'  -> runs file, prints expr after jobs settle
const fs = require('fs'); const vm = require('vm');
const src = fs.readFileSync(process.argv[2], 'utf8');
vm.runInThisContext(src);
setTimeout(() => console.log(String(vm.runInThisContext(process.argv[3]))), 50);
