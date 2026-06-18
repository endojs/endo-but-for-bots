/**
 * @file Type surface for the confined XDG notification plugin.
 *
 * Design constraints come from:
 * - Desktop Notifications Specification v1.3, 2024-08-18.
 *   https://specifications.freedesktop.org/notification/latest/
 * - XDG Desktop Portal `org.freedesktop.portal.Notification` documentation,
 *   version 2, 2025.
 *   https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Notification.html
 */

/* eslint-disable no-use-before-define */

/**
 * D-Bus bus address: the bus name, object path, and interface
 * that identify a D-Bus endpoint.
 */
export type DBusAddress = {
  readonly objectPath: string;
  readonly busName: string;
  readonly interface: string;
};

/**
 * Raw D-Bus socket capability exposed by the unconfined dbus-sock plugin.
 */
export type DBusSock = {
  connect(): Promise<void>;
  authenticate(): Promise<void>;
  hello(): Promise<void>;
  callMethod(payload: string, timeoutMs?: number): Promise<string>;
  readMessage(timeoutMs?: number): Promise<string>;
  close(): void;
};

/** A desktop notification to send via the portal or classic XDG D-Bus APIs. */
export type Notification = {
  readonly title?: string;
  readonly body?: string;
  readonly 'markup-body'?: string;
  readonly priority?: 'low' | 'normal' | 'high' | 'urgent';
  readonly 'default-action'?: string;
  readonly 'default-action-target'?: unknown;
  readonly buttons?: readonly {
    readonly label?: string;
    readonly action: string;
    readonly target?: unknown;
  }[];
  readonly category?: string;
};

/** Options supported by the notification server per portal `SupportedOptions`. */
export type SupportedOptions = {
  readonly category?: readonly string[];
  readonly 'button-purpose'?: readonly string[];
};

/**
 * Confined NotificationDaemon exposed by the notify-xdg plugin.
 */
export type NotificationDaemon = {
  addNotification(
    id: string,
    notification: Notification,
  ): Promise<number | undefined>;
  removeNotification(id: string): Promise<void>;
  getSupportedOptions(): Promise<SupportedOptions>;
  close(): Promise<void>;
};

/** Result emitted by `org.freedesktop.portal.Request.Response`. */
export type PortalResponse = {
  readonly response: number;
  readonly results: Record<string, unknown>;
};

export type FileChooserFilterRule = readonly [0 | 1, string];

export type FileChooserFilter = readonly [
  string,
  readonly FileChooserFilterRule[],
];

export type FileChooserChoice = readonly [
  string,
  string,
  readonly (readonly [string, string])[],
  string,
];

export type FileChooserCurrentFilter = FileChooserFilter;

export type DBusValueSig = 'as' | 'a(ss)' | '(sa(us))';

export type DBusValueBySig = {
  readonly as: readonly string[];
  readonly 'a(ss)': Record<string, string>;
  readonly '(sa(us))': FileChooserCurrentFilter;
};

export type AsPassable = {
  <S extends DBusValueSig>(sig: S, value: undefined): undefined;
  <S extends DBusValueSig>(sig: S, value: unknown): DBusValueBySig[S];
};

export type FileChooserOpenOptions = {
  readonly handle_token?: string;
  readonly accept_label?: string;
  readonly modal?: boolean;
  readonly multiple?: boolean;
  readonly directory?: boolean;
  readonly filters?: readonly FileChooserFilter[];
  readonly current_filter?: FileChooserCurrentFilter;
  readonly choices?: readonly FileChooserChoice[];
  readonly current_folder?: Uint8Array;
};

export type FileChooserOpenResults = {
  readonly uris?: readonly string[];
  readonly choices?: Record<string, string>;
  readonly current_filter?: FileChooserCurrentFilter;
};

export type FileChooserResponse = {
  readonly response: number;
  readonly results: FileChooserOpenResults;
};

/** Confined file chooser portal exposed by the notify-xdg package. */
export type FileChooser = {
  openFile(
    parentWindow: string,
    title: string,
    options?: FileChooserOpenOptions,
  ): Promise<FileChooserResponse>;
  close(): Promise<void>;
};
