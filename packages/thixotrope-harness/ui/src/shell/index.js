// @ts-check
/**
 * The shell's entry points (m3-interfaces.md 17, W3.4). Views of other
 * directories import `Slot` from here to render a slot (`composer.addon`,
 * `message.renderer`, `newSession.field`).
 */
export { App } from './App.js';
export { Header } from './Header.js';
export { Overlay, overlayText } from './Overlay.js';
export { FeatureHost, Slot, featureError, visibleFeatures } from './Slot.js';
export { StatusBar, usageLabel } from './StatusBar.js';
export { mount, narrowQuery } from './mount.js';
