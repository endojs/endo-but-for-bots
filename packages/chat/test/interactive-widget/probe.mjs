// @ts-check
import '../../pre-lockdown.js';
import '@endo/init';
import { InteractiveWidget } from '@endo/spaces-util/interactive-widget.js';
import { h, renderConfined, unmount } from '../../setup-preact-container.js';

globalThis.mountWidget = source =>
  renderConfined(
    h(InteractiveWidget, { source }),
    document.getElementById('widget'),
  );
globalThis.clearWidget = () => unmount(document.getElementById('widget'));
