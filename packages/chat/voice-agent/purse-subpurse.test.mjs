import '@endo/init';
import test from 'node:test'; import assert from 'node:assert/strict';
import { makePurse, makeBoundedSubPurse } from './purse.mjs';

test('bounded sub-purse enforces 50-of-100 bound', () => {
  const parent = makePurse(100);
  const sub = makeBoundedSubPurse({ parent, cap: 50 });
  assert.equal(sub.cap(), 50);
  assert.equal(sub.spent(), 0);
  assert.equal(sub.balance(), 50);

  // can spend right up to the cap
  assert.equal(sub.canAfford(50), true);
  sub.debit(50);
  assert.equal(sub.spent(), 50);
  assert.equal(sub.balance(), 0);

  // one µUSD over the cap is refused, even though the parent still holds 50
  assert.equal(parent.balance(), 50);
  assert.equal(sub.canAfford(1), false);
  assert.throws(() => sub.debit(1), /over cap/);
  // refusal left BOTH ledgers untouched
  assert.equal(sub.spent(), 50);
  assert.equal(parent.balance(), 50);
});

test('sub-purse debit decrements the parent', () => {
  const parent = makePurse(100);
  const sub = makeBoundedSubPurse({ parent, cap: 80 });
  sub.debit(30);
  assert.equal(parent.balance(), 70);
  sub.debit(20);
  assert.equal(parent.balance(), 50);
  assert.equal(sub.spent(), 50);
});

test('sum of children spend stays <= parent', () => {
  const parent = makePurse(100);
  const a = makeBoundedSubPurse({ parent, cap: 60 });
  // b's own cap is generous (90) so the SHARED PARENT is the binding constraint
  const b = makeBoundedSubPurse({ parent, cap: 90 });

  a.debit(40);
  b.debit(40);
  // each child is within its own cap, but together they have drawn the parent down to 20
  assert.equal(a.spent() + b.spent(), 80);
  assert.equal(parent.balance(), 20);
  assert.ok(a.spent() + b.spent() <= 100);

  // b wants 40 more (within its own 90 cap, 50 remaining) but the SHARED parent only
  // has 20 left — refused by the parent-affordance assertion
  assert.equal(b.balance(), 50); // own remaining cap
  assert.equal(b.canAfford(40), false);
  assert.throws(() => b.debit(40), /parent cannot afford/);
  assert.equal(parent.balance(), 20); // refusal left the parent untouched
  assert.equal(b.spent(), 40);

  // b can take exactly what the parent has left
  b.debit(20);
  assert.equal(parent.balance(), 0);
  assert.equal(a.spent() + b.spent(), 100);
  assert.ok(a.spent() + b.spent() <= 100);
});
