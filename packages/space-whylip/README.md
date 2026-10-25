# Whylip

Whylip is a living storybook inside Endo Chat.
The book fills the stage; a conversation drawer leaves room for questions and suggestions.
A Fae agent develops a Three.js world through a scoped filesystem capability.
Confined Preact provides the preferred virtual DOM for the 3D graph and accessible interface
overlay; keyed reconciliation keeps the canvas and scene objects alive as source changes.

## Quick start

1. Start the Endo daemon with `endo start`.
2. Provision an LLM provider service as described below.
3. Give the Fae factory the service locator under `llm-provider`.
   Cloud credentials remain in the provider service's separate guest namespace.
4. Run `yarn setup-factory` to create the configured Fae factory named `fae-factory`.
   For other names, set `PROVIDER_NAME` and `FACTORY_NAME` when running this command.
5. Launch Familiar, or run `yarn dev` in `packages/chat` and open the displayed development URL.
6. In the spaces gutter, choose **+ → Whylip Book**, name the book, and enter the factory's
   pet name, normally `fae-factory`.
7. Explore the opening illustration, choose a path, or open **Talk to the book**.

Creating a book asks the factory for a dedicated story agent and retains the factory
capability for background illustration workers.
The factory must expose `createAgentCapability`; factories loaded from older checkouts
need to be recreated from the updated Fae module.
For a packaged or remote deployment, set `WHYLIP_BOOK_MODULE_URL` at build time to the
book caplet URL available to that daemon; the development default points into this checkout.

The starter scene is interactive immediately.
Explore a low-poly moonlit forest, silver river, and wooden bridge.
Touch the lantern to light it, or wake the fireflies; these actions update local state.
Existing books retain their story progress and can reveal a clickable bell and watchful owl.
Choosing a path responds locally and sends a meaningful story event to the agent.

## Provider capabilities and hosted secrets

Whylip's story and background workers are Fae sessions.
The story session receives `book`; an illustration worker receives only its draft `task`.
The driver receives an LLM service with `chat(messages, tools)` and safe `getInfo()` metadata.
The same service can be delegated to other session runtimes that accept this interface;
this checkout wires it into Fae, not Floot's separate provider lifecycle.

For existing hosted Codex or Claude subscription brokers, use
`packages/fae/subscription-provider-service.js` on the hosted daemon.
Its dedicated guest receives only `llm-subscription`; configure a fixed provider kind,
model, and session identity, then delegate the resulting `chat` service to Whylip.
Codex uses the hosted release's Responses adapter, and Claude uses the broker's Messages
endpoint with thinking disabled.
The broker retains managed credentials and handles renewal; neither the local story
session nor this bridge needs a secret reader.
Discover models through the broker before selecting one.
Subscription credentials are not interchangeable with API keys.

Provision cloud services on the hosted Endo instance, or on a trusted local daemon
with an explicitly delegated reader capability from the hosted secret manager.
Add the API keys through its secret manager, for example as `openai-auth` and
`anthropic-auth`, and choose an explicit model ID for each service.
The trusted setup helper in `packages/fae/provider-setup.js` accepts the locator of one
secret reader from `host.locate('secrets', name)`.
It gives only that reader to a dedicated provider guest as `llm-auth-secret`.
Do not delegate the secret catalog, importer, or host to the story session.
The service fixes the cloud API destination, reads the secret afresh for each model call,
and returns a generic failure if credentials are missing or revoked.
Rotation takes effect on the next call.
The story model never receives the credential or the reader capability.
For short interactive turns, `gpt-6-luna` uses nonreasoning Chat Completions tool calls;
`claude-haiku-5-5` uses Messages with thinking disabled.
Model availability depends on the provider account.

Blackquartz can use a tokenless local service with an explicit tailnet endpoint and model.
At development verification its endpoint was `http://blackquartz.tail08c2a.ts.net:8080/v1`;
query `/models` at that base URL to discover the current model IDs.
Its model list can change independently of this checkout.
Use a provider service available to the daemon running the driver; a local preview does
not automatically gain access to hosted secrets.

Drivers resolve their `llm-provider` binding on every model call.
A trusted administrator can rebind that name to another service for the next call.
Changing the factory's binding affects newly provisioned drivers; existing driver guests
must be rebound too.
Already running calls finish with the provider they started with.
Drivers loaded before this implementation need to be reloaded once.

## Scene contract

`scene.js` contains one JavaScript expression returning a pure render function.
The preferred result is `{ scene, overlay }`: a declarative Three.js graph and a confined
Preact interface sharing persistent reader state.

