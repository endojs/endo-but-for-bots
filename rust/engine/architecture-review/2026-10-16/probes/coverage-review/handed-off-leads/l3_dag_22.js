// Completion value: a DAG of 22 nested two-element arrays over one 10-char string.
// The guest builds 23 arrays; the host completion render writes 2^22 leaves.
var a = ['xxxxxxxxxx']; for (var i = 0; i < 22; i++) a = [a, a]; a
