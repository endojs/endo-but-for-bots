// @ts-check

/**
 * Parsing helpers for the `endo mount` / `endo mktmp` `--deny` /
 * `--no-deny` flags, which surface the daemon's `deniedSegments` mount
 * creation option (per `provideMount` / `provideScratchMount`).
 *
 * The option has three states, matching the programmatic option:
 *
 * - **absent** — the mount keeps its default restricted-segment set
 *   (`defaultDeniedSegments` in the daemon), so nothing is passed.
 * - **`--deny <segment>` one or more times** — the supplied set
 *   *replaces* the default set.
 * - **`--no-deny`** — denial is disabled with an empty set.
 */

/**
 * Commander collector for the repeatable `--deny <segment>` option. Each
 * occurrence appends one segment, so the accumulated value is the ordered
 * list of segments the caller named.
 *
 * @param {string} value - The segment from one `--deny` occurrence.
 * @param {string[]} [previous] - Segments accumulated so far.
 * @returns {string[]}
 */
export const collectDeniedSegment = (value, previous) =>
  Array.isArray(previous) ? [...previous, value] : [value];

/**
 * Resolve the parsed `--deny` / `--no-deny` option into the daemon's
 * `deniedSegments` mount option.
 *
 * Commander yields an array when `--deny` was given, the literal `false`
 * when `--no-deny` was given, and `undefined` when neither appeared.
 *
 * @param {string[] | false | undefined} deny
 * @returns {string[] | undefined} The replacement set (an empty array
 *   disables denial), or `undefined` to keep the mount's default set.
 */
export const resolveDeniedSegments = deny => {
  if (deny === false) {
    // `--no-deny` — disable denial with an empty set.
    return [];
  }
  if (Array.isArray(deny)) {
    // `--deny <segment>` — replace the default set with the named segments.
    return deny;
  }
  // Neither flag — keep the mount's default set.
  return undefined;
};