```js
({ h }, { state, update }) => ({
  scene: h('scene', { key: 'world', background: '#102331' },
    h('perspectiveCamera', {
      key: 'camera', position: [6, 5, 9], lookAt: [0, 1, 0], fov: 45,
    }),
    h('ambientLight', { key: 'ambient', intensity: 1 }),
    h('mesh', {
      key: 'lantern', position: [0, 1, 0],
      geometry: { type: 'sphere', radius: 0.3 },
      material: {
        color: '#ffd687', emissive: '#e9a740',
        emissiveIntensity: state.lit ? 1 : 0,
      },
      onClick: () => update({ lit: !state.lit }),
    }),
  ),
  overlay: h('button', {
    key: 'light-control',
    type: 'button',
    'aria-pressed': Boolean(state.lit),
    onClick: () => update({ lit: !state.lit }),
  }, state.lit ? 'Dim the lantern' : 'Light the lantern'),
})
```

The render function receives `h` and `Fragment`, plus these explicit book values:

- `state`: the current reader state, owned by the book session.
- `update(patch)`: merge local state immediately, without waiting for the agent.
- `act(name, detail)`: send a meaningful reader action to the agent.
- `asset(path)`: resolve a book SVG illustration for an optional overlay image.

Every 3D node requires a globally unique stable string key.
The graph supports `scene`, `group`, `mesh`, `ambientLight`, `directionalLight`,
`pointLight`, and `perspectiveCamera`.
Groups and meshes accept `position`, `rotation` in radians, and `scale` as `[x, y, z]`,
plus `visible`.
The camera uses `position`, `lookAt`, `fov`, `near`, and `far`.
Lights accept hex `color` and `intensity`; point lights also accept `distance` and `decay`,
and directional lights use `position` and `target`.
The scene's `background` is a hex color.

Meshes use data descriptors rather than Three.js constructors:

| Geometry `type` | Dimensions |
| --- | --- |
| `box` | `width`, `height`, `depth` |
| `sphere` | `radius`, optional `widthSegments`, `heightSegments` |
| `cone` | `radius`, `height`, optional `radialSegments` |
| `cylinder` | `radiusTop`, `radiusBottom`, `height`, optional `radialSegments` |
| `plane` | `width`, `height`, optional `widthSegments`, `heightSegments` |
| `torus` | `radius`, `tube`, optional `radialSegments`, `tubularSegments`, `arc` |

A material descriptor accepts hex `color` and `emissive`, `emissiveIntensity`, `roughness`,
`metalness`, `opacity`, `wireframe`, and `side` (`front`, `back`, or `double`).
The graph budget is 256 nodes, depth 24, and 65,536 estimated vertices.
Prefer expressive low-poly forms and lighting to dense geometry.

A mesh's `onClick` guest callback can call `update` for immediate feedback and `act` for a
story decision.
The trusted host raycasts and dispatches the callback without passing Three.js objects to it.
Provide equivalent HTML buttons in the overlay for keyboard and assistive technology users.
Full-stage overlay wrappers should use `pointerEvents: 'none'`, with `auto` on controls,
so the overlay leaves the 3D world available for interaction.

Stable keys preserve the WebGL canvas, camera, meshes, and reusable resources across edits.
Store progress and interactive values in `state`; render functions have no hooks, persistent
module scope, or animation loops.
The host renders updates on demand.
A plain Preact return remains supported for a deliberately flat page or small UI task.
Use standard allowed HTML elements, event callbacks, and object-valued inline styles for
prose, controls, and optional 2D illustrations:

```js
h('img', {
  key: 'character-portrait',
  src: asset('assets/owl.svg'),
  alt: 'A watchful owl',
})
```

`asset` resolves stored SVG text to a data image; it does not insert live SVG markup.
The primary story environment should remain a Three.js scene.

## Live updates

The book filesystem is the agent's authoring surface.
It is a scoped text-file capability with `read(path)`, `write(path, text)`,
`edit(path, oldText, newText)`, `list()`, and `remove(path)` operations; it does not expose the host operating system's filesystem.
The active entry point is `scene.js`.
`edit` requires exactly one matching passage and publishes a complete replacement atomically.
For routine story beats, the agent reads `book.getContext()` and calls
`book.patchState({ narration: 'The lantern flickers in reply.' })`.
Both state patches and file edits return compact revision receipts; the agent need not read
or regenerate scene source just to change the visible story text.
`getSnapshot()` remains available when full source and conversation history are needed.
Reader state, conversation messages, and pending story events belong to the persistent book
session, separate from source files.
Source revisions are evaluated inside a SES compartment and rendered through
`@endo/preact-container`.
A stable scene component lets Preact reconcile the overlay in place, while the trusted
Three.js bridge reconciles the keyed scene graph without replacing its canvas.
Local reader updates and agent scene edits share the same persistent state, so small
changes do not require replacing the whole book.

A source error keeps the previous working scene visible and reports a recoverable error.
The scene remains interactive while an agent response is pending.
Reader events carry the current scene context to the agent; animation frames and ordinary
local interaction stay within the book.

Confinement does not give scene code ambient browser or filesystem authority.
Scene code receives only its explicit book capabilities.
Raw HTML, arbitrary DOM access, refs, scripts, inline SVG, and raw canvas elements are not
part of the guest contract.
The host alone creates the WebGL canvas and owns Three.js objects, raycasting, and resources.
Scene code cannot import Three.js, obtain a renderer, or call imperative object methods.
The confined renderer remains responsible for overlay elements, attributes, and events.

