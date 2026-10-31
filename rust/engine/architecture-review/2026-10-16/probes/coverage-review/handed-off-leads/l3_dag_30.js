// 31 arrays, one 10-char string, 30 loop iterations: the completion render writes 2^30 leaves (~11.8 GB).
var a = ['xxxxxxxxxx']; for (var i = 0; i < 30; i++) a = [a, a]; a
