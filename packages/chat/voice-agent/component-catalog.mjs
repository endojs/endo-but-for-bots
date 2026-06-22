// component-catalog.mjs — the single, canonical list of UI building blocks an authoring agent should reach
// for BEFORE hand-rolling markup. It is the "reuse first" enabler: agents can't reuse what they can't see,
// so this catalog is injected into the component-authoring prompts (server.mjs) and is the reference the
// theme-review kit-consistency lens checks against. Keep it in sync as kit primitives / islands ship.
//
// The discipline (dan): ALWAYS prefer an existing component; compose the kit + islands. Create a NEW
// component only when no existing one meets the need — and when you do, build it FROM kit primitives, keep
// it general + theme-var-only, and register it so the next agent reuses it instead of reinventing.

// confined-Preact KIT primitives (client/ui-kit.js) — the design system. Compose these first.
export const KIT = [
  ['Card', 'a bordered, padded surface/container'],
  ['Btn', 'a button — variant: primary | ghost | danger'],
  ['IconBtn', 'a compact icon-only button'],
  ['Chip', 'a small rounded label/tag'],
  ['Badge', 'a tiny count/status badge'],
  ['Banner', 'a full-width inline notice — kind: info | warn | error | ok'],
  ['EmptyState', 'a centered "nothing here yet" placeholder'],
  ['Meta', 'a muted metadata line (use joinDot for dot-separated parts)'],
  ['Spinner', 'a loading spinner'],
  ['Avatar', 'a circular avatar / initial'],
  ['ProgressBar', 'a determinate progress bar'],
  ['Divider', 'a horizontal rule'],
  ['Stack', 'vertical flex layout'],
  ['Row', 'horizontal flex layout'],
  ['Field', 'a labelled form-control wrapper'],
  ['TextField', 'a single-line text input'],
  ['Textarea', 'a multi-line text input'],
  ['Select', 'a dropdown select'],
  ['Checkbox', 'a boolean checkbox'],
  ['Radio', 'a single radio option'],
  ['RadioGroup', 'a group of mutually-exclusive radios'],
  ['Toggle', 'an on/off switch'],
  ['Tabs', 'a tabbed switcher'],
  ['SegmentedControl', 'a segmented option switcher'],
  ['Slider', 'a range slider'],
  ['Skeleton', 'a loading placeholder block'],
  ['Disclosure', 'a collapsible summary/detail'],
  ['Breadcrumb', 'a path / crumb trail'],
  ['Modal', 'a dialog overlay'],
  ['Tooltip', 'a hover tooltip'],
  ['Menu', 'a popover menu'],
  ['Toast', 'a transient notification'],
  ['Pagination', 'page navigation'],
  ['Table', 'tabular rendering'],
  ['List', 'list rendering with optional select'],
  ['Drawer', 'a slide-in side panel'],
  ['Stepper', 'a multi-step progress indicator'],
];

// composed ISLANDS (client/*.js) — whole, themed, tested pieces of the app. Reuse one wholesale when it fits.
export const ISLANDS = [
  ['ProposalCard', 'confirm/reject a proposed destructive action (typed body per action)'],
  ['AskCard', 'a structured question form (choice / multiselect / number / secret / text)'],
  ['ChatList', 'the sidebar list of chats (select / delete / inline rename / show-more)'],
  ['MessageControls', 'the ↻ retry / ✎ edit / 🔊 audio + fork-pager row for a message'],
  ['ChatMetaBar', 'the per-chat header (title, parent/project chips, share badge) / memo version scrubber'],
  ['DevTaskCard', 'a Blacksmith/dev task with status + a collapsible reply thread'],
  ['ExhaustedCard', 'the out-of-allowance top-up / abandon card'],
  ['TraceSignature', 'the reasoning-trace strip (collapsed glyphs / expanded step tree)'],
  ['ObjectBrowser', 'a drill-down browser of capability objects with RO / full share'],
  ['ShareLinkManager', 'manage share links (badges, copy / QR / adjust / revoke, create form)'],
  ['SharesPanel', 'the panel of active outbound shares'],
  ['NotificationCard', 'a single notification (body / agent / status / links / Done)'],
  ['ChangelogList', 'the self-improvement changelog with per-row revert'],
  ['PowersBanner', 'the "this chat can…" power chips (revoke / add)'],
  ['KitSampler', 'a living sample of every kit primitive (design-system reference)'],
];

// live WIDGET verbs the agent emits in a reply (rendered by the host into grain-backed widgets).
export const WIDGETS = [
  ['showEntityStatus', 'a LIVE device/entity status (door, sensor, switch) that keeps updating'],
  ['showCountdowns', 'one or more LIVE countdown timers (cooking steps, reminders)'],
  ['showChoices', 'a "pick one" choice set the user taps'],
];

const fmt = rows => rows.map(([n, d]) => `  - ${n}: ${d}`).join('\n');

// the human/agent-facing catalog text.
export const catalogText = () => `KIT PRIMITIVES (compose these):\n${fmt(KIT)}\n\nISLANDS (reuse whole):\n${fmt(ISLANDS)}\n\nLIVE WIDGET VERBS (in a reply):\n${fmt(WIDGETS)}`;

// the reuse-first directive prepended to component-authoring system prompts.
export const reuseFirstPreamble = () =>
  `REUSE FIRST. Agent C already ships themed, tested UI building blocks. Before writing new markup, COMPOSE these — reach for a kit primitive or whole island that fits the need. Create a NEW component ONLY when none of them meets the need; and when you must, build it FROM kit primitives, use theme vars only (never hardcoded colours — light/dark must both work), keep it general + stateless, and prefer it become reusable rather than one-off.\n\n${catalogText()}`;
