const out = [];
var y = 'global-y';
(function () {
  let y = 'outer';
  { let y = 'inner'; out.push(eval('y')); }
  out.push(eval('y'));
})();
let z = 'top';
{ let z = 'blk'; out.push(eval('z')); }
out.push(eval('z'));
throw new Error(JSON.stringify(out));
