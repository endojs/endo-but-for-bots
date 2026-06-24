/* eslint-disable no-restricted-globals */

export type Reporter = {
  warn: (...message: Array<any>) => void;
  error: (...message: Array<any>) => void;
};

export type GroupReporter = Reporter & {
  groupCollapsed?: (label: string) => void;
  groupEnd?: () => void;
};

// Console implements GroupReporter
