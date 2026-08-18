/**
 * A stable, public visual mark for a party, keyed by the party OBJECT.
 * The same object always yields the same mark; distinct objects are told
 * apart. The mark distinguishes, it does not authenticate — do not confuse it
 * with the secret security pattern in `./pattern-badge`.
 */
export function partyMark(party: object): { glyph: string; color: string };
