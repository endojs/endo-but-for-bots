// @ts-check
// Existing unconfined books formulas retain this URL.
/** @param {any} powers */
export const make = async powers => {
  const books = await import(
    new URL('../space-whylip/books.js', import.meta.url).href
  );
  return books.make(powers);
};
harden(make);
