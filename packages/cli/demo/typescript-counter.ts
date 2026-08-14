// The confined worklet runtime provides `Far` as a global endowment; declare
// it so the strip-only TypeScript check resolves the name without emitting code.
declare const Far: <T extends object>(farName: string, methods: T) => T;

export const make = () => {
  let counter: number = 0;
  return Far('Counter', {
    incr(): number {
      counter += 1;
      return counter;
    },
  });
};
