// spell-out-exempt: Preserve the public ConvertValToSlot name.
import { expectType } from 'tsd';

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

type PublicMarshalTypes = [
  Encoding,
  EncodingClass<'NaN'>,
  EncodingElement,
  EncodingUnion,
  TreeOf<string>,
  CapData<string>,
  Marshal<string>,
  MakeMarshalOptions,
  RankComparison,
  RankCover,
  PartialComparison,
];

expectType<PublicMarshalTypes>(null as unknown as PublicMarshalTypes);
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
