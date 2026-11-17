var p = Promise.reject(1); p.catch(function(){});
var junk;
for (var i = 0; i < 200000; i++) junk = { i: i };
"done";
