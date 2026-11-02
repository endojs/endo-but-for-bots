// @ts-check

/** @param {null | Promise<null>} powers */
export const make = async powers => {
  if ((await powers) !== null) throw Error('Unexpected constructor authority');
  // Test-only observation that the dedicated worker reached the constructor.
  console.error('Native session constructor is pending');
  return new Promise(() => {});
};
harden(make);
