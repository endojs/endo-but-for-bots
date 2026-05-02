/* global E, Far */
export const make = agent => {
  return Far('Service', {
    async ask() {
      return E(agent).request(
        '@host',
        'the meaning of life, the universe, everything',
        'answer',
      );
    },
  });
};
