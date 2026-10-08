---
title: petnames
group: Documents
category: Guides
---

# Petnames and Zooko's Triangle

Names do more than help people remember things. A name can also claim that two
people mean the same object, authenticate that object, or say who gets to decide
what the name means. Those jobs pull naming systems in different directions.

Endo uses **petnames** to keep the human-facing job separate from secure object
designation. A petname such as `build-bot` means whatever the holder of one
particular name store chose it to mean. Underneath that local name is an object
reference that the program cannot forge.

This separation is useful anywhere, but it is especially natural in an
[object-capability system](./guide.md#the-hardenedjs-story): authority already
travels as references, and people still need understandable ways to refer to
those references.

## Zooko's triangle

In October 2001, Zooko Wilcox-O'Hearn published *Names: Distributed, Secure,
Human-Readable: Choose Two*. The title became known as **Zooko's triangle**. His
page framed the result as a design claim and challenge, not a mathematical
proof.

The three desired properties are:

- **Human-meaningful.** A person can recognize, remember, and communicate the
  name. `example.com` fares better here than a 256-bit hash.
- **Secure.** An attacker cannot make the name resolve to the wrong object under
  the naming system's stated ownership policy. This is also called securely
  collision-free naming. It requires more than two labels merely looking
  different to a computer: people must not be easily misled by look-alike
  labels.
- **Decentralized.** No central authority controls the namespace or must be
  trusted to settle every binding. In the original formulation, this is what
  lets the namespace cross trust boundaries.

The usual triangle also assumes a **single global, context-free namespace**:
the same name means the same thing to everyone. With that assumption, each pair
is comparatively straightforward and the third property carries the cost:

| Easy pair | Familiar shape | Missing property |
| --- | --- | --- |
| Human-meaningful + secure | A centrally administered registry can assign memorable names without collisions; DNS is the familiar hierarchy. | The registry and its root of trust are central authorities. |
| Secure + decentralized | A cryptographic hash or public-key fingerprint is self-authenticating and needs no naming authority. | The identifier is not meaningfully human-readable. |
| Human-meaningful + decentralized | People can choose ordinary words without asking permission. | Uncoordinated choices collide, so the words do not securely identify one global referent. |

A naming architecture can fit the first row without making every human-facing
interaction safe. For example, today's DNS and certificate infrastructure does
not prevent phishing with look-alike names.

A local address book changes the question. Alice can bind `Mom` to one secure
identifier while Bob binds `Mom` to another. Both mappings can be useful and
secure because nobody claims that bare `Mom` has one global meaning. The address
book therefore does not disprove a claim about one global namespace. It gives up
global agreement.

This boundary explains why later naming systems sometimes claim to escape the
triangle while others say they relocate it. A layered system can combine a
secure decentralized identifier with a local human-readable alias. It can
provide all three benefits to a user without producing one human-readable name
whose meaning is globally agreed. Other systems move coordination into a
blockchain, registry, social graph, or user interface. Whether that is an escape
depends on which layer is being called *the namespace* and where its trust and
governance now live.

## Petnames: meaning belongs to the holder

A petname system embraces local context. It keeps three kinds of information
distinct:

| Kind | Who supplies it? | What it says |
| --- | --- | --- |
| **Petname** | The holder of the reference | "What I call it": `Mom`, `build-bot`, or `production-ledger`. |
| **Proposed name or edge name** | The referent or an introducer | "What it calls itself" or "what this introducer calls it." This is a suggestion, not an authenticated local meaning. |
| **Key or reference** | The secure naming or capability layer | "What it is": the unforgeable machine designation to which a local petname is bound. |

An edge name is relative to an edge in a graph of introductions. If Alice
introduces a reference with the label `accountant`, that label describes
Alice's edge to the reference. A self-proposed name comes from the referent.
Neither automatically becomes the recipient's petname. The recipient can accept
the suggestion, edit it, or choose an unrelated local name.

Marc Stiegler's 2005 report *Petname Systems* describes a petname as a private,
editable mapping between a memorable name and a secure key. Mark S. Miller's
earlier PetName Markup Language account makes the message boundary especially
clear: machines exchange keys, while each person's trusted user agent translates
between those keys and that person's private names.

That is the trade: petnames surrender a universal human vocabulary so that the
reference layer can remain secure and decentralized. Two holders can use
different petnames for the same reference, and the same word can name different
references in their separate stores.

This matches object capabilities. A capability is an unforgeable reference that
both designates an object and permits some interaction with it. Passing the
reference is an **introduction**. The recipient does not need to query a global
directory for the object's authoritative name; the recipient receives the
object and may bind a local name to it.

## Petnames in the Endo daemon

The Endo daemon currently gives every host and guest agent a directory backed by
a pet store. The store maps local names to formula identifiers, and the daemon
resolves those identifiers to values or agents. Special names such as `@self`,
`@host`, and `@agent` are daemon-managed entries. They are not user-chosen
petnames.

The current implementation is a practical petname system, not a strict
implementation of Stiegler's ideal one-to-one user-interface rule. One Endo
reference may have several local names: `endo copy` deliberately adds an alias,
and reverse lookup returns every local name for an identifier.

### Bind values, copy aliases, and rebind names

The following session was run against the daemon version documented by this
page. Commands that only change a binding produce no output.

```console
$ endo store --name favorite-number --bigint 42
$ endo show favorite-number
42n
$ endo copy favorite-number answer
$ endo move answer final-answer
$ endo show final-answer
42n
```

`store` formulated a passable value and bound its formula identifier to
`favorite-number`. `copy` bound the same identifier to a second name. `move`
bound it at `final-answer` and removed `answer`.

Binding a different value to an existing name rebinds that name. Other aliases
continue to designate their previous value:

```console
$ endo store --name favorite-number --bigint 7
$ endo show favorite-number
7n
$ endo show final-answer
42n
```

Likewise, `endo remove NAME` removes a binding. It does not issue a request to
destroy the object itself. Reachability and formula retention determine whether
the daemon can eventually collect the underlying formula.

### Traverse petname paths

A petname path walks through named directory capabilities. The CLI writes paths
with `/`; the API accepts an array of path segments. For each segment after the
first, the daemon asks the directory reached so far to look up the next local
name.

```console
$ endo mkdir settings
$ endo store --name settings/color --text teal
$ endo show settings/color
teal
$ endo list settings
color
```

`settings/color` is not one global compound name. The host first resolves its
local petname `settings`, then resolves `color` in that directory's namespace.
Different directories may bind `color` to different values.

### Name agents and introduce values

Hosts and guests are values too, so they can have petnames. `mkguest` can bind a
guest's mailbox handle and, separately, the full guest agent. The optional
`--introduce` mapping resolves a name in the parent's namespace and installs the
same reference under a name in the new guest's namespace:

```console
$ endo mkguest bob-handle bob --introduce final-answer:the-answer
Object [Alleged: EndoGuest] {}
$ endo show --as bob the-answer
42n
```

Here the host calls the value `final-answer`; Bob calls the introduced reference
`the-answer`. The command did not teach Bob the host's word. It gave Bob the
reference and created a binding chosen for Bob's store.

Endo mail uses the same distinction. A sender selects a value through a local
petname and attaches an **edge name** to that value in a package. The recipient
uses `adopt(messageNumber, edgeName, petName)` to select the introduced value by
the sender's edge name and bind a recipient-chosen petname. The edge name crosses
the message boundary; the sender's private petname does not.

### A locator is not a petname

`endo locate NAME` resolves a local path and emits an `endo://` locator. A
locator contains the machine-facing information needed to designate a formula,
including a peer key, formula address, type, and sometimes connection hints. An
OCapN sturdy reference similarly carries a peer locator and an unguessable Swiss
number so its holder can re-acquire a live reference.

Treat these as **bearer references**, not human names. Possession can carry
authority; copying one can transfer authority, and leaking one can disclose it.
The fact that a locator has URL syntax does not turn it into a petname. A holder
may store the reference under `production-ledger`, but that private binding is a
separate layer.

## Consequences for interface design

Petnames do not provide discovery. Knowing that Alice calls something
`accountant` does not let Bob find it, and Bob may already use that word for
something else. Petnames also provide no global uniqueness and no shared
vocabulary. A screenshot containing `production` is meaningful only with the
name-store context that rendered it.

Design object-capability interfaces around **introduction, not lookup**:

- Accept a reference as an argument instead of accepting a global string and
  searching for it.
- When one party introduces a reference, carry an edge or proposed name only as
  a naming suggestion.
- Let the receiving holder choose the durable local petname.
- Display local petnames prominently, but keep proposed names visually and
  semantically distinct.
- Compare or authorize using references and capabilities, not spelling equality
  between two parties' local names.

This shifts the question from "What global name should every participant look
up?" to "Who introduced this reference, what authority does it carry, and what
will I call it?" That is the question Endo's capability model can answer.

## Further reading

- Zooko Wilcox-O'Hearn's original 2001 statement,
  [*Names: Distributed, Secure, Human-Readable: Choose Two*](https://web.archive.org/web/20011020191610id_/http://zooko.com/distnames.html).
- Mark S. Miller's early
  [*Lambda for Humans: The PetName Markup Language*](https://erights.github.io/erights-org-website/elib/capability/pnml.html),
  which applies local names to cryptographic capabilities.
- Marc Stiegler's 2005 report
  [*Petname Systems*](https://shiftleft.com/mirrors/www.hpl.hp.com/techreports/2005/HPL-2005-148.pdf),
  a fuller treatment of keys, nicknames, and private petnames.
- Lemmer-Webber, Miller, Larson, Sills, and Yaacoby,
  [*Petnames: A Humane Approach to Secure, Decentralized Naming*](https://files.spritely.institute/papers/petnames.html),
  for proposed names, edge names, and modern user-interface examples.
- Endo's current
  [daemon locator terminology](https://github.com/endojs/endo-but-for-bots/blob/7d2eb307a2ee326bd53f2b56aea9e4c1e59e78ee/designs/daemon-locator-terminology.md),
  [guest invitation design](https://github.com/endojs/endo-but-for-bots/blob/7d2eb307a2ee326bd53f2b56aea9e4c1e59e78ee/designs/guest-native-invitations.md),
  and
  [persistent-store design](https://github.com/endojs/endo-but-for-bots/blob/7d2eb307a2ee326bd53f2b56aea9e4c1e59e78ee/packages/daemon/designs/daemon-persistent-stores.md)
  show how references, local bindings, agents, and durable formulas fit
  together.
