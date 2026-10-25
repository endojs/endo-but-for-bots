// @ts-check
import { h } from 'preact';
import { useCallback, useRef, useState } from 'preact/hooks';

import { InputBar } from './InputBar.js';
import { SceneCanvas } from './SceneCanvas.js';
import { useBook } from './hooks/useBook.js';

// The host links whylip.css; importing it here would break plain Node loading.
const TASK_LABELS = harden({
  queued: 'Waiting for its turn',
  running: 'Taking shape',
  completed: 'Ready for the next page',
  failed: 'Needs another pass',
  applied: 'Woven into the story',
});

/**
 * A persistent story surface with a quiet, optional conversation drawer.
 * The host mounts this component through its confined Preact renderer.
 *
 * @param {object} props
 * @param {unknown} props.powers
 * @param {unknown} props.rootPowers
 * @param {string[]} props.profilePath
 * @param {(newPath: string[]) => void} props.onProfileChange
 */
export function WhylipApp({
  powers,
  rootPowers,
  profilePath,
  onProfileChange,
}) {
  const book = useBook(powers);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sceneError, setSceneError] = useState(
    /** @type {string | null} */ (null),
  );
  const sceneReports = useRef({
    powers,
    revisions: new Set(),
    current: /** @type {{ sourceRevision: string, message: string } | null} */ (
      null
    ),
  });
  const handleSceneError = useCallback(
    /** @param {string | null} message */
    message => {
      setSceneError(message);
      if (sceneReports.current.powers !== powers) {
        sceneReports.current = { powers, revisions: new Set(), current: null };
      }
      const reports = sceneReports.current;
      if (!message) {
        reports.current = null;
        return;
      }
      if (!book.ready) return;
      const sourceRevision = String(book.sourceRevision ?? '0');
      if (
        reports.current?.sourceRevision === sourceRevision &&
        reports.current.message === message
      )
        return;
      reports.current = { sourceRevision, message };
      // Keep the revision guard after recovery too: state changes must not
      // repeatedly wake the author for the same broken source revision.
      if (reports.revisions.has(sourceRevision)) return;
      reports.revisions.add(sourceRevision);
      book.act('scene-error', { message, sourceRevision });
    },
    [powers, book.ready, book.sourceRevision, book.act],
  );
  const handleRepair = useCallback(() => {
    if (sceneError && book.ready) {
      book.act('repair-scene', {
        message: sceneError,
        sourceRevision: String(book.sourceRevision ?? '0'),
      });
    }
  }, [sceneError, book.ready, book.sourceRevision, book.act]);
  const handleBack = useCallback(() => onProfileChange([]), [onProfileChange]);
  const thinking = book.status === 'thinking';
  const error = book.error || book.storyFailure?.reason || sceneError;
  /** @type {Array<{ id: string, title: string, status: string }>} */
  const tasks = book.tasks || [];
  const activeTasks = tasks.filter(
    task => task.status === 'queued' || task.status === 'running',
  );
  const illustrating = activeTasks.length > 0;
  const recentTasks = [
    ...activeTasks,
    ...tasks.filter(task => !activeTasks.includes(task)).slice(-2),
  ];

  return h(
    'div',
    { class: `whylip-layout${drawerOpen ? ' has-drawer' : ''}` },
    h(
      'header',
      { class: 'whylip-toolbar' },
      h(
        'div',
        { class: 'whylip-brand' },
        h(
          'button',
          {
            type: 'button',
            class: 'whylip-back-button',
            onClick: handleBack,
            'aria-label': 'Back to Home',
            title: 'Back to Home',
          },
          '←',
        ),
        h('span', { class: 'whylip-title' }, 'whylip'),
        h('span', { class: 'whylip-edition' }, 'a living storybook'),
      ),
      h(
        'div',
        { class: 'whylip-toolbar-actions' },
        h(
          'span',
          {
            class: `whylip-status${thinking || illustrating ? ' is-thinking' : ''}`,
            role: 'status',
            'aria-live': 'polite',
          },
          h('span', { class: 'whylip-status-dot', 'aria-hidden': 'true' }),
          thinking
            ? 'The story is unfolding…'
            : illustrating
              ? 'Illustrating in the background'
              : book.ready
                ? 'The book is listening'
                : 'Opening your book…',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'whylip-drawer-toggle',
            onClick: () => setDrawerOpen(!drawerOpen),
            'aria-expanded': drawerOpen,
            'aria-controls': 'whylip-conversation',
          },
          drawerOpen ? 'Close conversation ×' : 'Talk to the book ↗',
        ),
      ),
    ),
    h(
      'main',
      { class: 'whylip-main', 'aria-label': 'Interactive story' },
      h(SceneCanvas, {
        source: book.source,
        state: book.state,
        assets: book.assets,
        onAction: book.act,
        onState: book.updateState,
        onError: handleSceneError,
      }),
      error &&
        h(
          'div',
          { class: 'whylip-error', role: 'alert' },
          h('span', null, error),
          h(
            'button',
            {
              type: 'button',
              onClick: book.error
                ? book.retry
                : book.storyFailure
                  ? () => book.retryStory(book.storyFailure.id)
                  : handleRepair,
              disabled: !book.error && (!book.ready || thinking),
            },
            book.error
              ? 'Reconnect'
              : book.storyFailure
                ? 'Try again'
                : 'Repair scene',
          ),
        ),
    ),
    drawerOpen &&
      h(
        'aside',
        {
          id: 'whylip-conversation',
          class: 'whylip-drawer',
          'aria-label': 'Conversation with the book',
        },
        h(
          'div',
          { class: 'whylip-drawer-heading' },
          h('p', { class: 'whylip-eyebrow' }, 'In the margins'),
          h('h2', null, 'A word with the book'),
          h(
            'p',
            null,
            'Ask a question, suggest a twist, or tell the story what you imagine.',
          ),
        ),
        recentTasks.length > 0 &&
          h(
            'section',
            {
              class: 'whylip-background',
              'aria-label': 'Illustration progress',
            },
            h(
              'p',
              { class: 'whylip-background-heading', role: 'status' },
              illustrating
                ? 'Illustrating in the background'
                : 'Behind the pages',
            ),
            h(
              'ul',
              { class: 'whylip-background-list' },
              ...recentTasks.map(task =>
                h(
                  'li',
                  { key: task.id },
                  h('span', { class: 'whylip-background-title' }, task.title),
                  h(
                    'span',
                    { class: 'whylip-background-status' },
                    TASK_LABELS[task.status] || 'Taking shape',
                  ),
                ),
              ),
            ),
          ),
        h(
          'div',
          {
            class: 'whylip-messages',
            role: 'log',
            'aria-label': 'Story conversation',
            'aria-live': 'polite',
          },
          book.messages.length === 0 &&
            h(
              'p',
              { class: 'whylip-messages-empty' },
              'Every good story leaves room for you.',
            ),
          ...book.messages.map(message =>
            h(
              'article',
              {
                key: message.id,
                class: `whylip-message whylip-message-${message.role}`,
              },
              h(
                'span',
                { class: 'whylip-message-author' },
                message.role === 'user' ? 'You' : 'The book',
              ),
              h('p', null, message.content),
            ),
          ),
          thinking &&
            h(
              'p',
              { class: 'whylip-writing' },
              'Turning your words into a world…',
            ),
        ),
        h(InputBar, { onSend: book.send, disabled: thinking || !book.ready }),
      ),
  );
}
harden(WhylipApp);
