/*---
description: stage4-async-promises corpus line 8 converted to a test262 case
flags: [raw]
features: [ironhorse-dual-run, ironhorse-meter-exact, ironhorse-meter-determinism]
info: |
  Converted from corpora/stage4-async-promises.js line 8.
  Source: var x=0; var r; var p=new Promise(function(res){r=res}); p.then(function(v){x=v}); r({then:function(res){res(55)}}); x
---*/
var x=0; var r; var p=new Promise(function(res){r=res}); p.then(function(v){x=v}); r({then:function(res){res(55)}}); x
