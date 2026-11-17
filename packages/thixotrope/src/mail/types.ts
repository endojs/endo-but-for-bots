import type { RemotableObject } from '@endo/pass-style';

/** A sender's suggested local name and the authority being shared. */
export type NamedCapDescriptor = Readonly<{
  name: string;
  value: RemotableObject;
}>;

/** Ordered text and capability parts; names never assign recipient inventory keys. */
export type MailContent = readonly (string | NamedCapDescriptor)[];

/** Listing mail describes capabilities without handing them to the viewer. */
export type MailContentDescription = readonly (
  string | Readonly<{ name: string }>
)[];
