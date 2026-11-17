// Completion value: a DAG of 24 nested two-element arrays over one 10-char string.
// The guest builds 25 arrays; the host completion render writes 2^24 leaves.
var a = ['xxxxxxxxxx']; for (var i = 0; i < 24; i++) a = [a, a]; a
