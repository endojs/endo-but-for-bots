---
title: grant-matcher
group: Documents
category: Guides
---

# The Grant Matcher Puzzle

> **About this page.** This is a translation, into the Endo stack, of Mark S.
> Miller's *The Grant Matcher Puzzle* — the foundational motivating problem for
> object-identity and equality primitives in pure object-capability systems, and
> the root of the E *equality* taxonomy. The original is published on
> [erights.org](https://erights.org/elib/equality/grant-matcher/index.html)
> (mirrored at
> [caplet.com](http://www.caplet.com/security/taxonomy/grant-match/grant-matcher.html)
> as *Identity Untangled: The Grant Matcher Puzzle*, credited to Mark Miller
> with thanks to Norm Hardy and E. Dean Tribble). Miller's argument and prose are
> preserved faithfully; only the **code**, the **protocol names**, and **dead
> links** are modernized, and each such substitution is flagged for the reader.
> See [Attribution and licensing](#attribution-and-licensing) below.

> **Translation conventions.** This page follows the Endo thesis-translation
> conventions:
>
> - The **E language** is translated to the **Jessie** subset of **Hardened
>   JavaScript**. E's eventual sends (`obj <- msg(...)`) become the `E()` proxy
>   from [`@endo/eventual-send`](./message-passing.md); E makers and facets
>   become [`makeExo`](./message-passing.md) objects guarded by
>   [`M.interface`](./message-passing.md) patterns.
> - **CapTP** — E's original capability-transport protocol — is translated to
>   **OCapN**, the Object Capability Network protocol that Endo speaks today.
> - Miller's original reference implementation is in **Java**; it is translated
>   here to Hardened JavaScript. Where a Java construct has no direct Endo
>   analogue (the `Purse`/`Currency` money model, `Object.equals()`), the
>   substitution is called out inline.
>
> Passages set as block quotes are Miller's words; the surrounding text and all
> code are this translation.

## The question: should a capability system have `EQ`?

Many systems designers have wrestled with the notion of object identity, and the
question must be resolved to design foundational equality primitives. Should an
object system provide a means to tell whether two object references refer to the
same object, **without consulting either of the objects involved**? Following
Lisp, we call any such primitive *EQ*. Otherwise-equivalent pure capability
systems have come to different answers, and — as Miller puts it —

> The implications of these different answers were not understood until the
> Grant Matcher Puzzle.

The puzzle is not about a single "right" answer but about *the cost of each
answer*. A system with no `EQ` cannot distinguish a transparent forwarder from
the object it forwards to: this preserves full forwarder transparency, but, as we
will see, defeats a naive equality protocol. A system with address-equality `EQ`
*can* make that distinction, at the cost of forwarder transparency. The Grant
Matcher scenario is the concrete problem that makes those costs visible.

## Capability foundations: the three rules

Consider the fundamental step of capability computation over three objects —
**Alice**, **Bob**, and **Carol**. In the initial conditions, Alice holds an
object reference — a *capability* — to both Bob and Carol, and neither Bob nor
Carol holds a capability to the other two. Three rules govern how access spreads:

- **The first rule of capabilities** is that one object, here Bob, can only get
  access to another, here Carol, if the first creates the second, or if someone
  — here, Alice — who validly has access to Carol *voluntarily* passes a copy of
  that access to Bob. For Alice to give Bob access to Carol, Alice must already
  have access to Carol and must *choose* to give it out. By *voluntary* we mean:
  were a different program substituted for Alice in the same external
  environment, it could choose *not* to give access to Carol. This is the basis
  for **discretionary security** in capability systems.

- **The second rule** is that capabilities may only travel on paths provided by
  existing capabilities. For Alice to give Bob access to Carol, Alice also
  requires access to Bob. Even if Alice is coded to attempt it, she cannot give
  Bob the access if there is no capability pathway of willing intermediaries
  leading from Alice to Bob. This is the basis for **mandatory security** in
  capability systems, especially *confinement*.

- **The third rule** is the heart of the puzzle:

  > The access to Carol that Bob gets must be *as good a reference to Carol as
  > the reference Alice passed, as far as Alice is concerned*. The "Carol" that
  > Bob gets must be the "Carol" that Alice meant.

The subtleties in making that last requirement precise are the whole of the Grant
Matcher Puzzle. Getting it right is how a distributed capability system avoids the
capability equivalent of a **man-in-the-middle attack**.

> **Translation note (CapTP → OCapN).** Miller's original text refers to *CapTP*,
> E's capability-transport protocol, as the layer responsible for making the
> third rule hold across machines. In the Endo stack that role is played by
> **OCapN** ([`@endo/ocapn`](https://github.com/endojs/endo/tree/master/packages/ocapn)),
> whose *handoff* mechanism is precisely the man-in-the-middle-resistant
> three-party grant that the third rule demands.

## Setting up the puzzle

Now map the abstract diagram onto a concrete scenario. A **Grant Matcher** is a
mutually trusted third party that matches two donors' grants to a common
destination:

- The **Grant Matcher** itself plays the role of **Bob**.
- A charity named **KEQD** plays the role of **Carol** — the destination.
- **Alice** and a second donor, **Dana**, are the two donors. Dana's situation is
  exactly symmetric with Alice's.

Alice and Dana both trust the Grant Matcher to perform its duties, but **do not
trust each other at all** — which is precisely *why* they route their grants
through a mutually trusted third party.

Their only protection against misbehavior by the Grant Matcher is the
**principle of least authority** (called by Saltzer and Schroeder the principle
of least privilege): the Grant Matcher's protocol requires of Alice and Dana only
those capabilities the Grant Matcher would need to *honestly* perform its duties.

> A protocol requiring more authority than this should raise eyebrows.

Money itself is an interesting problem, but for this puzzle it is simply assumed:
there is an implementation of money adequate for the example, given that the
Grant Matcher already knows the currency Alice and Dana use. No system can enable
cooperation in the total absence of trust; the Grant Matcher pattern brings about
a *particular* kind of cooperation between two mutually distrustful donors,
requiring only that they both trust the Grant Matcher and a common monetary
system.

> **Translation note (the money model).** Miller's reference implementation
> imports a `Purse`/`Currency` money model whose details are out of scope for the
> puzzle. Endo's descendant of that model is **ERTP** (Electronic Rights Transfer
> Protocol), whose purses and payments are asynchronous, remotable objects
> reached through `E()`. The code below keeps money at exactly Miller's level of
> abstraction — a purse you can `deposit` into, `withdraw` from, and ask for its
> current amount — and does not depend on any particular currency implementation.

## When it works

The Grant Matcher provides the service of matching grants to a common
destination. Alice wishes to give \$10 to KEQD, but **only if** \$10 also goes to
KEQD from Dana; Dana has the symmetric desire involving Alice. The Grant Matcher
has no previous knowledge of KEQD, but if both donors provide the same amount and
designate the same destination, it takes the money from each and gives the sum to
the destination. Otherwise it returns the money to each prospective donor.

The Grant Matcher is assumed to be coded to perform its duties whenever it can.
The puzzle is then two coupled questions:

1. **Can the Grant Matcher determine whether Alice and Dana are designating the
   same destination?** (The *equality* question.)
2. **Having made a determination, can it reliably transport the money to the
   destination, in a way mutually acceptable to Alice and Dana?** (The
   *transport* question.)

The safety requirement binds the two together: the Grant Matcher must ensure that
**Alice will not lose \$10 unless a destination acceptable to her gets \$20** —
and symmetrically for Dana.

Suppose there is *no* `EQ` primitive — that one can learn about a capability only
by sending it messages. Then the Grant Matcher must determine equality by running
some message-only equality protocol over the two destination capabilities. Having
determined — somehow — that both references are equivalent, it can pick either one
and send the money. The next section shows why a message-only equality protocol is
not enough.

Here is the shared machinery, translated to Hardened JavaScript. A **Charity** is
anything that can accept a donation; a **GrantStatus** is the callback a donor
hands in so it can learn the outcome and receive a refund:

```javascript
import { M } from '@endo/patterns';
import { makeExo } from '@endo/exo';
import { E } from '@endo/eventual-send';

// The kind of thing one can ask the Grant Matcher to give money to.
export const CharityI = M.interface('Charity', {
  acceptDonation: M.call(M.remotable('Purse')).returns(),
});

// How a Grant Matcher client learns what happened with its attempt to
// contribute a matching grant. The client provides a GrantStatus as a
// call-back object in its contribution request.
export const GrantStatusI = M.interface('GrantStatus', {
  completionNotice: M.call().returns(),
  refund: M.call(M.remotable('Purse')).returns(),
});
```

> **Translation note (E → Jessie/Hardened JavaScript).** Miller's `Charity` and
> `GrantStatus` are Java `interface`s; the E rendering would be an *interface
> definition* implemented by a *maker*. In Endo, the interface is an
> [`M.interface`](./message-passing.md) *guard* and the object is a
> [`makeExo`](./message-passing.md), so the argument shapes are checked
> defensively before any method body runs.

The Grant Matcher escrows the first donation, then compares the second against
it. The one decision the puzzle turns on — *how to test that two destinations are
equal* — is factored out into a single `sameDestination` function supplied when
the matcher is made:

```javascript
export const GrantMatcherI = M.interface('GrantMatcher', {
  acceptMatch: M.call(
    M.remotable('Charity'),
    M.remotable('Purse'),
    M.remotable('GrantStatus'),
  ).returns(),
});

// `sameDestination(x, y)` is the crucial equality test. The whole puzzle is
// about the consequences of different choices here, so it is a parameter.
export const makeGrantMatcher = sameDestination => {
  // 0 => initial conditions; 1 => one side has donated;
  // 2 => busy or used up, this Grant Matcher is spent.
  let phase = 0;
  let first = null; // the first donor's escrow record, once it exists

  const acceptFirst = async (charity, donation, status) => {
    // A fresh empty purse in the donation's currency (Miller's `newPurse()`).
    const escrow = await E(E(donation).getIssuer()).makeEmptyPurse();
    const amount = await E(escrow).deposit(donation); // takes ownership
    first = { charity, escrow, amount, status };
    phase = 1; // now open to a matching second donation
  };

  const acceptSecond = async (charity, donation, status) => {
    const amount = await E(first.escrow).deposit(donation);
    if (
      (await sameDestination(charity, first.charity)) &&
      amount === first.amount * 2n
    ) {
      // Both agree: hand the whole sum to the shared destination.
      await E(first.charity).acceptDonation(first.escrow);
      E(first.status).completionNotice();
      E(status).completionNotice();
    } else {
      // Disagreement: refund each donor exactly what it escrowed.
      E(first.status).refund(await E(first.escrow).withdraw(first.amount));
      E(status).refund(first.escrow);
    }
  };

  return makeExo('GrantMatcher', GrantMatcherI, {
    acceptMatch(charity, donation, status) {
      if (phase === 2) {
        throw Error('this GrantMatcher is used up');
      }
      // Flip to the busy sentinel synchronously -- before any `await` -- so a
      // re-entrant call cannot slip into the same slot. Miller's Java does the
      // same with `myNumDonations = 2` guarding the escrow window.
      const wasFirst = phase === 0;
      phase = 2;
      // Not awaited: the caller's turn returns promptly; the escrow and match
      // resolve on their own turns.
      void (wasFirst
        ? acceptFirst(charity, donation, status)
        : acceptSecond(charity, donation, status));
    },
  });
};
```

> **Translation note (locking → turns).** Miller's Java `GrantMatcher` holds a
> private lock and is careful to *"only call back after releasing the lock"* to
> foil a re-entrancy ("locking") attack. Hardened JavaScript needs no lock: each
> method body runs to completion on its own **turn** without interleaving. The
> `phase` sentinel flips to its busy value `2` *synchronously*, before the first
> `await`, so a re-entrant `acceptMatch` during the escrow deposit sees a spent
> matcher rather than a half-updated one — exactly the window Miller's
> `myNumDonations = 2` guards. This is the ocap *turn* discipline standing in for
> the original's explicit mutual exclusion.

## Alice gets greedy

Now the attack. Suppose forwarders can be *truly transparent*.

> In Actor systems and in Joule, these equality protocols may eventually bottom
> out in an internal *EQ* primitive, but this primitive is hooked into the system
> in such a way as to prevent revealing a transparent forwarder interposed on a
> messaging path. If the primitive could be used to reveal the forwarder, then
> full transparency would be lost.

In such a system, Alice can hand the Grant Matcher, instead of KEQD itself, a
reference to a **transparent forwarder** to KEQD. This forwarder passes every
message through to KEQD — *including the messages that make up the equality
protocol* — **except** a message carrying \$20, which it instead deposits into
Alice's own account:

```javascript
// A charity-in-the-middle. Every message it receives it forwards
// transparently to the real KEQD -- except a donation, which it pockets.
export const makeGreedyForwarder = (realCharity, alicesPurse) =>
  makeExo('Charity', CharityI, {
    acceptDonation(donation) {
      // The one message it does *not* forward: pocket the matched grant.
      void E(alicesPurse).deposit(donation);
    },
    // Every other message -- including the equality-protocol probes the Grant
    // Matcher sends -- is forwarded through to the genuine KEQD, so from the
    // Grant Matcher's point of view this object answers exactly as KEQD would.
  });
```

> **Translation note (`equals`/`hashCode` → a forwarding proxy).** Miller's Java
> `MalletCharity` overrides `equals()` and `hashCode()` to delegate to the real
> charity's identity while overriding `acceptDonation()` to pocket the money.
> Hardened JavaScript has no `Object.equals()` / `hashCode()` protocol for
> callers to override; the *truly transparent forwarder* is the general form of
> the same trick — an object that forwards **every** message (the
> equality-protocol probes among them) to `realCharity`, and diverts only the
> donation. Under a message-only equality protocol the two are indistinguishable.

By assumption, the Grant Matcher cannot tell this forwarder apart from KEQD
except at the price of the very \$20 that is at stake. And notice — this is the
crux —

> Notice that Alice cannot really be said to have done anything dishonest.

The destination she designates acts just like KEQD, except for where it puts
\$20 bills. Because it forwards the equality-protocol messages through to KEQD,
KEQD itself is a *valid interpretation* of what Alice meant; had the Grant Matcher
given the \$20 directly to KEQD, Alice would have no grounds for complaint. But
the Grant Matcher's situation is symmetric, so it might break the tie in Alice's
favor — and then Alice pockets the money.

> Dana has lost his \$10 even though no destination acceptable to Dana got \$20.

By no stretch of semantics could Dana's request be read as designating *Alice's
bank account*. A message-only equality protocol cannot protect Dana here.

## How `EQ` makes a difference

Now give the Grant Matcher an `EQ` primitive.

> Of all varieties of *EQ* primitive, the simplest is the original
> address-equality primitive from Lisp, since then appearing in everything from
> Smalltalk to KeyKOS to Java.

Were the Grant Matcher to test its two destinations with address equality, `EQ`
would answer **false** in the "Alice gets greedy" scenario: the forwarder is a
*distinct object* from KEQD, however faithfully it forwards messages. Both donors
simply get their money back — a perfectly acceptable outcome. Miller notes this
resolution is not free:

> This is a perfectly acceptable outcome, though it has some real costs,
> especially in the distributed case.

The two variants of the Grant Matcher differ *only* in the `sameDestination`
function they are built with:

```javascript
// Address (identity) equality: are these the very same object?
// In Hardened JavaScript this is `===` on the two presences -- the direct
// translation of Miller's Java `EQGrantMatcher` (`x == y`).
export const makeEqGrantMatcher = () =>
  makeGrantMatcher((x, y) => x === y);

// "Behavioral" equality: ask one destination whether it considers itself the
// same as the other. This is the translation of Miller's `EqualsGrantMatcher`
// (`x.equals(y)`) -- and it is exactly the test the greedy forwarder defeats,
// because the forwarder answers this probe by consulting the real KEQD.
export const makeEqualsGrantMatcher = () =>
  makeGrantMatcher((x, y) => E(x).isSameDestinationAs(y));
```

`makeEqGrantMatcher` resists the greedy-forwarder attack; `makeEqualsGrantMatcher`
— the message-only test — does not. That contrast *is* the puzzle.

> **Translation note (`==`/`.equals()` → `===`/message send; the OCapN answer).**
> Miller factors the equality test into two Java subclasses: `EQGrantMatcher`
> using `==` (address equality) and `EqualsGrantMatcher` using `Object.equals()`
> (a message the receiver answers). The Hardened JavaScript analogues are `===`
> on two presences and an eventual-send probe, respectively. The decisive
> modernization is *what makes `===` trustworthy across machines*: in the Endo
> stack, **OCapN's handoff protocol** guarantees that two references arriving by
> different paths that denote the *same* remote object become the *same*
> presence at the receiver — so `===` is a **pass-invariant** identity test, not
> merely a local one. This is the modern, distributed answer to the Grant
> Matcher's equality question, and the reason a distributed ocap system can have
> *both* a safe equality test *and* a man-in-the-middle-resistant transport.

Miller's page ships a small reference implementation, whose parts map to the
translation above:

| Miller's Java | This translation |
| --- | --- |
| `Charity.java` | the `CharityI` interface guard |
| `GrantStatus.java` | the `GrantStatusI` interface guard |
| `GrantMatcher.java` (abstract) | `makeGrantMatcher(sameDestination)` |
| `EQGrantMatcher.java` (`==`) | `makeEqGrantMatcher()` |
| `EqualsGrantMatcher.java` (`.equals()`) | `makeEqualsGrantMatcher()` |
| `MalletCharity.java` | `makeGreedyForwarder(realCharity, alicesPurse)` |

Miller also observes that a more elaborate use of the pattern might make the
Grant Matcher a **two-faceted** object — one facet each for Alice and Dana. Where
KeyKOS, Joule, and Mach provide facets primitively, Endo composes them from exos:
a maker returns a record of several `makeExo` objects that share enclosed state,
which is the modern spelling of Marc Stiegler's Facade-pattern approach to
multiple facets.

## The lasting lesson

The choice of equality primitive is not free:

- **Address-equality `EQ`** defeats the transparent-forwarder attack but
  precludes *truly* transparent forwarders.
- **A message-only system** preserves forwarder transparency but cannot, by
  itself, answer the equality question safely.

A distributed object-capability system that wants a safe equality test *and*
reliable transport needs both a **pass-invariant equality** primitive and a
man-in-the-middle-resistant **handoff**. In the Endo stack, that is exactly what
[`@endo/pass-style`](./message-passing.md)'s remotable identity and **OCapN**'s
handoff provide — the modern answer to the two questions this puzzle has posed
since it was first written.

## Attribution and licensing

*The Grant Matcher Puzzle* is the work of **Mark S. Miller** (with thanks, on the
original, to Norm Hardy and E. Dean Tribble). This page is a derivative
translation into the Endo stack, preserving Miller's argument and prose while
modernizing code, protocol names, and links.

- **Source:** *The Grant Matcher Puzzle*, Mark S. Miller,
  <https://erights.org/elib/equality/grant-matcher/index.html> (mirrored at
  <http://www.caplet.com/security/taxonomy/grant-match/grant-matcher.html>).

> **Licensing is unresolved and is a maintainer decision.** Miller's articles on
> erights.org are his copyrighted work; no license for reproduction or derivative
> translation is assumed here. Before this page is published to docs.endojs.org,
> a maintainer must confirm permission to republish this translated adaptation
> (or reduce it to a shorter summary-with-citation if permission is not
> obtained). This draft is provided so that the editorial and technical
> translation can be reviewed; **it should not be merged or published until the
> attribution/permission question is settled.**
