
// short function name (1 chars): each Error captures one String per frame
const keep = [];
function f(n) {
  if (n > 0) return f(n - 1);
  for (let i = 0; i < 200; i++) keep.push(new Error('e'));
  return keep.length;
}
let depth = 0;
// find a safe depth first
let r = f(500);
