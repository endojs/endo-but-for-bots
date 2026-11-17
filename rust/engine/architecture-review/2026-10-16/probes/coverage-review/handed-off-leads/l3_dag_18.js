// Completion value: a DAG of 18 nested two-element arrays over one 10-char string.
// The guest builds 19 arrays; the host completion render writes 2^18 leaves.
var a = ['xxxxxxxxxx']; for (var i = 0; i < 18; i++) a = [a, a]; a