## Background illustrations and scenes

The foreground story agent can delegate slower illustration or scene work while continuing
to respond to the reader.
Start background work with `book.startTask(title, instructions)` and inspect progress with
`book.listTasks()`.
Up to two tasks may be active at once.
A quiet toolbar indicator and conversation-drawer details report background progress.

Each worker receives a separate draft capability with `read`, `write`, `edit`, `list`,
`getContext`, `complete(summary)`, and `fail(reason)` methods.
The worker develops keyed Three.js scene source, accessible Preact controls, and optional
illustration files, then marks the draft complete
for foreground review.
Completed drafts remain readable and cannot be edited further.
Worker edits do not publish directly into the reader's current scene.

The foreground agent reviews a completed task and explicitly publishes it with
`book.applyTask(id, expectedSourceRevision)`.
Publishing scene source requires both the supplied revision and the draft's original
`baseSourceRevision` to match the current source revision.
A stale draft must be rebased manually by copying the desired changes through live
`files.edit`, or replaced with a fresh task; completed drafts cannot be reopened.
An assets-only draft cannot replace an existing asset with different bytes.
Applying a draft never overwrites reader state, so exploration and choices made while the
worker was drawing survive publication.
Task progress is recorded as queued, running, completed, failed, or applied.
The foreground receives `WHYLIP_TASK_COMPLETED` or `WHYLIP_TASK_FAILED` notifications.
Each Fae turn is limited to 20 model calls; exhausting that limit marks unfinished work
as failed so a confused helper cannot loop indefinitely.
Inspection calls must explicitly return their results from `exec`; console output is
diagnostic-only and is not included in the model's tool result.
Background helper profiles are currently pinned and retained after tasks finish;
automatic helper cleanup is not implemented.

## Refreshing an existing story's prompt

New books receive the current `WHYLIP_SYSTEM_PROMPT` during provisioning. An existing
Fae conversation retains its original system record. To refresh its instructions without
restarting that conversation, instantiate `src/prompt-provider.js` in a dedicated worker
with a guest namespace containing only `upstream-provider` (a `chat/getInfo` capability).
Bind the adapter to the foreground driver's `llm-provider`. It replaces outbound system
records with the current Whylip prompt while preserving user, assistant, and tool turns.
Keep helper drivers on their original provider so their separate task prompt is retained.
The adapter needs no secret-manager or credential access.

## Source layout

- `src/App.js`: story stage, connection feedback, errors, and optional conversation drawer.
- `src/SceneCanvas.js`: persistent trusted WebGL surface beside confined overlays.
- `src/scene-runtime.js`: compartment evaluation, bounded graph copying, and safe callbacks.
- `src/three-scene.js`: validated keyed graph reconciliation, picking, and GPU resource disposal.
- `src/prompt-provider.js`: foreground prompt refresh without restarting the Fae conversation.
- `src/starter-scene.js`: low-poly forest, river, bridge, lantern, owl, and bell scene with
  accessible Preact controls and initial state.
- `src/hooks/useBook.js`: book session, live source subscription, and agent conversation.
- `src/InputBar.js`: conversation composer.
- `src/whylip.css`: responsive book presentation and reduced-motion-aware animation.

The package exports `WhylipApp`; it does not mount its own DOM root.
The Chat host mounts it through confined Preact and links the exported `whylip.css` stylesheet.

## Browser verification

Run `yarn test:whylip-live` in `packages/chat` with Playwright Chromium installed.
The real-browser harness runs SES lockdown and the confined renderer, requires a visible
Three.js canvas, and exercises local lantern, firefly, and bell interactions.
It verifies canvas identity, focused elements, and reader state survive source replacement,
and checks that invalid source preserves the last working interactive scene.
It writes desktop and mobile screenshots to `/tmp/whylip-confined-desktop.png` and
`/tmp/whylip-confined-mobile.png`.
The reported update time measures renderer source replacement through the next animation
frame; it excludes filesystem transport and agent latency.

Live verification with Blackquartz's `gemma-4-26b-a4b` completed a warm reader choice in
2.66 seconds from the durable event to `finishEvent`, with one model call and one `exec`.
This is a single development measurement, not a latency guarantee or a browser paint measurement.
A separate tiny tool-call probe took 20.7 seconds with the model initially unloaded and
0.42 seconds when repeated warm.
Keep cold model loading separate from steady interaction latency when comparing providers.
The foreground prompt favors compact state patches and explicit `finishTurn: true`;
illustration workers have separate draft contexts so large asset output does not block
the foreground's capability execution.

A live Codex-backed bell interaction after the Three.js migration completed in 4.33 seconds
from the durable event to completion. This single development sample includes provider and
agent work; local mesh reactions remain independent of that round trip.
