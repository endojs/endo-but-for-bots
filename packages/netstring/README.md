# netstring

This is an implementation of asynchronous streams framed as [Netstrings][].
A netstring is a binary protocol for length-prefixed frames,
using decimal strings as variable width integers.
For example, the frame `5:hello,` corresponds to the message `hello`,
where `5` is the length of `hello` in bytes.

This implementation relies particularly on a pure JavaScript notion of a
stream, using async iterators of Uint8Arrays.
By convention, these may be ranges of a ring buffer, so a stream owns a byte
range it receives from `next` until the next time it calls `next`.

`@endo/netstring` is a sibling to [`@endo/cbor-frame`](../cbor-frame/) (CBOR
byte-string framing) and [`@endo/lp32`](../lp32/) (32-bit host-byte-order
length-prefixed framing, used by WebExtension Native Messaging).
Each names a different on-the-wire grammar for length-prefixed byte strings.
The packages are peers: taking a dependency on one of them does not entrain
a dependency on any of the others.


[Netstrings][] <br>
D. J. Bernstein, <djb@pobox.com> <br>
1997-02-01

[Netstrings]: https://cr.yp.to/proto/netstrings.txt
