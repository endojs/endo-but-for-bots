'use strict';
(function () {
function makeGraph(seed) {
    var wide = { kind: 'wide', children: [] };
    for (var index = 0; index < 128; index += 1) wide.children.push({ value: seed + index });
    var deep = null;
    for (var depthIndex = 128 - 1; depthIndex >= 0; depthIndex -= 1) deep = { value: depthIndex, next: deep };
    var leaves = [];
    for (var leafIndex = 0; leafIndex < 64; leafIndex += 1) leaves.push({ value: leafIndex * 3 });
    return { wide: wide, deep: deep, dag: { left: leaves.slice(), right: leaves.slice() } };
  }
  function census(root) {
    var seen = [];
    var pending = [root];
    var frozen = 0;
    var checksum = 0;
    while (pending.length > 0) {
      var value = pending.pop();
      if (value === null || typeof value !== 'object' || seen.indexOf(value) >= 0) continue;
      seen.push(value);
      if (Object.isFrozen(value)) frozen += 1;
      if (typeof value.value === 'number') checksum += value.value;
      var keys = Object.keys(value);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) pending.push(value[keys[keyIndex]]);
    }
    return [frozen, seen.length, checksum];
  }
  var graphs = [];
  for (var copy = 0; copy < 64; copy += 1) graphs.push(makeGraph(0));
  var root = harden({ graphs: graphs });
  var result = census(root);
  return 'harden-tree:64:' + result[0] + ':' + result[1] + ':' + result[2];
}())
