// @ts-check

/**
 * @file Endo daemon plugin: XDG Desktop Notification daemon.
 *
 * Loaded as a confined plugin.  It does no ambient I/O directly and
 * receives a `DBusSock` capability through powers.
 *
 * Design constraints come from:
 * - Desktop Notifications Specification v1.3, 2024-08-18, §2 Basic Design.
 *   https://specifications.freedesktop.org/notification/latest/
 * - XDG Desktop Portal `org.freedesktop.portal.Notification` documentation,
 *   version 2, 2025.
 *   https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Notification.html
 *
 * Two D-Bus notification pathways:
 * - org.freedesktop.Notifications (classic daemon)
 * - org.freedesktop.portal.Notification (XDG Desktop Portal v2)
 *
 * The plugin auto-detects by trying the portal first, then falling
 * back to the classic daemon.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { decodeBase64, encodeBase64 } from '@endo/base64';
import { E } from '@endo/eventual-send';
import { newMethodCall } from './dbus-msg.js';

/** @import { DBusAddress, DBusSock, Notification, NotificationDaemon, SupportedOptions } from './types.js' */

// ---------------------------------------------------------------------------
// Pattern guards
// ---------------------------------------------------------------------------

const NotificationDaemonI = M.interface('NotificationDaemon', {
  addNotification: M.callWhen(M.string(), M.record()).returns(
    M.or(M.number(), M.undefined()),
  ),
  removeNotification: M.callWhen(M.string()).returns(M.undefined()),
  getSupportedOptions: M.callWhen().returns(M.record()),
  close: M.callWhen().returns(M.undefined()),
});

// ---------------------------------------------------------------------------
// D-Bus addresses
// ---------------------------------------------------------------------------

/** @type {DBusAddress} */
const NOTIFY_ADDR = harden({
  objectPath: '/org/freedesktop/Notifications',
  busName: 'org.freedesktop.Notifications',
  interface: 'org.freedesktop.Notifications',
});

const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/notification';
const PORTAL_INTERFACE = 'org.freedesktop.portal.Notification';

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/**
 * Convert a Notification to the portal's D-Bus `a{sv}` dict representation.
 * Each value is a `[signature, value]` pair for variant packing.
 * Keys and value forms follow `org.freedesktop.portal.Notification` v2.
 * @param {Notification} n
 * @returns {Record<string, [string, unknown]>}
 */
export const notificationToDict = n =>
  harden({
    ...(n.title !== undefined && { title: ['s', n.title] }),
    ...(n.body !== undefined && { body: ['s', n.body] }),
    ...(n['markup-body'] !== undefined && {
      'markup-body': ['s', n['markup-body']],
    }),
    ...(n.priority !== undefined && { priority: ['s', n.priority] }),
    ...(n['default-action'] !== undefined && {
      'default-action': ['s', n['default-action']],
    }),
    ...(n['default-action-target'] !== undefined && {
      'default-action-target':
        typeof n['default-action-target'] === 'number'
          ? ['i', n['default-action-target']]
          : ['s', String(n['default-action-target'])],
    }),
    ...(n.buttons !== undefined && {
      buttons: [
        'aa{sv}',
        n.buttons.map(b => ({
          action: ['s', b.action],
          ...(b.label !== undefined && { label: ['s', b.label] }),
          ...(b.target !== undefined && { target: ['s', String(b.target)] }),
        })),
      ],
    }),
    ...(n.category !== undefined && { category: ['s', n.category] }),
  });
harden(notificationToDict);

/**
 * Build the classic org.freedesktop.Notifications.Notify method call.
 * The `susssasa{sv}i` signature is fixed by Desktop Notifications v1.3.
 * @param {Notification} notification
 * @returns {Uint8Array}
 */
const buildNotifyPayload = notification =>
  newMethodCall(
    NOTIFY_ADDR,
    'Notify',
    'susssasa{sv}i',
    // FIXME: notification.body should default to '' not [] — array in string position
    // will crash at serialization when body is undefined.
    [
      'notify-send',
      0,
      '',
      notification.title ?? '',
      notification.body ?? '',
      [],
      {},
      -1,
    ],
  );

/**
 * Build the portal's AddNotification method call.
 * @param {string} id
 * @param {Notification} notification
 * @returns {Uint8Array}
 */
const buildAddNotificationPayload = (id, notification) => {
  const dict = notificationToDict(notification);
  return newMethodCall(
    {
      objectPath: PORTAL_OBJECT_PATH,
      busName: PORTAL_BUS_NAME,
      interface: PORTAL_INTERFACE,
    },
    'AddNotification',
    'sa{sv}',
    [id, dict],
  );
};

// ---------------------------------------------------------------------------
// Reply parsing
// ---------------------------------------------------------------------------

/* eslint-disable no-bitwise */
/**
 * Extract notification ID from a Notify method-return body (single u32).
 * @param {Uint8Array} data
 * @returns {number}
 */
const parseReplyId = data => {
  if (data.length < 16) throw Error('Reply too short for D-Bus header');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fieldsLen = dv.getUint32(12, true);
  const bodyOff = ((16 + fieldsLen + 7) >> 3) << 3;
  if (bodyOff + 4 > data.length) throw Error('Reply body too short for u32');
  return dv.getUint32(bodyOff, true);
};
/* eslint-enable no-bitwise */

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Create a NotificationDaemon.
 *
 * The `powers` object must provide a `lookup` that resolves
 * `'dbus-sock'` to a DBusSock. The socket capability is responsible
 * for deriving its own path and uid configuration.
 *
 * The daemon tries the XDG Desktop Portal first; if that fails
 * (e.g. portal not available), it falls back to the classic
 * org.freedesktop.Notifications interface.
 *
 * @param {object} powers - Guest powers with `lookup` for dbus-sock
 * @returns {Promise<NotificationDaemon>}
 */
export const make = async powers => {
  const dbusSock = await E(powers).lookup('dbus-sock');
  void E(dbusSock).connect();
  void E(dbusSock).authenticate();
  void E(dbusSock).hello();

  return makeExo('NotificationDaemon', NotificationDaemonI, {
    /**
     * Send or update a notification.
     * @param {string} id - Application-provided notification ID
     * @param {Notification} notification
     * @returns {Promise<number>}
     */
    async addNotification(id, notification) {
      await null;
      // Try portal first, fall back to classic daemon
      const pkt = buildAddNotificationPayload(id, notification);
      try {
        await E(dbusSock).callMethod(encodeBase64(pkt));
        return 0;
      } catch {
        const pkt2 = buildNotifyPayload(notification);
        const reply = decodeBase64(
          await E(dbusSock).callMethod(encodeBase64(pkt2)),
        );
        return parseReplyId(reply);
      }
    },

    /**
     * Withdraw a notification by its application-provided ID.
     * @param {string} id
     * @returns {Promise<void>}
     */
    async removeNotification(id) {
      await null;
      const pkt = newMethodCall(
        {
          objectPath: PORTAL_OBJECT_PATH,
          busName: PORTAL_BUS_NAME,
          interface: PORTAL_INTERFACE,
        },
        'RemoveNotification',
        's',
        [id],
      );
      // Best-effort: portal or classic may not support removal
      try {
        await E(dbusSock).callMethod(encodeBase64(pkt));
      } catch {
        // ignore
      }
    },

    /**
     * Returns options supported by the notification server.
     * @returns {Promise<SupportedOptions>}
     */
    async getSupportedOptions() {
      await null;
      return harden({});
    },

    /**
     * Close the underlying D-Bus socket.
     * @returns {Promise<void>}
     */
    async close() {
      await E(dbusSock).close();
    },
  });
};
harden(make);
