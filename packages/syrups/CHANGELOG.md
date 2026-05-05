# Change Log

## 0.1.0 (unreleased)

- Initial release.
  Provides `makeSyrupsReader` and `makeSyrupsWriter` for the
  comma-less length-prefixed framing used by the OCapN
  `tcp+syrups` netlayer variant.
  Grammar is `<length>:<payload>` with no trailing separator, matching
  the on-the-wire encoding of a Syrup byte-string record.
