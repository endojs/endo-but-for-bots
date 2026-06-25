/* eslint-disable import/no-unresolved */
// @ts-nocheck

// Re-exporting from an exit module supplied through the `modules` map. This
// exercises the export-notifier wiring that re-exports require: the exit module
// instance must present a notifier per export name.
export { meaning } from 'h2g2:meaning';
