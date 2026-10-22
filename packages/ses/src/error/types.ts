export type VirtualConsole = {
  debug: Console['debug'];
  log: Console['log'];
  info: Console['info'];
  warn: Console['warn'];
  error: Console['error'];
  trace: Console['trace'];
  dirxml: Console['dirxml'];
  group: Console['group'];
  groupCollapsed: Console['groupCollapsed'];
  assert: Console['assert'];
  timeLog: Console['timeLog'];
  clear: Console['clear'];
  count: Console['count'];
  countReset: Console['countReset'];
  dir: Console['dir'];
  groupEnd: Console['groupEnd'];
  table: Console['table'];
  time: Console['time'];
  timeEnd: Console['timeEnd'];
  timeStamp: Console['timeStamp'];
};

export type LogSeverity = 'debug' | 'log' | 'info' | 'warn' | 'error';
export type ConsoleFilter = {
  canLog: (severity: LogSeverity) => boolean;
};
export type FilterConsole = (
  baseConsole: VirtualConsole,
  filter: ConsoleFilter,
  topic?: string,
) => VirtualConsole;
