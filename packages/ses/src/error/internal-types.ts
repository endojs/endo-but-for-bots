import type { VirtualConsole } from './types.js';

export type LogArgs = readonly any[];
export type NoteCallback = (error: Error, noteLogArgs: LogArgs) => void;
export type GetStackString = (error: Error) => string | undefined;

/**
 * Used to parameterize `makeCausalConsole` to give it access to potentially
 * hidden information to augment the logging of errors.
 */
export type LoggedErrorHandler = {
  getStackString: GetStackString;
  tagError: (error: Error) => string;
  resetErrorTagNum: () => void;
  getMessageLogArgs: (error: Error) => LogArgs | undefined;
  takeMessageLogArgs: (error: Error) => LogArgs | undefined;
  takeNoteLogArgsArray: (error: Error, callback?: NoteCallback) => LogArgs[];
};

export type LogRecord = readonly [string, ...any[]];
export type LoggingConsoleKit = {
  loggingConsole: VirtualConsole;
  takeLog: () => readonly LogRecord[];
};
export type MakeLoggingConsoleKitOptions = {
  shouldResetForDebugging?: boolean;
};
export type MakeLoggingConsoleKit = (
  loggedErrorHandler: LoggedErrorHandler,
  options?: MakeLoggingConsoleKitOptions,
) => LoggingConsoleKit;
export type ErrorInfo = {
  NOTE: 'ERROR_NOTE:';
  MESSAGE: 'ERROR_MESSAGE:';
  CAUSE: 'cause:';
  ERRORS: 'errors:';
};
export type ErrorInfoKind = ErrorInfo[keyof ErrorInfo];
export type MakeCausalConsole = (
  baseConsole: VirtualConsole | undefined,
  loggedErrorHandler: LoggedErrorHandler,
) => VirtualConsole | undefined;
