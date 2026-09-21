'use strict';
(function () {
var nodes = [];
  for (var index = 0; index < 16; index += 1) nodes.push({ value: index, prior: index === 0 ? null : nodes[index - 1] });
  var root = harden({ nodes: nodes });
  var checks = 0;
  for (var repeat = 0; repeat < 32; repeat += 1) {
    checks += harden(root) === root;
    checks += Object.isFrozen(root);
    checks += Object.isSealed(root);
    checks += !Object.isExtensible(root);
  }
  return 'harden-repeat:16:32:' + checks + ':' + (root.nodes[0].value + root.nodes[root.nodes.length - 1].value);
}())
