import { h } from 'preact';

// ── SettingsShell island (P4 shell→island migration) — the settings modal's two-pane shell: a .setnav (the
// section nav, filled imperatively by app.js from SETTINGS_SECTIONS) + a .setbody (filled by
// renderSettingsSection). Editing this island re-flows the settings layout. Built ON-DEMAND (openSettings
// renders it into the modal), not boot-mounted. Keep #setnav / #setbody EXACTLY — app.js fills them by id.
export const SettingsShell = () => h('div', { class: 'setwrap' }, [
  h('div', { class: 'setnav', id: 'setnav' }),
  h('div', { class: 'setbody', id: 'setbody' }),
]);
