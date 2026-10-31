const vm = require('vm'); const c = vm.createContext({});
vm.runInContext('const C = 42; let L = 43; class K {}', c);
console.log(vm.runInContext('[typeof C, typeof L, typeof K].join()', c));
try { vm.runInContext('let L = 2;', c); console.log('no error'); } catch (e) { console.log(e.name + ': ' + e.message); }
