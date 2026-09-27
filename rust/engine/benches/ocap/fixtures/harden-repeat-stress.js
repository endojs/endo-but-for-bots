'use strict';
(function () {
var nodes = [];
  for (var index = 0; index < 256; index += 1) nodes.push({ value: index, prior: index === 0 ? null : nodes[index - 1] });
  var root = harden({ nodes: nodes });
  var checks = 0;
  for (var repeat = 0; repeat < 1024; repeat += 1) {
    checks += harden(root) === root;
    checks += Object.isFrozen(root);
    checks += Object.isSealed(root);
    checks += !Object.isExtensible(root);
  }
  return 'harden-repeat:256:1024:' + checks + ':' + (root.nodes[0].value + root.nodes[root.nodes.length - 1].value);
}())
