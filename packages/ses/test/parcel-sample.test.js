/* eslint-disable max-classes-per-file */
import test from 'ava';
import { fc as fastCheck } from '@fast-check/ava';
import { sampleParcel } from '../src/intrinsics.js';

const { defineProperty } = Object;

const staticNames = /** @type {const} */ (['open', 'locate', 'isParcel']);
const staticShape = fastCheck.constantFrom(
  'absent',
  'dataFunction',
  'dataValue',
  'accessor',
);

test('sampleParcel accepts exactly the constructors with three data function statics', t => {
  fastCheck.assert(
    fastCheck.property(
      fastCheck.record({
        open: staticShape,
        locate: staticShape,
        isParcel: staticShape,
      }),
      shape => {
        const candidate = class Parcel {};
        /** @type {Record<string, unknown>} */
        const functions = {};
        let getterCalls = 0;
        for (const name of staticNames) {
          if (shape[name] === 'dataFunction') {
            functions[name] = () => {};
            defineProperty(candidate, name, { value: functions[name] });
          } else if (shape[name] === 'dataValue') {
            defineProperty(candidate, name, { value: name });
          } else if (shape[name] === 'accessor') {
            defineProperty(candidate, name, {
              get() {
                getterCalls += 1;
                return () => {};
              },
            });
          }
        }
        const globalObject = { Parcel: candidate };
        const accepted = staticNames.every(
          name => shape[name] === 'dataFunction',
        );
        if (accepted) {
          const sample = sampleParcel(globalObject);
          return (
            sample !== undefined &&
            sample.Parcel === candidate &&
            sample.open === functions.open &&
            sample.isParcel === functions.isParcel &&
            sample.prototype === candidate.prototype &&
            getterCalls === 0
          );
        }
        try {
          sampleParcel(globalObject);
          return false;
        } catch (error) {
          return error instanceof TypeError && getterCalls === 0;
        }
      },
    ),
  );
  t.pass();
});

test('sampleParcel ignores a global without an own Parcel', t => {
  t.is(sampleParcel({}), undefined);
  t.is(sampleParcel({ __proto__: { Parcel: class Parcel {} } }), undefined);
});
