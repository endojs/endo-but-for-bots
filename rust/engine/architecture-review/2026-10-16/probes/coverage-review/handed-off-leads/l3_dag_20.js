// Completion value: a DAG of 20 nested two-element arrays over one 10-char string.
// The guest builds 21 arrays; the host completion render writes 2^20 leaves.
var a = ['xxxxxxxxxx']; for (var i = 0; i < 20; i++) a = [a, a]; a
