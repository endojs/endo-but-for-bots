// spell-out-exempt: Preserve the public ConvertValToSlot name.
import { expectAssignable, expectType } from 'tsd';

import { Far, type AtomStyle, type RemotableObject } from '@endo/pass-style';
import type {
  CapData,
  ConvertSlotToVal,
  ConvertValToSlot,
  Encoding,
  EncodingClass,
  EncodingElement,
  EncodingUnion,
  FromCapData,
  FullCompare,
  MakeMarshalOptions,
  Marshal,
  PartialCompare,
  PartialComparison,
  RankCompare,
  RankComparison,
  RankCover,
  ToCapData,
  TreeOf,
} from '../index.js';
import { makeMarshal } from './marshal.js';

// Each public type is pinned against an independently-written expected shape,
// so a future edit that drops or malforms a member reddens this suite (a bare
// `expectType<T>(x as unknown as T)` self-assertion cannot — it only checks that
// the name still exports).

// EncodingClass carries a literal `@qclass` discriminant.
expectType<{ '@qclass': 'NaN' }>(null as unknown as EncodingClass<'NaN'>);

// EncodingUnion's representative members keep their per-tag payload shapes.
expectAssignable<EncodingUnion>({ '@qclass': 'undefined' });
expectAssignable<EncodingUnion>({ '@qclass': 'bigint', digits: '123' });
expectAssignable<EncodingUnion>({ '@qclass': 'symbol', name: 'foo' });
expectAssignable<EncodingUnion>({
  '@qclass': 'error',
  name: 'Error',
  message: 'boom',
});
expectAssignable<EncodingUnion>({ '@qclass': 'slot', index: 0, iface: 'x' });
expectAssignable<EncodingUnion>({
  '@qclass': 'tagged',
  tag: 't',
  payload: null,
});

// EncodingElement is a primitive leaf or an EncodingUnion.
expectType<boolean | number | null | string | EncodingUnion>(
  null as unknown as EncodingElement,
);

// TreeOf<string> is a leaf or a record of subtrees.
expectAssignable<TreeOf<string>>('leaf');
expectAssignable<TreeOf<string>>({ a: 'leaf', b: { c: 'leaf' } });

// Encoding is the JSON-representable tree of EncodingElements.
expectAssignable<Encoding>('leaf');
expectAssignable<Encoding>({ '@qclass': 'NaN' });

// CapData pins its body/slots shape.
expectType<{ body: string; slots: string[] }>(
  null as unknown as CapData<string>,
);

// Marshal exposes the (de)serialize pair plus the toCapData/fromCapData names.
expectType<{
  serialize: ToCapData<string>;
  unserialize: FromCapData<string>;
  toCapData: ToCapData<string>;
  fromCapData: FromCapData<string>;
}>(null as unknown as Marshal<string>);

// MakeMarshalOptions pins every option's name, optionality, and value set.
expectType<{
  errorTagging?: 'on' | 'off' | undefined;
  marshalName?: string | undefined;
  errorIdNum?: number | undefined;
  marshalSaveError?: ((err: Error) => void) | undefined;
  serializeBodyFormat?: 'capdata' | 'smallcaps' | undefined;
}>(null as unknown as MakeMarshalOptions);

// RankComparison is exactly the three-way result.
expectType<-1 | 0 | 1>(null as unknown as RankComparison);

// RankCover is an inclusive [lower, upper] string pair.
expectType<[string, string]>(null as unknown as RankCover);

// PartialComparison widens to `number` (TS has no NaN literal type) rather than
// narrowing to the three ordered results.
expectType<number>(null as unknown as PartialComparison);

expectType<(value: RemotableObject) => string>(
  null as unknown as ConvertValToSlot<string, RemotableObject>,
);
expectType<(slot: string, iface?: string) => RemotableObject>(
  null as unknown as ConvertSlotToVal<string, RemotableObject>,
);
expectType<(value: import('@endo/pass-style').Passable) => CapData<string>>(
  null as unknown as ToCapData<string>,
);
expectType<(data: CapData<string>) => any>(
  null as unknown as FromCapData<string>,
);
expectType<(left: any, right: any) => RankComparison>(
  null as unknown as RankCompare,
);
expectType<RankCompare>(null as unknown as FullCompare);
expectType<(left: string, right: string) => PartialComparison>(
  null as unknown as PartialCompare<string>,
);

expectType<AtomStyle>('string');
expectType<AtomStyle>('number');
// @ts-expect-error
expectType<AtomStyle>(1);
// @ts-expect-error
expectType<AtomStyle>('str');

type KCap = RemotableObject & { getKref: () => string; iface: () => string };
const valToSlot = (s: KCap) => s.getKref();
const slotToVal = (s: string) => null as unknown as KCap;
const marshal = makeMarshal(valToSlot, slotToVal);
const cycled = marshal.fromCapData(marshal.toCapData(null as unknown as KCap));
expectType<unknown>(cycled);

const m = makeMarshal();
const foo1 = Far('foo', { getBoardId: () => 'board1' });
const foo2 = Far('foo', { getBoardId: () => 'board2' });
const bar1 = Far('bar', { getBoardId: () => 'board1' });
m.toCapData(harden({ o: foo1 }));
m.toCapData(harden({ o: foo2 }));
m.toCapData(harden({ o: bar1 }));
