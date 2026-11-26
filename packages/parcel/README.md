# `@endo/parcel`

`@endo/parcel` provides the realm's first-wins `Parcel` constructor.
A Parcel is an opaque, passable box around a location and the procedure for
opening that location into a live capability.

Install the shim before `lockdown()`:

```js
import '@endo/parcel/shim.js';
import 'ses';

lockdown();
```

Construct and open a Parcel:

```js
const parcel = new Parcel('ocapn://example/location', async location => {
  return connect(location);
});

const presence = await Parcel.open(parcel);
```

The open hook receives `(location, parcel)` with `this === undefined` in a
later turn.
`Parcel.open` always returns a promise, and repeated calls invoke the hook
again rather than promising referential convergence.

`Parcel.isParcel(value)` performs a non-authoritative brand check.
It does not reveal who minted the Parcel or whether opening it is safe.

The initial constructor also provides `Parcel.locate(parcel)`.
Locations are cryptographic authority, so SES derives a shared constructor for
child compartments that shares the prototype and brand but omits `locate`.
Endow the shared constructor unless a compartment must reveal locations.

The side-effect-free API is available from `@endo/parcel/no-shim.js`:

```js
import {
  makeParcel,
  open,
  isParcel,
  locate,
} from '@endo/parcel/no-shim.js';
```

Calls through this API delegate to the constructor selected by the current
realm.
`locate` fails when that constructor is the shared form.

## First wins

The first valid `globalThis.Parcel` installation wins.
Later evaluations adopt the visible initial or shared constructor without
invoking accessors while validating it.
This gives eval twins one process-wide brand and private table.
After lockdown, a shim evaluation can adopt an existing constructor but cannot
create a new one.

Parcel instances are frozen immediately and have no own properties.
Lockdown hardens the initial constructor, the shared constructor, their
statics, and their shared prototype.
