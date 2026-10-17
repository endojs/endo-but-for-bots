// Completion value: a DAG of 16 nested two-element arrays over one 10-char string.
// The guest builds 17 arrays; the host completion render writes 2^16 leaves.
var a = ['xxxxxxxxxx']; for (var i = 0; i < 16; i++) a = [a, a]; a
