/*---
description: stage4-async-promises corpus line 17 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 17.
  Source: var x=0; new Promise(function(res){res(1)}).then(function(v){return {then:function(r){r(v)}}}).then(function(v){x=v}); x
---*/
var x=0; new Promise(function(res){res(1)}).then(function(v){return {then:function(r){r(v)}}}).then(function(v){x=v}); x
