/*---
description: stage4-async-promises corpus line 7 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 7.
  Source: var x=0; new Promise(function(res){res({then:function(r){r(9)}})}).then(function(v){x=v}); x
---*/
var x=0; new Promise(function(res){res({then:function(r){r(9)}})}).then(function(v){x=v}); x
