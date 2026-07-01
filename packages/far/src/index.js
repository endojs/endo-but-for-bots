// `@endo/far` used to re-export names that originate in other packages, without
// renaming them or adding value. Per endojs/endo-but-for-bots#543 those plain
// re-exports have been removed; import each name directly from the package that
// originally exports it:
//   - `E`, and the `FarRef` / `ERef` / `EOnly` / `EReturn` / `EResult` types,
//     from `@endo/eventual-send`
//   - `Far`, `getInterfaceOf`, `passStyleOf` from `@endo/pass-style`

// eslint-disable-next-line import/export
export * from './exports.js';
