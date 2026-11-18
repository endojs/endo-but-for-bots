# M5 interface contract

Unit W5.0 of `milestones.md` M5. This file, `guest/lib/interfaces-m5.js`,
`guest/lib/interfaces-m5-factory.js` and `guest/lib/limits-m5.js` are the contract the M5 builders
(group A: W5.1, W5.2, W5.3, W5.4; group B: W5.5, W5.6, W5.7, W5.8) and the integration unit W5.9
build against without talking to each other. Revised by W5.0-settle after the cross-check of the
M3, M4 and M5 contracts (journal J-0718..J-0722). `m1a-interfaces.md`, `m1b-interfaces.md` and
`m2-interfaces.md` stay the earlier contracts and everything in them holds unless a section below
changes it. Where this file and the guard files disagree, the guards win and this file is wrong:
report it. Paths: `H/` = `packages/thixotrope-harness/`, `AH/` = `H/resources/agent-host/impl/`.
Spec items are `P-n` (parity checklist, SPEC section 10), `R3-n`, `R4-n`, `R5-n`, `R6-n`, `R7-n`
and `A.n`, `F.n` of `endo-harness-spec.md` (outside the repository; never copy its deployment
details); "architecture n" is `designs/architecture.md` section n; "M2 n" is `m2-interfaces.md`
section n. Fae and Floot sources are read at `1315bef86` (`git show 1315bef86:<path>` in the main
worktree).

M5 runs in parallel with M3 (chat UI and gateway) and M4 (secrets manager and subscription pools),
each in its own lane, all three starting from M2 as merged. Everything here is designed so the
three lanes merge with the few one-line seams of section 9.1.

Contents: 1 scope and rules; 2 objects and interfaces; 3 what M5 takes from M2; 4 seams with M3
and M4; 5 restart, crash and retry; 6 security; 7 work units; 8 acceptance and performance; 9
merge hotspots, core requests and owner decisions; 10 module entry points; 11 hook tables; 12
fixed texts.

---

## 1. Scope and rules

### 1.1 What M5 delivers

| P | what M5 builds | left to |
|---|---|---|
| P-20 presets | the preset catalogue with the built-in presets `chat-only`, `general` (without a shell), `development`, `new-project`, `voice` listed; user presets; snapshot at creation (R3-7, R4-4); the default preset rule (R3-20) | M6 provisions the shell and workspace objects of `general`, `development`, `new-project`, `voice` (until then those templates are listed but `available: false`); `full-control` waits for open decision 5; M11 the voice shortcut and `voice`'s fixed model |
| P-53 grant flow | the factory gives a new session its preset's endowments (operator inventory objects under chosen labels, at most 32, R3-17, R3-22, R3-270); `chat-only` takes none | |
| P-15 prompt composition (full) | parts 1, 2 (rewritten for the persistent scope and the M5 `powers`), 3 (empty), 7 (preset instructions) through a section table later milestones append to; the turn's R4-29 line | part 4 (delegation) M9, part 5 (widget protocol) M12, part 6 object-kind sections M6 |
| P-16 exec (full) | `powers` as a per-call facet over the session's label map (`lookup`, `list`, `store`, `remove`); the exec membrane | |
| P-17 object tools | `list`, `lookup`, `store`, `remove`, `describeCapability`, `readSources` | `readSources` over real files when M6's `Dir` implements `SourceReader` |
| P-65 granted tools | `SessionGrants.grantTool(tool)` and `adoptTool`; built-in names protected; duplicates refused (both); withdraw | M9: tools adopted from mail |
| P-40 @-mention | packages on `Session.enqueueMessageOnce`, `Composer.submit(..., { attachments })`, `adopt`, `adoptTool`, the R4-29 line, release after the turn; composer autocomplete and attachment chips (W5.8, M3's `composer.addon` and `message.renderer` slots) | M9: inbox packages through the same package table |
| P-49 preset editor | the catalogue API and the editor UI (W5.8) | M11 the voice-shortcut choice |
| P-52 (mapping rows) | the minimal operator inventory (`Inventory`, `InventoryEntry`) | M12 the Home view, relabel UI, live feed |

R items: R3-1, R3-5, R3-6, R3-7, R3-8, R3-9, R3-11, R3-16 (listing only), R3-17, R3-20, R3-22,
R3-29, R3-30 (stub until M8), R3-31, R3-32, R3-41, R3-42, R3-265, R3-270, R3-271, R3-273, R4-4,
R4-26, R4-27, R4-28, R4-29, R4-38, R4-99, R5-52, R6-40, R6-55, R7-6, R7-38, R7-45.

Not in M5: shell presets' objects (M6), network policy (M7: a preset's `networkPolicy` is stored
data until then), `viewImage` (M8), mail and subagents (M9), the voice shortcut (M11), widgets and
Home (M12), exporting the label map or exec bindings (open decision O-8).

### 1.2 Rules (decisions D-M5-1 .. D-M5-6)

Contract 1, M1b 1.1 and M2 1.1 hold. M5 adds:

1. **D-M5-1 Objects, not names.** A preset is an object (`Preset`), passed to
   `createSession({ preset })` and edited through its own methods; an inventory entry is an object
   (`InventoryEntry`); an endowment and an attachment are `{ label, value }` records whose value is
   the object. Names allowed in M5, each for an F.2 reason: preset, endowment, inventory and
   attachment labels (F.2 a); labels in tool arguments and the package message number (F.2 b);
   the catalogue revision (F.2 e); inventory cursors (F.2 d). There is no preset id: the UI lists
   `Preset` objects and a page re-finds them by listing again.
2. **D-M5-2 No untrusted answer enters a session vat.** Fact 2: one inbound message above about
   94 KB halts a vat for good, and decoding happens before any guard (fact 4: fresh record keys
   cost the vat names for life). An object the session did not mint (an endowment, an adopted
   attachment, a granted tool, a stored exec object) may answer anything. So **the session vat
   never makes an answered call to such an object**. Every such call (`lookup`'s method names,
   `describeCapability`, `readSources`, a granted tool's `schema()` and `execute()`) goes through
   the **inspector**: `ExecScope.inspect(request)` in the session's exec vat, which calls the
   target, renders and bounds the answer (tool limit, staged over `inlineBytes`) and answers the
   session with a value of the closed `InspectOutcome` shape. A hostile answer halts at most the
   exec vat; the session then retires it as for any lost exec vat and states the scope loss
   (`texts.inspectTerminated`). Core request CC-070 would make this unnecessary.
3. **D-M5-3 The exec membrane.** Model-written code in the exec vat now holds objects of other
   vats (`powers.lookup`). An argument over about 94 KB halts the receiving vat, and fresh keys
   drain its name table. Every remotable `powers` hands to model code is wrapped in a membrane
   (`guest/exec/membrane.js`): a call through it is refused in the exec vat, before it leaves,
   when its estimated bytes (units x 3) exceed `membraneArgBytes` (12,288), a record has more than
   `membraneRecordKeys` (32) keys, the message more than `membraneMessageKeys` (256) record keys
   in all, or nesting is deeper than `membraneDepth` (32). Remotable answers are wrapped again;
   membrane wrappers passed as arguments are unwrapped to their targets; objects the exec vat made
   pass as they are. The membrane is per call and dies with it (rule 12.13): a closed call's
   wrappers send nowhere (they use the call's `E`). Residual risk: model code can still drip
   distinct keys into another vat over many calls (open decision O-9; core request CC-071).
4. **D-M5-4 One label map per session, in the session vat.** The label map (`labels.js`) is the
   single store of what a session holds by label (architecture D-11, coverage 34): a `Map` from
   label to binding, bounded by `maxLabels` (256) and, for stored JSON, `labelJsonBytes`. Object
   tools, `powers`, `adopt` and the creation-time seeds read and write it. Model JSON never
   becomes a record in the session vat (rule 12.10; `no-data-keys` lint forbids `JSON.parse`
   there): stored values are kept as the model's text, and M5's built-in tools read their
   arguments with `parseClosedArgs` (section 2.4.2), which refuses an unknown key before any
   record is built.
5. **D-M5-5 Parallel-lane seams.** M5 adds no interface to `interfaces.js`: its versions of M2
   interfaces are built in `interfaces-m5*.js` with `extendInterface(base, name, extra)` from the
   M2 guard's `payload.methodGuards` (checked in Node; CC-072 asks for the prelude helper), and
   `m5Extensions` / `m5FactoryExtensions` hold M5's method guards alone, so a later milestone
   that extends the same interface adds one spread (M4 extends neither `Session` nor `Operator`;
   section 9.1). M5's only edits to `interfaces.js`
   are the four additive widenings of `m5Widenings`, all made by W5.3 in its first commit. M5's
   settings are in `limits-m5.js` (no line in `limits.js` or `config/defaults.js`).
6. **D-M5-6 Switch once, stub the rest** (as M2 1.3). The exos whose guards M5 extends switch to
   their M5 guard once, in one commit by their group A owner, with every M5 method present: built,
   a stub throwing `Error(textOf.notBuilt('<method>'))` (M2's text), or a forward to a runtime
   part (`m5-parts.js`, section 11) that a group B unit registers. W5.9 greps that no `notBuilt`
   stub remains.

### 1.3 Sizes

String content bytes, UTF-8, keys included (contract rule 4); estimates in vats are units x 3.
`limits-m5.js` holds every M5 setting with its reason. The ones that decide frames:

| object | largest | why it fits |
|---|---|---|
| `PresetRecord` (create, save) | label 120 + description 500 + instructions 4,096 + model 256 + effort 32 units, 32 endowments of 80-unit labels, 16 template objects | the field bounds alone admit about 31.6 KB at three bytes a unit (smallcaps, measured in W5.0-settle; 23,107 string bytes without template objects), so the record as a whole is bounded: string content bytes (keys included) <= `presetRecordBytes` = `frameBytes` - 2,048 = 22,528, checked with `fitsFrame` by the editor before sending and by the catalogue's validation (`texts.presetTooLarge`). An all-ASCII maximal record is about 8 KB and passes; a maximal three-byte record must trim about 600 bytes. The gateway's frame guard (M3) refuses a call over `frameBytes` before the hub |
| `Preset.describe()` -> `PresetView` | a saved record + `builtIn`, `revision`, `available`, `unavailableReason` (< 200 bytes) | <= 22,528 + 200 string bytes, leaving > 1.8 KB of `frameBytes` for the envelope and up to 34 handles; typical < 6 KB |
| `PresetSnapshot` (`Preset.snapshot()`) | `PresetView` without description and handles | < 19 KB |
| `SessionConfig.preset` | the snapshot without `instructions` (they are already in the composed prompt): `catalog.configSnapshot(snapshot)` | worst case 3 x (120 + 32 x 80 + 16 x 144) ~ 15 KB, typically < 1 KB; the factory checks that `make`'s argument fits `frameBytes` and otherwise fails the creation with factory `texts.presetTooLarge` before any row (R4-6) |
| `InventoryPage` | 50 rows of 80-unit labels and two handles | ~ 15 KB |
| `enqueueMessageOnce` | a `Submission` (inline <= `inlineBytes` or staged) + 32 attachments | ~ 8.4 KB + 32 x 0.3 KB < 19 KB |
| `ExecRequest` (M5) | M1b's + one handle | unchanged |
| `InspectRequest` | a handle, `args` inline <= `inlineBytes` or staged | < 9 KB |
| `InspectOutcome` | `ToolOutcome` (inline <= `inlineBytes` or staged), 128 method names of <= 128 units, or one `ToolDescription` of a granted tool (description 1,024, parameters 2,048 units) | < 17 KB, built by the exec program, never by the target |
| `RoundRequest` with granted tools | M2's + at most `roundGrantedToolBytes` (12,288) of granted descriptions | the round request builder's existing `fitsFrame` check falls back to no `append`; granted tools past the budget are not offered that round |
| `ExecPowersSource.lookup` answer | a handle or `{ json }` <= `labelValueBytes` (8,192) | < 9 KB |

---

## 2. Objects and interfaces

Columns of the method tables (section 2.9) are M2 3's: caller; crank; mode; largest message;
retired break; heaviest crank in the vat that receives it; plus **persists** (vat heap, adapter
file, nothing).

### 2.1 Factory vat: the preset catalogue and presets (W5.1)

**`PresetCatalog`** (`m5FactoryInterfaces.PresetCatalog`), one per factory, made in
`makeFactoryKit` by `makePresetCatalog({ templates, defaultsContext })` (`guest/factory/presets.js`).
Obtained only from `Operator.getPresets()`; `SessionFactory.listPresets()` returns `catalog.list()`.

- `list() -> [Preset]` in display order: `chat-only` first, then the other built-ins in
  `builtInPresetLabels` order, then user presets in creation order; at most `maxPresets` (64).
  `chat-only` leads because callers that take the first listed preset as M1a's (the M1a slice,
  `m1a-provision`) keep working; the PM kept this order at the cross-lane merge (XC). A caller
  that wants the default asks `defaultPreset()`.
- `configuration() -> { revision, presets, defaultPreset }` (A.4 `getPresetConfiguration`): the
  catalogue revision (a count, F.2 e; Fae used a random UUID string, J-0716) and the current
  default (R3-20).
- `create(record, expectedRevision) -> { preset, revision }` ("Save as new"). Refused with
  `texts.presetStale` when `expectedRevision` is not the current revision, `texts.tooManyPresets`
  at 64.
- `defaultPreset() -> Preset` (R3-20): `general` when the template table says `general` is
  available with public internet (`preset-templates.js`, M6/M7 make it so), otherwise `chat-only`.

**`Preset`** (`m5FactoryInterfaces.Preset`), one exo per preset for the preset's life (built-in
or user). The catalogue keeps `records: WeakMap<Preset, PresetState>` (rights amplification: the
factory's resolvers read a preset's record without a call, and refuse an object the catalogue did
not make with `texts.unknownPreset`).

- `describe() -> PresetView`: the saved record plus `builtIn`, `revision` (the preset's own
  revision, raised by every save or reset), `available` and `unavailableReason`
  (`textOf.presetNeeds(kind)` while a template object kind has no provider).
- `snapshot() -> PresetSnapshot` (data only; the widened `shapes.PresetSnapshot`, section 9.1):
  `{ label, template, instructions?, networkPolicy, modelId?, reasoningEffort?, objects,
  endowmentLabels, revision }`. No object references: endowment objects reach the session through
  `SessionServices.endowments` (2.3).
- `save(record, expectedRevision) -> revision` (A.4 `savePreset`), `delete(expectedRevision) ->
  revision`, `reset(expectedRevision) -> revision` (built-ins only: restores `BUILTIN_PRESETS`'
  record). A deleted preset's methods throw `texts.presetDeleted`; `createSession` with it is
  refused with the same text.

Validation (`guest/lib/preset-catalog.js`, pure, ported from Fae `session/preset-catalog.js`
`normalizePreset` with the texts of `interfaces-m5-factory.js`; section 12): label 1-120 non-blank;
template in `presetTemplateNames`; template objects must be among the template's own and, for
`development`, all of them; "An isolated shell requires a workspace"; endowment labels: Fae's
`name()` rule (1-80, no `@`, `/`, control characters, `.` or `..`, not in `reservedLabels`), no
duplicate among endowments and template object labels; endowment values are remotables (the
guard) ; `chat-only` takes no endowment and network `off`; model defaults: a `modelId` or effort
needs a `backend` ("Choose a backend for model defaults"), an API backend needs a `modelId`
("Choose a model for this backend"); a built-in's template cannot change; last, the whole record
must satisfy `fitsFrame(record, limitsM5.presetRecordBytes)` (`texts.presetTooLarge`; section
1.3). `normalizePresetRecord` makes that check, so `create` and `save` refuse before any state
changes. Fae's `sourcePath`
(the inventory path an endowment came from) is dropped: the value is the object (D-M5-1).

What persists: every preset record, the revision counters and the default rule's inputs, in the
factory vat heap (D-3). A preset record holds its endowment objects and its backend object; the
factory therefore keeps those alive while the preset exists (bounded: 64 presets x 32).

### 2.2 Factory vat: the operator inventory and the M5 Operator (W5.1)

**`Inventory`** (`m5FactoryInterfaces.Inventory`), one per factory
(`guest/factory/inventory.js`), obtained from `Operator.getInventory()`. Never given to a session
(section 6). It keeps `entries: Map<InventoryEntry, { label, value }>` in insertion order and a
`byLabel: Map<string, InventoryEntry>` for uniqueness (labels are human text, F.2 a).

- `list(cursor?) -> { rows: [{ entry, label, value }], rev, next? }`: pages of 50; the cursor is
  `i<n>` (the position, F.2 d); `rev` rises with every change (M12's Home feed reads it).
- `add(label, value) -> InventoryEntry`: refused with `textOf.inventoryLabelTaken(label)` for a
  label in use, `texts.inventoryFull` at `maxInventoryEntries` (1,024). Labels follow the
  endowment rule (they become edge names of mentions).
- `addAll([{ label, value }]) -> [InventoryEntry]`: up to 50 at once, all or nothing
  (provisioning, test and perf fixtures).
- `rev() -> count`.

**`InventoryEntry`**: `describe() -> { label }`, `value() -> object`, `relabel(label)`,
`remove()` (afterwards every method throws `texts.entryRemoved`). Removing an entry does not
revoke the object anywhere it was given (R3-274).

**`Operator`** (M5): `extendInterface(m2Interfaces.Operator, 'Operator', { getPresets,
getInventory })` (`m5FactoryInterfaces.Operator`); both answer the factory's one catalogue and
inventory. M4 adds no `Operator` method (its accounts hang off `SecretsAdmin` and the pool
backends), so seam H-2 has no M4 half.

### 2.3 Creation: how a preset becomes a session (W5.1, W5.2)

In `factory.js` `create(given)`, in this order (contract 9 and M2 7.2 hold for everything else):

1. `given = catalog.withDefaults(given)` (synchronous, rights amplification): the preset is
   `given.preset ?? catalog.defaultPreset()`; a foreign object, a deleted preset or an unavailable
   template is refused here, before any row or vat (R4-6). Missing `backend`, `modelId` and
   `reasoningEffort` are filled from the preset's record (R6-55 model defaults); an option the
   caller gave wins. A preset effort is refused by M1a's `refuse` resolver
   (`textOf.optionNotSupported('reasoningEffort')`) until M4 lifts it (section 4.2).
2. The M2 resolvers run unchanged: `basics` (with `context.defaultPreset = catalog.defaultPreset()`),
   `describeObjects` (`E(preset).snapshot()` now answers the widened snapshot), `catalogueModel`,
   `promptResolver` (W5.2 composes from `resolved.presetSnapshot`, 2.3.1), `turnDeadline`.
3. `buildSessionServices({ ..., presetSnapshot: resolved.presetSnapshot })` (one added field in
   the factory's call, seam H-3): W5.1's builder `presetEndowments` (appended to
   `serviceBuilders`) answers `{ endowments: [{ label, value }] }` from the preset's record **at
   the snapshot's revision**: if the preset was saved since `describeObjects` read the snapshot,
   the creation fails with `texts.presetChanged` and is rolled back as any failed creation (M2 7.2).
   `chat-only` gives no `endowments` field. The template's objects (M6) come from the same table's
   providers and are added by M6's builders.
4. `SessionConfig.preset` is `catalog.configSnapshot(resolved.presetSnapshot)` (the data
   snapshot without `instructions`, seam H-3); `SessionServices.endowments` the objects. Before
   `make` the factory checks the `make` argument against `frameBytes` (estimate) and fails the
   creation with factory `texts.presetTooLarge` otherwise. The session seeds its label map from
   the endowments in `make` (2.4.1).

#### 2.3.1 Prompt composition (W5.2; R4-26..R4-28, R5-52)

`composeSystemPrompt(context)` (`guest/lib/system-prompt-base.js`, W5.2) joins with a blank line,
in part order, the text of every entry of the section table `promptSections`
(`guest/lib/prompt-sections.js`, new hook table, section 11) whose `applies(context)` is true;
`context = { spoken, snapshot, userInitiated }`. M5's entries:

| part | entry | text |
|---|---|---|
| 1 | `introduction` | Floot's plain introduction, or the spoken one when `spoken: true` (R5-52), word for word (M2 W2.6 ported them) |
| 2 | `guestSection` | Fae's guest section, with the `exec` paragraph for the persistent scope (M2) and the capability paragraph rewritten for M5's `powers` (`E(powers).lookup(label)`, `list()`, `store(label, value)`, `remove(label)`; the facet is per call), and the object tools named as M5 offers them; deviations journaled |
| 3 | `environment` | empty (R4-26: empty on every live session) |
| 7 | `instructions` | the snapshot's `instructions`, when non-empty |

Parts 4, 5 and 6 are appended to the table by M9 (delegation), M12 (widget protocol) and M6
(object kinds). The rest of M2 10 holds: a `systemPrompt` option replaces the composition (R4-27);
blank fails; a prompt over `inlineBytes` is staged by the factory; it is stored in
`SessionConfig.systemPrompt` and never recomposed (R4-28). `guest/session/prompt.js` moves from M2
to M5 (milestones "Ownership transfers"); it runs in the factory bundle.

### 2.4 Session vat: the label map, object tools and `ExecPowersSource`

#### 2.4.1 The label map (W5.3)

`makeLabels({ seeds })` (`guest/session/labels.js`) returns an internal object (not an exo):

- `get(label) -> Binding | undefined`, `list() -> [label]` (sorted), `size()`,
- `bindObject(label, value, source)` with `source` `'preset' | 'endowment' | 'adopted' |
  'stored'`, `bindJson(label, text)`, `remove(label) -> boolean`,
- `methodsOf(binding)` / `setMethods(binding, names)` (the cached `__getMethodNames__` answer).

`Binding = { kind: 'object', value, source, methods? } | { kind: 'json', text, bytes }`. Refusals:
`textOf.reservedLabel` for `reservedLabels` and invalid labels (endowment rule), `textOf.labelTaken`
for a held label (no silent overwrite: `remove` first), `textOf.labelsFull(256)`,
`textOf.valueTooLarge(bytes, 8192)`, `textOf.storedValuesFull(262144)`.

Seeds, in `make`, in order: `services.endowments` (source `endowment`), then each entry of
`labelSeeds` (`guest/session/label-seeds.js`, new hook table: `{ label, from(services, config) ->
object | undefined }`; empty in M5; M6 appends `workspace`, `shell`). A seed whose label is taken
fails `make` (the catalogue's validation makes that unreachable).

What persists: the map, in the session vat heap. It is not a record, not in the transcript, not
exported (open decision O-8). Each object binding is one entry of the session's hub row (fact 9:
256 at most).

#### 2.4.2 Reading built-in tool arguments: `parseClosedArgs` (W5.3)

`parseClosedArgs(argsText, spec) -> { ok: true, values: Map<string, value> } | { ok: false, text }`
(`guest/lib/tool-args.js`, pure, vat and Node). A single scan of the model's JSON text: the top
level must be an object; every key at every depth is compared, as a string, against the spec
before anything is built; an unknown key answers `textOf.unexpectedArgument(key, tool, names)`
(M1a's R3-26 text); a missing required key, a wrong primitive type or bad JSON answers M1a's
`textOf.argumentsNotJson` or the R3-26 text. Value kinds: `'string'`, `'integer'`, `'raw'` (the
exact source span, kept as text: `store`'s `value`, `readSources`' `items`) and nested specs.
String literals are decoded by hand (no `JSON.parse` in session code). Arguments over
`inlineBytes` (staged) are refused for M5's session-local tools with
`textOf.argumentsTooLarge` (they are small by nature; `store` is bounded at 8,192 bytes anyway).

#### 2.4.3 The object tools (W5.3 local, W5.5 inspecting)

Tool-table entries (`guest/session/tools/objects.js`, appended to `toolTable` after `exec`);
descriptions and parameter schemas ported word for word from Fae `src/tool-makers.js` (`list`,
`lookup`, `store`, `remove`) and `src/source-tools.js` (`describeCapability`, `readSources`), the
"Endo directory" wording adapted (journal). Each entry has `site`:

| tool | site | does | result |
|---|---|---|---|
| `list` | `'session'` (new: no call leaves the vat) | `labels.list()` | JSON array of labels |
| `lookup({ petName })` | `'guest'` (a JSON binding or cached methods answer in the issuing crank; an object binding without cached methods costs one inspector `methods` call, W5.5) | renders without calling a method of the object | the stored JSON text; `[remote capability] callable methods: [...]`; `textOf.unknownLabel` (failed) |
| `store({ value, petName })` | `'session'` | `labels.bindJson(petName, rawValueText)` | `textOf.stored(petName)` |
| `remove({ petName })` | `'session'` | `labels.remove` | `textOf.removed(petName)`; unknown -> `textOf.unknownLabel` (failed) |
| `describeCapability({ petName, method? })` | `'guest'` | inspector `describe` (W5.4 renders Fae's JSON `{ methods, documentation, documentationScope, example, truncated }`, <= 48,000 units, then the tool limit) | rendered JSON |
| `readSources({ petName, items })` | `'guest'` | inspector `readSources` with the raw `items` text; the exec program validates Fae's item rules and calls `SourceReader.read(item)` per item | Fae's `{ results: [...] }` JSON |

A `'session'` entry's `execute` settles in the crank that issues it (the round-final crank): its
result record is appended in that crank (0 extra deliveries; section 5 kill point K3). `site:
'session'` is new in M5: turn.js treats it as `'guest'` for retired breaks (it cannot meet one).

`describeCapability` and `readSources` are offered only when `services.execVat` exists (they need
the inspector); `list`, `lookup`, `store`, `remove` always.

#### 2.4.4 `ExecPowersSource` (W5.5)

`m5Interfaces.ExecPowersSource`, one exo per session, minted in `make` by the `powers` part
(`guest/session/powers-source.js`, registered in `m5-parts.js`) over the label map. It is sent to
the exec vat in every `ExecRequest.powers` (W5.4's edit of `tools/exec.js`) and held there only
by the exec program's closure (never by the model's scope).

- `lookup(label) -> undefined | object | { json }` (an object binding answers the object itself;
  the exec wrapper puts it behind the membrane).
- `list() -> [label]`.
- `store(label, value)`: `value` an object (bound with source `stored`) or `{ json }` (the exec
  wrapper renders a non-remotable value as JSON text, big integers as decimals, R3-23, and checks
  `labelValueBytes` before sending). Same refusals as 2.4.1 (they reject the call; the wrapper
  turns them into thrown errors in model code).
- `remove(label) -> boolean`.

All four are answered from the session vat's heap in one crank each; nothing else.

### 2.5 Session vat: granted tools (W5.6; R3-6, P-65)

**`SessionGrants`** (`m5Interfaces.SessionGrants`), one per session, obtained from the M5
`Session.grants()` (so whoever holds the Session: the operator through the gateway; never model
code, open decision O-12). **`ToolGrant`**, one per grant.

- `grantTool(tool) -> ToolGrant`: kept with state `pending` and source `operator`; refused with
  `texts.grantsFull` at 32. In the same crank the session issues an inspector `toolSchema` call
  (D-M5-2): the exec program calls `E(tool).schema()`, checks Fae's `ToolSchema` (`{ type:
  'function', function: { name, description, parameters } }`), the name (1-128 of
  `[A-Za-z0-9_-]`, R3-27), the parameters (an object schema, depth <= 32, <= 10,000 nodes, JSON
  text <= `grantedParametersUnits`), cuts the description to `grantedDescriptionUnits` with the
  R4-46 marker, and answers a `ToolDescription`. The grant becomes `offered`, or
  `refused-schema` with the reason (`textOf.toolSchemaInvalid`).
- `list() -> [ToolGrantInfo]`; `ToolGrant.describe() -> ToolGrantInfo` (`{ grant, state, source,
  name?, reason?, label? }`: `name` is the model-facing name from the schema, `label` the display
  label an `adoptTool` grant was given, 2.6; an operator grant has none); `ToolGrant.withdraw()`:
  state `withdrawn`, the grant is dropped from the set (the handle keeps answering `withdrawn`);
  takes effect at the next round.

**Discovery at every round** (R3-6: "re-read at the start of every model round"): `toolSetFor`
(W5.3 makes it run per round, seam S1 of 2.8) asks the dynamic sources of `toolSources` (W5.6
appends `grantedToolSource`) after the static table. The **built-in name set** of a round is the
name of every static table entry (available or not, as Fae) plus the name of every adapter tool
the round's ports offer (`active.ports.tools`, for example M4's `accountStatus` on pool and API
backends). A granted tool whose name is in that set is `refused-builtin`
(`textOf.toolNameBuiltIn`); because the adapter tools are read from that round's ports, a grant
can be `refused-builtin` on one backend's round and offered on another's. A name
claimed by two or more `offered` grants refuses all of them (`refused-duplicate`,
`textOf.toolNameDuplicate`); grants past `roundGrantedToolBytes` that round are
`refused-budget`, newest first. These states are recomputed each round, so withdrawing one of two
duplicates offers the other at the next round.

A granted tool's call: the dynamic entry has `site: 'guest'` and `execute` sends an inspector
`toolExecute` with the model's argument text (inline or staged; the exec program parses it and
calls `E(tool).execute(args)` through the membrane checks), rendering the answer as Fae (a string
as is, anything else as JSON), cut to the tool limit, staged over `inlineBytes`.

A pending grant whose `toolSchema` call was issued on ports of an earlier adapter incarnation
(`since` older than the held ports') is read again at the next round start (a schema read is a
query; a duplicate is harmless). What persists: the grant set, in the session heap (32 at most).

### 2.6 Session vat: packages and mentions (W5.7; R3-8, R3-9, R4-29, R4-38, R4-99)

**`Session.enqueueMessageOnce(submission, requestId, at, attachments)`** (A.4's name; M5
`Session` guard): as `enqueueOnce` (M2 5) plus attachments: at most 32
(`textOf.tooManyAttachments`), distinct labels (`textOf.duplicateAttachment`), the endowment
label rule, and message text of at most 64,000 units (`textOf.packageTooLong`; a staged
submission's `bytes` must be at most 3 x 64,000). The queue entry keeps the attachments; a
receipt's fingerprint covers the text and the labels (not the objects); `Composer.edit` keeps
them; `cancel` drops them. Called by the Composer only (as `enqueueOnce`).

**`Composer.submit(session, text, requestId, { attachments })`** (W5.7, `AH/composer.js`; M5
`Composer` guard): stages text over `inlineBytes` as today and calls `enqueueMessageOnce` when
`attachments` is non-empty, `enqueueOnce` otherwise. The browser obtains attachment values from
`Inventory.list` and passes them back as the presences it holds; in the browser only the mention
addon calls the four-argument form (W5.8, section 4.1 item 2), and a resend after a reconnect goes
through the same addon, so the receipt fingerprint (text and labels) of a resend matches the
first send or the addon refuses to resend.

**Packages** (`guest/session/packages.js`): a per-session table `Map<number, Package>`; `number`
is a per-session counter from 1 (shared with M9's inbox, which opens packages through the same
`open` function); `Package = { number, labels, values: Map<label, object>, turnId }`.

- At claim (seam S3: W5.3's `onClaim` hook list in the claim crank, W5.7's entry): an entry with
  attachments opens a package for the new turn, `TurnStarted.attachments` records the labels, and
  the turn's `systemNote` is `textOf.mentionLine(number, labels)` (R4-29, Fae's text).
- Every round request of that turn carries the note (seam S2): `system` is the stored prompt and
  the note joined with a blank line when the prompt is inline, and the two-part list `[prompt,
  note]` when the prompt is staged (the widened `RoundRequest.system`; the adapter's
  `systemTextOf` joins it). Later turns do not carry it.
- `adopt({ messageNumber, edgeName, petName })` (`'session'` site; Fae's schema): only a package
  open in the current turn (`textOf.noPackage`), an existing edge (`textOf.noEdge`); binds the
  object in the label map with source `adopted`; `textOf.adopted(...)`.
- `adoptTool({ messageNumber, edgeName, toolName })` (`'guest'` site): takes the object and grants
  it with source `adopted` through the `grants` part (W5.6), awaits its schema read, and answers
  `textOf.adoptedTool(toolName, number)` when it is offered, else a failed result with the
  refusal. `toolName` is the grant's display label, kept as `ToolGrantInfo.label` (the grants
  part's `grant(tool, 'adopted', toolName)`, XC); the model-facing name is the schema's (R3-6).
- In the settle crank (`onSettle`, which recovery's settle also runs) every package of the turn
  is closed: its objects are dropped (released; R3-8). Nothing else holds them.

What persists: queue entries' attachments and open packages, in the session heap; the labels in
the `TurnStarted` record (transcript and archive; the objects are never recorded).

### 2.7 Exec vat: the per-call `powers`, the membrane and the inspector (W5.4)

`exec/main.js` switches `ExecScope` to `m5Interfaces.ExecScope` (`run` takes the M5
`ExecRequest`; `inspect` is new).

- **`powers`** (`guest/exec/powers.js`): `makeCall` builds, per call, a hardened plain object
  `{ lookup, list, store, remove }` that checks its arguments (label bounds, value size) and
  forwards through the call's `E` to `request.powers`; once the call is closed every method
  answers a promise rejected with `texts.powersExpired` (no send). `lookup`'s object answers are
  wrapped by the membrane; `{ json }` answers are parsed in the exec vat (it parses model data on
  purpose; a key flood answers `exhausted` as M1b). Model code uses `E(powers).lookup('x')` or
  `await powers.lookup('x')`. Without `request.powers` (an M1b session) `powers` stays `{}`.
- **Membrane** (`guest/exec/membrane.js`): D-M5-3. Built on the call's `E`, so it dies with the
  call; one `WeakMap` wrapper -> target per call. A tagged value (CopySet, CopyBag, ...) keeps its
  tag both ways: in a measured message its payload is measured and swapped, in an answer its
  payload is wrapped (XC; before, the copy was a plain `{ payload }` record).
  **What may leave the vat** (XC, rule 12.13): a message to a wrapper (another vat's object) may
  carry data and this call's wrappers only. A wrapper of an ended call in it is refused with
  `texts.powersExpired`, any other remotable with `MODEL_OBJECT_TEXT` ("Only objects obtained
  through powers in this call can be sent to another vat"), before anything is sent. Model code
  has no `Far`, but it can build a remotable by hand (`Symbol.for('passStyle')` is a shared
  intrinsic); such a model-made object therefore never reaches another vat through the
  membrane, so no other vat calls it or hands it raw presences as arguments, and no model code
  runs on another vat's call after its exec call ended. A message to a non-wrapper remotable
  (the model's own object) stays in the vat; it is measured, not refused.
  **Residual** (recorded for the PM; `m5-w54-exec` pins it): `powers.store(label, value)`
  (`powers.js`) passes any remotable to the session. A model-made object stored that way comes
  back from `lookup` in a later call as a wrapper of itself, and can then be sent to another vat
  through that wrapper; that vat can call it after the calls ended, with raw presences as
  arguments (which model code then holds unwrapped, though its sends still go through the
  membrane `E` of an ended call and so nowhere), and the exec vat's inspector (`methods`,
  `describe`, `readSources`) calls it outside any call. No authority is gained (the object holds
  only what the model held), but model code outlives its call. The fix is one check in `store`:
  refuse a remotable that is not this call's wrapper.
- **`inspect(request) -> InspectOutcome`** (`guest/exec/inspect.js`): runs beside `run` (not
  subject to `busy`), at most `inspectWindow` (16) at once (the session's client keeps the
  window); never evaluates model code. Operations: `methods` (`__getMethodNames__`, at most 128
  names of at most 128 units, rendered as `exec/render.js` does), `describe`, `readSources`,
  `toolSchema`, `toolExecute` (2.4.3, 2.5). Every answer is built by the exec program from the
  target's answer: rendered, cut, staged through `request.writers`. A key flood answers
  `{ status: 'exhausted' }` (retire, as `run`).

**Session-side client** (`guest/session/tools/inspect-client.js`, W5.4): `inspectFor(context)
-> (request) -> Promise<outcome>` (section 10; `context` is the tool's `ToolContext`) shares
`tools/exec.js`' per-session state (the current scope from `ExecHandle`, taken on first use),
which W5.4 exports from `tools/exec.js` for this purpose. (The exec-side `makeInspector` of
`guest/exec/inspect.js` is a different function in the exec bundle.) Endings: the
answer; a retired break (exec vat lost) -> retire the scope and answer
`failed(texts.inspectTerminated)`; `exhausted` -> retire, `failed(texts.execExhausted)`; turn
cancel or recovery -> settled `execAbandoned` / tool outcome unknown by generation, the late
answer ignored (the call in the exec vat is not interrupted). It arms no adapter deadline for
`methods`, `describe`, `toolSchema`; `readSources` and `toolExecute` arm the exec deadline as
`run` does (a hanging target is bounded by `execDeadlineMs`; on the deadline the exec vat is
retired, the only way to stop it).

### 2.8 Session seams in `turn.js` and the adapter (W5.3)

Built by W5.3 so that no other M5 unit edits `turn.js`:

- **S1 tools per round.** In `invoke`, before `roundRequest`, `active.tools = toolSetFor(
  active.ports, table, services, sources)`; `toolSetFor` (tool-table.js) adds the dynamic entries
  of `toolSources` (new hook list: `(ports, services, runtime) -> entries[]`) after the static
  table, with the name rules of 2.5. Cost: one pass over at most 128 descriptions per round.
  Between the static table and the dynamic sources come the **adapter tools without a static
  entry** (D-M4-9 as amended at the cross-lane merge, XC; m4-interfaces.md 6): each port tool
  whose `AdapterToolEntry` carries a `description` naming it, and whose name no static entry has,
  is offered through one generic entry (`adapterToolEntries`: `site: 'adapter'`, `describe()`
  answers that description, `execute` sends `{ opId, args }` to that port's tool object; one
  entry per port record, reused while the ports are). A port tool without a description is not
  offered (`echo` has its static entry). Their names are in the round's built-in set (2.5), so a
  granted tool never shadows one, and a static entry is never shadowed by one (M4's
  `accountStatus` is the first).
- **S2 per-turn system note.** `roundRequest` uses `systemFor(active)`: the stored prompt alone,
  or joined with `active.systemNote` (inline: text joined in the vat; staged: the two-part list).
  `AH/providers/round.js` `systemTextOf` accepts the list and joins its parts (each read as
  today) with a blank line; `AH/providers/scripted.js` reads `req.system` through `systemTextOf`
  (its `context` line then records the joined prompt's digest, which acceptance 7 reads).
- **S3 claim hooks.** `turnHooks.onClaim` (new list): `({ core, active, item }) => void`, called
  in the claim crank after `TurnStarted` is appended (W5.7 needs the turn id), before the first
  round request is built; `item` is the queue entry (`undefined` for a `turnSources` turn).
  `TurnStarted` is appended with `attachments` when the entry has some.
- **S4 tool context.** `issue`'s `ToolContext` gains `runtime` (the session's `m5-parts`
  runtime: `{ labels, packages?, grants?, powers?, inspector? }`), so tool entries reach session
  parts without imports.
- **S5 `site: 'session'`**: as `'guest'` for retired breaks.

`session.js` (W5.3): builds the label map and the runtime from `m5Parts` in `make`, switches
`Session` to `m5Interfaces.Session`; `grants()` and `enqueueMessageOnce` forward to the runtime's
`grants` and `packages` parts (stubs `textOf.notBuilt` until W5.6 and W5.7 register them).

### 2.9 Method table

| method | holder (vat) | caller | crank | mode | max | retired break | heaviest crank | persists |
|---|---|---|---|---|---|---|---|---|
| `Operator.getPresets` / `getInventory` | factory | gateway, CLI, tests | any | answered | tiny | factory lost | none | - |
| `PresetCatalog.list` / `configuration` / `defaultPreset` | factory | gateway, tests | any | answered | 64 handles, ~3 KB | factory lost | none | - |
| `PresetCatalog.create`, `Preset.save` | factory | gateway | any | answered | <= frameBytes in | factory lost | validates one record (32 endowments, 16 objects) | factory heap |
| `Preset.delete` / `reset` | factory | gateway | any | answered | tiny | factory lost | one record | factory heap |
| `Preset.describe` / `snapshot` | factory | gateway, factory resolvers | any; creation | answered | <= frameBytes out | factory lost | none | - |
| `Inventory.list` | factory | gateway | any | answered | ~15 KB out | factory lost | 50 rows | - |
| `Inventory.add` / `addAll`, `InventoryEntry.relabel` / `remove` | factory | gateway, CLI, provisioning | any | answered | <= 50 rows in | factory lost | 50 entries | factory heap |
| `Session.enqueueMessageOnce` | session | Composer | A (may claim) | answered | ~19 KB in | session vat lost | crank A + one package (32 objects), the claim note | session heap |
| `Session.grants` | session | gateway | any | answered | tiny | session vat lost | none | - |
| `SessionGrants.grantTool` | session | gateway | any | answered | tiny | session vat lost | one grant + one inspector send | session heap |
| `SessionGrants.list`, `ToolGrant.describe` / `withdraw` | session | gateway | any | answered | 32 infos, ~6 KB | session vat lost | none / one change | session heap |
| `ExecPowersSource.lookup` / `list` / `store` / `remove` | session | exec program | any (during an exec call) | answered | ~9 KB | exec side: session vat lost (never a restart: guest) | one map operation | session heap |
| `ExecScope.inspect` | exec | session (inspector client) | D (issue) or any (grant) | answered | ~9 KB in, ~17 KB out | session: exec vat lost -> retire | the target's answer decoded (bounded only by the target: the reason it is here) | - |
| `ExecScope.run` (M5 request) | exec | session | as M1b | answered | as M1b | as M1b | as M1b | exec heap (scope) |
| `Composer.submit` (M5 options) | adapter | browser | (A), then crank A | answered | 200,000 units + 32 handles | session vat lost: reject | - | blob file when staged |
| object tools (`'session'` site) | session | turn engine | D (round final) | - | - | - | per call: one record, <= 2 events; a round of 64 `store` calls appends 64 results in crank D (bounded by `maxCallsPerRound`, as M1b's 256-call QC row) | session heap |
| `toolSetFor` per round (S1) | session | turn engine | each round's crank | - | - | - | <= 128 descriptions scanned, 32 grants | - |

Heaviest-crank check for W5.3 (rule 12.12): a 256-call round of `store` (the M1b QC shape) must
still pass at the 4,000,000-slot ceiling; W5.3 adds that case to `m1b-qc.test.js`'s pattern in
its own `m5-w53-qc.test.js`.

### 2.10 What crosses a frame, and where large data goes

No M5 path carries large data through a vat: stored values are at most 8,192 bytes (a bound, O-3);
preset instructions 4,096 units (O-4); inspector results are rendered and staged by the exec
program through `BlobWriters` in pieces of at most `blobPieceBytes`; staged tool arguments reach
the exec vat through `Content` pages (M1b), never the session. Nothing new is written to adapter
files except staged texts (blobs) the existing paths write.

---

## 3. What M5 takes from M2 (exact)

M5 builds on M2 as merged at `3588cab190` and these objects and methods (checked by W5.9 against
the merged M2):

| from M2 | used by | how |
|---|---|---|
| `m2Interfaces.Session`, `.Operator`, `.Composer`; `interfaces.ExecScope` (`payload.methodGuards`) | `interfaces-m5*.js` | `extendInterface` |
| `guest/factory/session-options.js` `optionResolvers` order and `resolveCreateOptions`; `describeObjects` calls `E(preset).snapshot()` and checks `shapes.PresetSnapshot`; `promptResolver` reads `resolved.presetSnapshot?.instructions` | W5.1, W5.2 | unchanged; the widened snapshot passes |
| `guest/factory/services.js` `serviceBuilders`, `buildSessionServices(context)`, `shapes.SessionServices` | W5.1 | one appended builder; the widened shape |
| `factory.js` `makeFactoryKit` (`chatOnly`, `presets`, `create`, `operator`, `listPresets`) | W5.1 | seams H-1..H-3 |
| `guest/session/turn.js` `invoke`, `roundRequest` (seam 1 `system: config.systemPrompt`), `claim`, `issue` (`ToolContext`), `settle` running `onSettle` (also from recovery) | W5.3 | S1-S5 |
| `guest/session/tool-table.js` `toolTable`, `toolSetFor(ports, table, services)`; `turn-hooks.js` lists | W5.3, W5.6, W5.7 | appended entries, new lists |
| `guest/session/tools/exec.js` per-handle state, `run`'s request, `retire` | W5.4 | edits (W5.4 owns the file in group A) |
| `guest/exec/main.js` `makeCall`, `makeExecScope`, `finish`; `exec/render.js` `renderToolResult` | W5.4 | edits |
| `guest/session/{queue,submissions}.js`, `guest/lib/pending-queue.js` (`makePendingQueue`, receipts' fingerprint), `Queue.items()` | W5.7 | entries gain `attachments` |
| `AH/composer.js` `Composer.submit`, `edit` | W5.7 | M5 guard, attachments |
| `AH/providers/round.js` `systemTextOf(system, blobs, owner)`; every provider calls it with `req.system`; `scripted.js` reads `req.system` itself | W5.3 | list join |
| `guest/lib/system-prompt-base.js` `composeSystemPrompt({ spoken, presetText? })` | W5.2 | re-built over the section table |
| `textOf.notBuilt`, `textOf.unexpectedArgument`, `textOf.argumentsNotJson`, `texts.execExhausted`, `texts.execAbandoned`, `texts.toolOutcomeUnknown`, `textOf.optionNotSupported` | all | reused |
| `scripts/export.mjs` file format (M2 7.3) | W5.1 | a `{ type: 'presets', records }` line after `factory` |
| `scripts/provision-steps.js` steps table | W5.5 | an M5 fixture step appended after M3's gateway step and M4's subscriptions step, which returns at once unless `options.m5Fixtures` is given (test templates only; provisioning runs at every start, P-28) |
| `test/template` `ensureTemplate`, `startFromTemplate`; `perf/_harness.mjs` `runPerf` | all integration | unchanged |

**Assumptions M2's document does not settle** (each checked by the unit named; a wrong one is
reported, not designed around):

1. An `M.interface` guard's `payload.methodGuards` is a spreadable copy record (true for the
   `@endo/patterns` in this tree, checked in W5.0; W5.3's contract test pins it; CC-072).
2. `settle` runs the `onSettle` hooks for every ending, recovery's included (true at `3588cab190`,
   `turn.js` and `recovery.js`; W5.7 tests it across a SIGKILL).
3. The archive (`AH/archive/segment.js` `encodeRecord`) and the projection carry an unknown
   optional field of a record (`TurnStarted.attachments`) without change (true for the encoder;
   W5.3 checks the projection ignores it and that a sealed turn's segment round-trips it).
4. No provider builds its system text other than through `systemTextOf` except `scripted.js`
   (true at `3588cab190`). M4's subscription `provider.js` resolves the system text exactly once
   per round with `systemTextOf(req.system, blobs, owner)` and hands `claudeBody`/`codexBody` a
   plain string (M4's contract, sections 5.2 and 12), so the two-part `system` needs no M4 edit.
5. A queue entry is a plain record the queue copies by field (`pending-queue.js`), so adding
   `attachments` needs edits only in `pending-queue.js`, `queue.js` and `submissions.js`.
6. The gateway (M3) passes browser-held presences of daemon objects back into daemon calls as the
   same objects (M2's `createSession({ preset })` and `deleteSession(session)` already need it).
7. M2's export leaves presets out (M2 7.3: "presets are M5") and M2's acceptance 14 is closed by
   M5's acceptance 14.
8. `recovery.js` abandons exec calls by generation through `execHooks.recoverySteps`; inspector
   calls share that state (W5.4 makes them part of it).

---

## 4. Seams with M3 and M4

### 4.1 With M3 (chat UI and gateway)

M3's design of its two extension seams stands (cross-check of the three contracts, W5.0-settle);
M5 adds files only and edits no M3 file.

**M5 needs from M3:**

1. **UI features as directory registries** (M3 6.2): `ui/build.mjs` collects every
   `ui/src/*/feature.js`; each exports `feature`, one `UiFeature` or an array of them (`{ id, slot,
   label?, order?, when?, component, send? }`, M3 `GW/contract-m3.js`). `ui/src/features.js` is
   M3's collector and M5 does not edit it. W5.8 adds two directories:
   - `ui/src/presets/feature.js`: one feature, id `presets`, slot `app.panel`, label "Presets",
     the preset editor;
   - `ui/src/mentions/feature.js`: an array of two features, `mentions.addon` (slot
     `composer.addon`) and `mentions.chips` (slot `message.renderer`).
2. **The composer addon** (M3 `ComposerAddonProps`, `ComposerSendRequest`, 9.2). The
   `mentions.addon` component receives `{ context, input: { text, caret }, replaceRange(start,
   end, text) }`. It opens the suggestion list when the text before the caret matches `@` plus up
   to 80 label characters, lists `Inventory` pages (`E(E(context.powers.operator).getInventory())
   .list(cursor)`), and on a choice calls `replaceRange` to put `@label` in the text and keeps a
   chip `{ label, value }` (the inventory row's presence). Chips live in the addon's memory keyed
   by the draft's `requestId`, never in browser storage (presences do not survive a reload).
   Its `send({ context, session, text, requestId, resend })`:
   - no chips for `requestId` and `resend` false: answers `undefined` (M3's plain
     `Composer.submit` runs);
   - chips present: answers `E(context.powers.composer).submit(session, text, requestId, {
     attachments })` with the chips as `[{ label, value }]` in insertion order (the M5 `Composer`
     guard's optional fourth argument), and drops the chips once that promise answers;
   - `resend` true and no chips for `requestId` while the draft text holds an `@label` the addon
     made for it (a record of chosen labels by `requestId` is kept for the draft's life, labels
     only): throws `Error(texts.attachmentsLost)` ('Attachments were lost when the page reloaded;
     attach them again'; `interfaces-m5.js`, copied into `ui/src/mentions/`); M3 keeps the draft and shows the text. With no such record
     it answers `undefined`.
   M3 calls `send` with `resend: true` only after `getSubmissionReceipt(requestId)` answered none,
   so a resend never duplicates a submission and a resend with the same chips carries the same
   fingerprint (text and labels, 2.6).
3. **Attachment chips in the transcript**: `mentions.chips` (slot `message.renderer`) receives
   `{ context, turn, record }`, where `record` is the turn's `TurnStarted` record with optional
   fields kept (M3 keeps unknown fields); it renders one "Attached object" chip per label of
   `record.attachments` and returns null when there are none.
4. **The new-session preset picker is M3's** (W3.5 `NewSession.js`): the dialog lists
   `SessionFactory.listPresets()`, calls `E(preset).describe()` for each and keeps `{ index,
   label, available, unavailableReason }`; a missing `available` (M2's chat-only) counts as
   available; unavailable rows are shown disabled with their reason; it passes the `Preset`
   object to `createSession({ preset })`. M5 builds nothing for it.
5. **Key-guard vocabulary** (M3 4.4, 6.3): the gateway admits record keys from every
   `guest/lib/interfaces-m*.js` (this includes `interfaces-m5-factory.js`), using its
   `vocabularyShapes()` export when present (logging and skipping the file otherwise), and walks
   the shapes and the method guards' argument patterns. Both M5 files export `vocabularyShapes()`
   (W5.0-settle): `interfaces-m5.js` over `m5Shapes`, `m5Widenings` and `m5Interfaces`;
   `interfaces-m5-factory.js` over `m5FactoryShapes` and `m5FactoryInterfaces`. The gateway is a
   pass-through bridge: method checking stays in each exo's own guard, so M5 asks for no
   "undeclared interface refused" rule.
6. **Presences round-trip** (assumption 6): attachment values, preset endowments and
   `createSession({ preset })` pass browser-held presences back.
7. **The frame guard** (M3 4.4 rule 3) covers `PresetCatalog.create`, `Preset.save` and
   `Composer.submit` with attachments like any call. The editor refuses a record over
   `presetRecordBytes` with `texts.presetTooLarge` before sending (section 1.3), so a save the
   editor sends is at least 2,048 bytes under `frameBytes`.
8. **Browser tests**: in `test/browser/`, M3 owns `_harness.mjs` and `m3-*.mjs`, M5 owns
   `m5-*.mjs` only. W5.8's files are written against M3's `startBrowserGateway({ template,
   provision? }) -> { page, url, client, close() }` (M3 section 17) and run, gated by
   `THIX_HARNESS_BROWSER=1`, after M3 is merged; W5.8's component tests use M3's
   `test/unit/_m3-fake-powers.js` and run once M3's group A (W3.4) is in the shared branch. No
   other M5 acceptance item waits on M3.

**M5 offers M3**: the catalogue, preset and inventory objects reachable from `Operator`;
`Preset.describe()` with `available` and `unavailableReason`; `TurnStarted.attachments` (labels)
in history pages. M3 needs nothing from M5 to build or pass its acceptance.

### 4.2 With M4 (secrets manager and subscription pools)

**M5 needs from M4**: M4's subscription `provider.js` resolves the system text once per round
through `systemTextOf` (assumption 4), so the R4-29 line reaches pool backends; M4 lifts
`reasoningEffort` from M1a's `NOT_YET` when it builds efforts (until then a preset with an effort
fails creation honestly, 2.3 step 1). M5 fills preset defaults into the create options before the
resolvers (`catalog.withDefaults`), so M4's `subscriptionEffort` reads `resolved.reasoningEffort`,
then `options.reasoningEffort`, and needs no M5 resolver (M4 9.3 item 1).

**M5 offers M4**: nothing it must build. Preset `backend` fields accept any `Backend` (M4's pool
backends included); `ReadGrant`s may be inventory objects and endowments (a model can
`describeCapability` one: label and description only, never a value). M4's acceptance 5
(reachability) gains M5's objects: neither vat reaches `PresetCatalog`, `Inventory`, `Operator`
or the factory (section 6; M5 acceptance 12). Adapter tools M4 offers through `TurnPorts.tools`
(`accountStatus`) are protected from granted names by 2.5's built-in name set.

**What M4 does not do**: M4 adds no `Operator` or `Session` method (so H-2 and H-4 have no M4
half), no `tool-table.js` entry (`accountStatus` is an adapter tool), no edit to `session.js`,
`turn.js`, `round.js`, `scripted.js` or `composer.js`. **Shared files** with M4: `factory.js` (M5
owns it; M4 adds one line after the `turnDeadlineMs` copy, its H-7), `interfaces.js` (M5 owns the
four widenings; M4 changes one line, `BackendKind`, its H-1), `session-options.js` (M4 owns it;
M5 makes no edit), `config/defaults.js` (M4 owns it; M5 makes no edit), `provision-steps.js`
(append-only, PM-merged). Seams in 9.1.

### 4.3 What M5 leaves for later milestones (seams they append to)

`preset-templates.js` object providers (M6), `label-seeds.js` (M6: `workspace`, `shell`),
`promptSections` parts 4-6 (M6, M9, M12), `packages.open` (M9 inbox), `toolSources` (M9: tools
adopted from mail go through `grants`), `SourceReader` (M6's `Dir` implements it).

---

## 5. Restart, crash and retry

Dormant after restart (D-5) holds: nothing M5 adds wakes a vat at startup or registers a start
notice. Every new durable thing lives in a vat heap and is replayed with it; the rule "intent
before effect" (architecture 4.3) covers each mutation because each one happens in one crank with
its record or answer.

| durable thing | where | after SIGKILL | kill points to test (file) |
|---|---|---|---|
| preset records, catalogue revision | factory heap | replay; a save whose answer was lost is applied once; a client retry with the old revision is refused stale and the client re-reads | K1: after the `save` crank before the answer; after the answer (`m5-presets`) |
| creation with a preset (snapshot, endowments) | factory heap, then the session | M2 7.2: completed if `make` answered, else rolled back; `presetChanged` creations rolled back | K2: between `describeObjects` and `make`; after `make` (`m5-presets`) |
| inventory entries | factory heap | replay | K1 variant: after `addAll` (`m5-presets`) |
| label map (`store`, `remove`, `adopt`, `powers.store`) | session heap | replay: the binding and its result record exactly once | K3: after the round-final crank of a `store` round; after an `adopt` (`m5-mentions-restart`) |
| grants | session heap | replay; a grant whose schema read was in flight is re-read at the next round (2.5) | K4: after `grantTool` before the schema answer (`m5-grants-restart`) |
| granted tool call | intent in the session (crank D), the call in the exec vat | the tool runs at most once (the hub drops the replayed crank's duplicate send); recovery records "Tool outcome unknown" unless the exec vat's answer was already journaled for the session (then the replay records it, K5 second point); a late answer (guest-to-guest promises survive restart, fact 5) is ignored by generation; never re-sent | K5: after crank D while the fixture tool runs (delay 2 s); after the tool answered the exec vat, before the exec vat's answer (`m5-grants-restart`; XC: the session vat's worker is woken and held with SIGSTOP, every incarnation as it appears, before the tool is released, and the daemon is SIGKILLed once the tool's log shows the run finished. Measured: the exec vat's answer is then already in the session's hub journal (its length grows by one while the worker is held), so the replay runs it: the true result is recorded once, recovery settles the turn outcome-unknown at the next round, the tool ran once, one provider request. "Tool outcome unknown" is recorded only when the answer never reached the hub, the first point) |
| queue entries' attachments, open packages | session heap | entries held `restart` keep their attachments and run later with their note; a claimed turn recovered `interrupted` or `outcome-unknown` closes its package in recovery's settle | K6: after an `enqueueMessageOnce` that claimed; with two entries waiting (`m5-mentions-restart`) |
| `ExecPowersSource`, the exec scope | session heap; exec heap | the exec call in flight is abandoned by recovery (M1b); `powers` facets of earlier calls stay dead | K7: during an exec call that awaits `powers.lookup` (`m5-objects`) |

No provider request is duplicated by M5: M5 adds no request, only the note on a turn's own rounds;
an outcome-unknown turn's next-turn context carries no note (it is not a record). A crash of the
exec vat during an inspector call is retried by the supervisor (D-17); the call stays pending,
bounded by the exec deadline where armed (2.7); a give-up breaks it with the retired text and the
session retires the scope.

---

## 6. Security

**Authority of each new object.**

| object | carries | held by | never held by |
|---|---|---|---|
| `PresetCatalog`, `Preset` | create and edit presets; every preset's endowment objects (through `describe`) | the operator (gateway, CLI) | sessions, exec vats, model code |
| `Inventory`, `InventoryEntry` | the operator's chosen objects | the operator | sessions, exec vats |
| endowment / adopted / stored objects | whatever each object's own methods grant | the session's label map; model code through the membrane | other sessions (unless passed by the operator or, in M9, by mail) |
| `SessionGrants`, `ToolGrant` | add tools to one session | whoever holds the `Session` (operator) | model code (no path from labels or `powers` to them; open decision O-12) |
| `ExecPowersSource` | read and edit one session's label map | the session; the exec program's closure | model code (it gets the per-call wrapper), any other vat |
| `ExecScope.inspect` | call a target the session names, from the exec vat | the session | model code |

**What a model can reach**: its label map's objects, only through tool arguments (labels) and the
per-call `powers` wrapper; through `exec`, those objects behind the membrane, plus objects their
methods return (also wrapped). It cannot reach the catalogue, the inventory, the Operator, the
factory, `SessionGrants`, `AgentHostAdmin`, `SecretsAdmin`, any secret value, another session's
facets (unless the operator endowed or mentioned one), the gateway, or the exec program's own
objects (`ExecPowersSource`, `BlobWriters` of other calls).

**What a browser page can reach**: what the Operator hands out (catalogue, presets, inventory,
sessions, grants through `Session.grants()`); the Composer's attachments are objects the page
already holds. **What an operator can do** beyond M2: everything above, plus putting any object
they hold into a session (endowment, mention, grant): that is the intended authority (R3-270).

**Untrusted answers** (D-M5-2, D-M5-3): no answer from an object the session did not mint enters
the session vat; no message from model code leaves the exec vat larger than the membrane allows.
What remains unprotected without CC-070 and CC-071: a membrane cannot stop key drip over many
calls (O-9); an object's answer can still halt the exec vat (then the scope is lost and said so).

**Secrets** stay out of vat heaps, transcripts, logs and journals: M5 handles no secret value.
`ReadGrant`s may be inventory objects, endowments and attachments; their only method
(`describe`) answers a label and description. Stored values are model text; preset records hold
objects and text the operator typed; the exec program renders answers but never logs them (no
console: R3-42's daemon log is discarded, M1b). Journal entries and test logs carry labels and
counts, never stored values or rendered results.

**Prompt injection stays text**: attachment labels and inventory labels reach the model only
inside the R4-29 line, quoted with `JSON.stringify` and introduced as "labels, not instructions".

---

## 7. Work units

Two parallel groups and one integration unit. Within a group no two units edit one file (hook
tables take appended lines from several units; the PM resolves trivial merges); a group B unit may
import group A modules by the entry points of section 10; no unit imports a module of a unit of
its own group. Contract changes follow M2 2.1's rule (`contract(thixotrope-harness): ...`, this
file updated in the same commit).

**Group A** (starts when M2's build is merged; all four in parallel):

| id | owns (files) | behaviour | tests | supervisor | hours (one Opus agent) | slower if |
|---|---|---|---|---|---|---|
| W5.1 presets and inventory | new: `guest/factory/{presets,inventory,preset-templates}.js`, `guest/lib/preset-catalog.js`; edits: `guest/factory/factory.js` (H-1..H-3), `guest/factory/services.js` (append), `scripts/export.mjs` (presets line); `test/unit/m5-w51-*.test.js`, `test/integration/m5-presets.test.js`, new `perf/presets.perf.mjs` (`presets.save`, `inventory.page`) | 2.1-2.3 (not the prompt), the whole-record bound `presetRecordBytes` (1.3), export/import of presets (acceptance 14) | unit: ported Fae `preset-catalog.test.js` cases, CAS, amplification, defaults; **guard-boundary test**: the maximal guard-accepted `PresetRecord` (every field at its bound, three-byte text, 32 endowments, 16 template objects) passes `m5FactoryShapes.PresetRecord` and is refused by `normalizePresetRecord` with `texts.presetTooLarge`; a record of exactly `presetRecordBytes` string bytes is accepted and its `PresetView` (with a 100-unit `unavailableReason`) fits `fitsFrame(view, frameBytes - 1024)`; integration: acceptance 2, 13, 14, K1, K2 | yes | 6 | creation rollback paths with a failing services builder |
| W5.2 prompt composition | `guest/session/prompt.js` (transferred from M2), `guest/lib/system-prompt-base.js`, new `guest/lib/prompt-sections.js`; `test/unit/m5-w52-*.test.js`, `test/integration/m5-prompt.test.js` | 2.3.1; the guest section rewritten for M5's `powers` and object tools | unit: ported Fae `system-prompts.test.js` parts, section order, spoken; integration: acceptance 9 without preset instructions | yes | 3 | the persistent-scope wording needs an exec-vat check (J-0472's "undeclared name reads as undefined"): done in W5.5 |
| W5.3 session seams, labels, local object tools | `guest/lib/interfaces.js` (the four `m5Widenings`, first commit, contract rule), new `guest/lib/tool-args.js`, new `guest/session/{labels,label-seeds,m5-parts}.js`, new `guest/session/tools/objects.js` (`list`, `lookup` of JSON, `store`, `remove`; `lookup` of objects forwards to the runtime's `inspector` part); edits: `guest/session/{turn,turn-hooks,tool-table,session}.js` (S1-S5, guard switch with stubs), `AH/providers/{round,scripted}.js` (S2); `test/unit/m5-interfaces.test.js`, `test/unit/m5-w53-*.test.js`, `test/integration/m5-labels.test.js`, new `perf/tools.perf.mjs` (`tools.local`, `labels.full`, probes d and e; W5.5 and W5.6 append one row each) | 2.4.1-2.4.3 (local), 2.8 | unit: contract test (every M5 guard accepts a sample and refuses an oversize string, array and an extra key at each place; method name lists; texts exact; both `vocabularyShapes()` build and include `attachments`, `endowments`, `PresetRecord`'s keys); `parseClosedArgs` with key floods and odd JSON; 256-call `store` round at the slot ceiling; M1a/M1b/M2 unit suites still pass; integration: acceptance 3 (local part) | yes | 7 | per-round tool set changes break M1a/M1b tests that count work per round; the session bundle budget (O-1) |
| W5.4 exec side | edits: `guest/exec/{main,render}.js`, `guest/session/tools/exec.js`; new `guest/exec/{powers,membrane,inspect}.js`, `guest/session/tools/inspect-client.js`, `test/fixtures/m5-objects.js` (fixture objects evaluated in the workspace vat: a `SourceReader`, granted tools good and hostile, a 200 KB `help`, a 20,000-key answer, a slow tool with a run log); `test/unit/m5-w54-*.test.js` | 2.7: per-call `powers`, the membrane, `inspect` (all five operations, Fae's `describeCapability` and `readSources` rules ported), the session-side client | unit (exec program in Node, fake source and targets): powers die with the call; membrane limits at each bound; inspect renders and bounds; exhausted; client endings | no | 7 | `E` through a membrane inside an SES compartment (`HandledPromise` is hidden from model code, J-9367); porting Fae's source-tools rules |

Perf rows probe (d) (33 attachments) and (e) (oversize granted schema) are written by W5.3 against
the guards and texts of this contract; (d)'s attachment part is refused by W5.3's `Session` guard,
(e) passes once W5.6 is merged and is run by W5.9.

**Group B** (starts when group A is merged; W5.8's component tests also need M3's group A (W3.4)
in the shared branch, and its browser acceptance needs M3 merged; section 4.1 item 8):

| id | owns (files) | behaviour | tests | supervisor | hours | slower if |
|---|---|---|---|---|---|---|
| W5.5 powers and inspection tools | new `guest/session/powers-source.js` (a `m5-parts.js` entry), new `guest/session/tools/inspection.js` (`describeCapability`, `readSources`, the `inspector` part for `lookup`); appends: `tool-table.js`, `m5-parts.js`, `scripts/provision-steps.js` (the M5 fixture step, a no-op unless `options.m5Fixtures` is given; test templates set it); `test/integration/m5-objects.test.js`, `test/integration/m5-security.test.js`, new `perf/exec-m5.perf.mjs` (`exec.powersLookup`, `exec.membrane`, `exec.scope1000`, probes a, b, c, f), the `tools.inspect` row appended to `perf/tools.perf.mjs` | 2.4.3 (inspecting), 2.4.4 | integration: acceptance 3 (remote rendering), 4, 5, 8, 10; K7; unit: the fixture step does nothing without `options.m5Fixtures` | yes | 5 | fixture objects in the workspace vat interact with template provisioning |
| W5.6 granted tools | new `guest/session/tools/granted.js` (`SessionGrants`, `ToolGrant`, `grantedToolSource`; the `grants` part); appends: `tool-table.js` (`toolSources`), `m5-parts.js`, the `grants.round` row of `perf/tools.perf.mjs`; `test/unit/m5-w56-*.test.js`, `test/integration/m5-grants.test.js`, `test/integration/m5-grants-restart.test.js` | 2.5, with the per-round built-in name set (static table plus `active.ports.tools`) | unit: discovery rules per round, including a grant named `accountStatus` on fake ports that offer an adapter tool of that name: `refused-builtin`, and offered on ports that do not; integration: acceptance 6, 11b (K4, K5) | yes | 5 | the schema checks (depth, nodes) cost in the exec vat |
| W5.7 packages and mentions | new `guest/session/packages.js`, new `guest/session/tools/mentions.js` (`adopt`, `adoptTool`; the `packages` part); edits: `guest/session/{queue,submissions}.js`, `guest/lib/pending-queue.js`, `AH/composer.js`; appends: `turn-hooks.js` (`onClaim`, `onSettle`, `recoverySteps`), `tool-table.js`, `m5-parts.js`; `test/unit/m5-w57-*.test.js`, `test/integration/m5-mentions.test.js`, `test/integration/m5-mentions-restart.test.js`, new `perf/mentions.perf.mjs` (`mentions.turnStart`) | 2.6 | integration: acceptance 7, 11a (K3, K6) | yes | 6 | M2's receipt fingerprint and duplicate rules with attachments |
| W5.8 preset and mention UI | new directories `ui/src/presets/` (`feature.js`: the editor, slot `app.panel`) and `ui/src/mentions/` (`feature.js` exporting `[mentions.addon (composer.addon), mentions.chips (message.renderer)]`, `texts.js`); `test/unit/m5-w58-*.test.js` (happy-dom, M3's `_m3-fake-powers.js`); `test/browser/m5-*.mjs` (M3's `startBrowserGateway`). No edit to any M3 file | the preset editor (R6-55: name, description, template, backend and model, effort, internet, instructions, endowments from the inventory; Save, Save as new, Delete, Reset, Discard; stale refused; a record over `presetRecordBytes` refused before sending with `texts.presetTooLarge`, by the rule of `fitsFrame`: units x 3 first, exact UTF-8 bytes when over); the mention addon and attachment chips exactly as section 4.1 items 2-3 | unit: editor fields and refusals, size refusal at the bound (its estimate agrees with `fitsFrame` on samples), `@` suggestions and `replaceRange`, `send` with and without chips, a resend after a simulated reload throws `texts.attachmentsLost` (copy equal to `interfaces-m5.js`'s), chips renderer with and without `attachments`; browser: acceptance 15 | yes (gateway) | 6 | M3's shell or harness lands late in the shared branch |

**Integration**:

| id | owns | behaviour | tests | supervisor | hours | slower if |
|---|---|---|---|---|---|---|
| W5.9 integration | every file after group B; new `perf/creation-m5.perf.mjs` (`prompt.compose`, `session.createCold`, bundle bytes); `test/integration/m5-snapshot.test.js`, `test/integration/m5-reachability.test.js` | the runtime wiring that waits (section 10), no `notBuilt` stub left, the bundle budget (O-1: measure the merged bundles; the PM raises `sessionProgramBytes` to 240,000 and `execProgramBytes` to 120,000 in the M5 merge commit, with the `session.createCold` row), the merge seams with M3 and M4 as landed (M4's `NOT_YET` lift for preset efforts; M4's `systemTextOf` use for the R4-29 line on pools), the journal | acceptance 1, 9 (instructions part), 12; every perf row of section 8.2; the regression wall time | yes | 6 | the merge with M3 and M4 changes a seam; a perf miss needing a design change |

Ordering inside group A: W5.3's first commit is the four widenings (contract rule) so that W5.1
(`PresetSnapshot`, `SessionServices`) and W5.7 later can send the widened values; W5.1 builds and
tests against `m5Widenings` meanwhile. That first commit touches `interfaces.js` only and may be
merged into the shared branch ahead of the rest of M5 as a contract follow-up (with M4's one-line
`BackendKind` change), so M3 and M4 build against the widened shapes.

`perf/tools.perf.mjs` is laid out as a hook table: W5.3 writes the runner and a `rows` array
(`[{ name, setup(template), measure(window) }]`) with its rows; W5.5 (`tools.inspect`) and W5.6
(`grants.round`) each append one entry, which is the only kind of edit two group B units make to
one file (trivial merge, as `tool-table.js`).

**Wiring that waits** (as M2 2.3): W5.4's `inspect-client.js` is wired into `objects.js`'s
`lookup` by W5.5 through the `inspector` part (group B); the `grants` part used by `adoptTool` is
found at run time (W5.7 does not import W5.6); everything else by W5.9.

---

## 8. Acceptance and performance

### 8.1 Acceptance tests (each one integration test of at most 5 minutes)

1. **Snapshot isolation** (R3-7, R4-4, R4-28; W5.9 `m5-snapshot`): create a session from a user
   preset with instructions X and endowment `notes`; save the preset with instructions Y and no
   endowment; the session's next request carries the same prompt digest as before and `list`
   still shows `notes`; a new session gets Y (part 7) and no `notes`.
2. **Catalogue edits and revisions** (P-49 server side, R6-55; W5.1 `m5-presets`): two control
   clients; A saves at revision r (answer r + 1); B's save at r is refused with
   `texts.presetStale`; B re-reads and sees A's record; deleting a built-in is refused
   (`texts.builtInNotDeletable`); `reset` restores it; a record of three-byte text over
   `presetRecordBytes` is refused with `texts.presetTooLarge` and changes nothing; K1 holds.
3. **Object tools** (P-17, R3-31; W5.3 `m5-labels`, W5.5 `m5-objects`): `list` shows held labels;
   `lookup` renders a stored value and an endowed object as `[remote capability] callable
   methods: [...]` without calling its methods (the fixture's call log is empty); `store` then a
   SIGKILL restart then `lookup` finds the value; `remove` discards it; an unheld label answers
   `textOf.unknownLabel`; a 257th label and an 8,193-byte value are refused; an argument with an
   unknown key answers the R3-26 text.
4. **exec `powers`** (P-16, D-11, rule 12.13; W5.5 `m5-objects`): in one turn, `store` by tool
   then `exec` `await E(powers).lookup('x')` sees it; `remove` by tool then exec sees it gone in
   the same turn; `powers` kept on `globalThis` in one call rejects with `texts.powersExpired` in
   the next; `globalThis.y` survives the turn and a SIGKILL restart; an undeclared name reads as
   `undefined` (J-0472).
5. **`describeCapability` and `readSources`** (R3-32; W5.5 `m5-objects`): bounded help of a
   fixture (<= 48,000 units, then the tool limit); `readSources` of a fixture `SourceReader` with
   a search; a fixture whose `help()` answers 200 KB gives `texts.inspectTerminated` and the
   session's next turn runs normally.
6. **Granted tools** (P-65, R3-6; W5.6 `m5-grants`): a granted `echo2` is offered at the next
   round and its call returns its result; a grant named `exec` is `refused-builtin` and not
   offered; two grants named `t` are both `refused-duplicate`; withdrawing one offers the other at
   the next round; a withdrawn tool is gone from the next request.
7. **Mentions** (P-40, R3-8, R4-29, R4-99; W5.7 `m5-mentions`): a submission with two attachments
   through the Composer: that turn's requests carry the R4-29 line (scripted `context` line), the
   next turn's do not; the model `adopt`s one and `list` shows it next turn; `adopt` of the other
   after the turn answers `textOf.noPackage`; 33 attachments are refused; `adoptTool` of a fixture
   tool makes it offered next round.
8. **Endowments** (P-53, R3-17, R3-22, R3-270; W5.5 `m5-objects`): a user preset with inventory
   endowments `notes` and `calc`: its session lists both; labels `user` and `a/b` are refused; 33
   are refused; a duplicate is refused; a `chat-only` preset with an endowment is refused with
   Fae's text.
9. **Prompt composition** (P-15, R4-26, R4-27, R5-52; W5.2 `m5-prompt`, W5.9 the part-7 check in
   acceptance 1): a typed session gets the plain introduction, a spoken one the spoken
   introduction; the guest section describes the persistent scope and `powers`; a `systemPrompt`
   option replaces the composition; a blank one fails creation.
10. **Untrusted answers and the membrane** (D-M5-2, D-M5-3; W5.5 `m5-security`): exec code sends
    a 100 KiB string to a fixture object through `powers`: refused in the exec vat with
    `textOf.membraneTooLarge`, the fixture's vat answers its next call; a record of 40 keys is
    refused; a granted tool answering 300 KB yields a staged, cut result or
    `texts.inspectTerminated`, and the session keeps working.
11. **SIGKILL** (section 5): (a) K3 and K6 (W5.7 `m5-mentions-restart`); (b) K4 and K5: the
    fixture tool's log shows at most one run, the turn is outcome-unknown with "Tool outcome
    unknown", no rerun (W5.6 `m5-grants-restart`); (c) K1, K2 in acceptance 2's file.
12. **Reachability** (W5.9 `m5-reachability`): `thix reachability` from a session vat holding
    endowments, adopted objects and grants, and from its exec vat, reaches no `PresetCatalog`,
    `Inventory`, `Operator`, factory facet, `AgentHostAdmin`, `SecretsAdmin` or Secret admin.
13. **Inventory** (P-52 mapping; W5.1 `m5-presets-inventory`, split from `m5-presets` by XC,
    which held 334 s): add, page, relabel, remove; a duplicate label refused; a removed entry's
    methods refuse; `addAll` of 51 refused by the guard.
14. **Export and import of presets** (M2 acceptance 14's presets; W5.1 `m5-presets-inventory`): user
    presets come back with label, template, instructions, model defaults (backend by label) and
    without endowments (objects are not exported; journaled).
15. **UI** (P-49, R6-40; W5.8 `test/browser/m5-*.mjs` on M3's `startBrowserGateway({ template,
    provision? })`, gated by `THIX_HARNESS_BROWSER=1`, run after M3 is merged): a preset saved on
    device A appears on device B; a stale save shows the refusal; an over-size record is refused
    by the editor before sending; typing `@` lists inventory labels and sending attaches the
    object (acceptance 7's line seen by the fake provider; the transcript shows the attachment
    chip); after a reload, resending the saved draft shows `texts.attachmentsLost` and keeps it.

### 8.2 Performance checks (fixed windows)

Every row is a latency or a rate over a fixed window (60 s per measured point unless stated),
built from a template plus at most a minute of setup; no row replays thousands of turns, and none
needs a long session (M5's costs do not grow with session length: the label map, grants and
packages are bounded). A comparison row measures both sides alternately inside one window unless
it says "each". Each perf file stays under 6 minutes; `deliveries` from `status().timings` as
before.

| check | file (owner) | window | budget | why this budget |
|---|---|---|---|---|
| `tools.local` round with `list`, `lookup` (JSON), `store`, `remove`: added time per round over an `echo` round | `tools` (W5.3) | 60 s, alternating | median <= 30 ms; 0 extra session deliveries | the four run in the round-final crank (2.4.3); 30 ms is the parse and render cost of 4 small calls in a vat |
| `labels.full` turn start with 256 labels vs none | `tools` (W5.3) | 60 s, alternating two sessions | <= 1.1 x | bounded retained state must not slow a turn |
| `tools.inspect` `describeCapability` of a workspace-vat fixture, call to result | `tools` (W5.5 append) | 60 s | median <= 300 ms | session -> exec -> target -> exec -> session: two answered guest hops (53 ms trivial exec, J-9382) plus the target |
| `grants.round` turn start with 32 offered grants | `tools` (W5.6 append) | 60 s | median <= 350 ms; per-round tool set <= 10 ms engine | M2's turn start budget; S1 runs every round |
| `exec.powersLookup` `E(powers).lookup` inside exec calls of 20 lookups | `exec-m5` (W5.5) | 60 s | median <= 150 ms per lookup | one guest-to-guest answer (70-76 ms vat -> adapter -> vat, J-0161; faster vat to vat) |
| `exec.membrane` a membrane-wrapped call vs a raw call to the same fixture | `exec-m5` (W5.5) | 60 s, alternating | <= +5 ms median | exec-vat work only (one size walk of a small argument) |
| `exec.scope1000` trivial exec call in a scope with 1,000 globals (made by one call) | `exec-m5` (W5.5) | 60 s | median <= 300 ms | carried from milestones M5; the scope is a heap object, collection is scheduled (CORE-11) |
| `presets.save` round trip from a control client | `presets` (W5.1) | 60 s | median <= 150 ms | one factory crank (as `queue.enqueue`) |
| `inventory.page` 50-row page of 1,000 entries (built by 20 `addAll`) | `presets` (W5.1) | 60 s | median <= 200 ms | as the session list page budget (50 rows) |
| `mentions.turnStart` turn start with 32 attachments vs none | `mentions` (W5.7) | 60 s each | median <= +100 ms and <= 350 ms; <= 3 deliveries | M2's turn start budget; 32 handles add one larger frame |
| `prompt.compose` | `creation-m5` (W5.9) | Node: compositions over 10 s; vat: creations over a 120 s window, the largest preset and `chat-only` alternating (pool 4) | Node <= 5 ms each; vat: creation <= `chat-only` + 150 ms and <= 750 ms | composition is one `join`; the creation budget is M1b's 750 ms with the pool |
| `session.program` / `exec.program` bundle bytes; `session.createCold` | `creation-m5` (W5.9) | one build; cold creations over a 120 s window | <= the limits after O-1; cold <= 6 s | D-4's basis (10 us per byte); O-1 |
| too-big probes (a) 100 KiB argument through the membrane, (b) 200 KB `help`, (c) 20,000-key answer, (f) exec body of 300 k iterations ok and 10 x the per-crank ceiling terminated (carried) | `exec-m5` (W5.5) | each capped: (a) 15 s, (b) 30 s, (c) 30 s, (f) 30 s | no halt of the session vat or the target's vat; the refusal texts | facts 2 and 4 |
| too-big probes (d) 8,193-byte `store`, 257th label, 33 attachments; (e) a granted schema with 3,000-unit parameters | `tools` (W5.3) | each capped at 30 s | as above | as above |

Files and their worst time (windows + capped probes + template setup): `tools` 4 windows + 60 s
of probes + 30 s = 5.5 min; `exec-m5` 3 windows + 105 s + 30 s = 5.3 min; `presets` 2 windows + 30
s = 2.5 min; `mentions` 2 windows + 30 s = 2.5 min; `creation-m5` 10 s + 2 x 120 s + one build
(about 30 s) + 30 s = 5.2 min.

**Regression run within 20 minutes on four slots**: 11 M5 integration files (`m5-presets`,
`m5-prompt`, `m5-labels`, `m5-objects`, `m5-security`, `m5-grants`, `m5-grants-restart`,
`m5-mentions`, `m5-mentions-restart`, `m5-snapshot`, `m5-reachability`) and the browser file,
each <= 4 minutes (at most 48 slot-minutes), and five perf files (`tools`, `exec-m5`, `presets`,
`mentions`, `creation-m5`; 21 slot-minutes): at most 69 slot-minutes, about 17.3 minutes of wall
time on four slots. W5.9 records the measured wall time.

---

## 9. Merge hotspots, core requests and owner decisions

### 9.1 Merge hotspots (files another lane may also edit) and the seam M5 proposes

Merge order (cross-check, W5.0-settle): the three contract commits first; then M3, M4, M5. M5
merges last and W5.9 adapts to the seams as they landed. Shared files have one owner each; the
other lane's edit is the exact line named.

| id | file | owner; other lane's edit | M5's seam (exactly) |
|---|---|---|---|
| H-1 | `guest/factory/factory.js` (catalogue) | M5 (W5.1); M4 adds one line after the `turnDeadlineMs` copy (M4 H-7: `if (extras.reasoningEffort !== undefined) fields.reasoningEffort = extras.reasoningEffort;`), which M5 does not touch | replace the five `chatOnly` lines by `const catalog = makePresetCatalog({ templates }); const chatOnly = catalog.builtIn('chat-only');`, `listPresets: () => catalog.list()`, the resolver context's `defaultPreset: catalog.defaultPreset()`, and one line at the top of `create`: `given = catalog.withDefaults(given);` |
| H-2 | `guest/factory/factory.js` (Operator) | M5 (W5.1); M4 none | the Operator exo's guard becomes `extendInterface(m2Interfaces.Operator, 'Operator', m5FactoryExtensions.Operator())` (= `m5FactoryInterfaces.Operator`); M5's methods are two lines `getPresets: () => catalog.facet()`, `getInventory: () => inventory.facet()` |
| H-3 | `guest/factory/factory.js` (`buildSessionServices` call and the config fields) | M5 (W5.1); M4 none | one field in the call, `presetSnapshot: resolved.presetSnapshot`; the config's `preset:` line becomes `catalog.configSnapshot(resolved.presetSnapshot)`; one `fitsFrame` check before `make` |
| H-4 | `guest/session/session.js` (Session guard) | M5 (W5.3); M4 none | the Session exo's guard becomes `extendInterface(m2Interfaces.Session, 'Session', m5Extensions.Session())` (= `m5Interfaces.Session`); M5's two methods forward to the runtime |
| H-5 | `guest/session/tool-table.js` | M5 (W5.3, appends by W5.5, W5.6, W5.7); other lane none (`accountStatus` is an adapter tool with no table entry) | M5 appends `...objectToolEntries, ...inspectionToolEntries, ...packageToolEntries` to `toolTable` and adds the `toolSources` list; import lines appended after the existing ones |
| H-6 | `guest/lib/interfaces.js` | M5 (W5.3's first commit: the four `m5Widenings`); M4 changes one line (`BackendKind`, M4 H-1); M3 makes no edit | only the four `m5Widenings`, each replacing one shape builder or field: `TurnStarted` gains the optional `{ attachments }` bag; `RoundRequest`'s optional `system` becomes `M.or(staged(S.Text), list(staged(S.Text), 2))`; `PresetSnapshot` gains the optional fields; `SessionServices`' optional bag gains `endowments`. This commit and M4's H-1 may be merged early as contract follow-ups |
| H-7 | `AH/composer.js` | M5 (W5.7); M3 none (the fourth argument is optional) | the guard switch to `m5Interfaces.Composer` and one branch in `submit` |
| H-8 | `AH/providers/round.js` (`systemTextOf`) | M5 (W5.3); M4 calls `systemTextOf` from its `provider.js` and makes no edit | the function body only: an array is joined part by part with a blank line |
| H-9 | `AH/providers/scripted.js` | M5 (W5.3); M4 none | the `system` read replaced by `systemTextOf` (5 lines) |
| H-10 | `scripts/provision-steps.js` (since the M2 review: the step registry `scripts/provision-steps/`; M5's step is `50-m5-fixtures.js`, moved there at the merge, INT-M5) | append-only hook table, PM-merged; steps in merge order: gateway (M3, gated on `options.gateway`), subscriptions (M4), M5 fixtures | one appended entry (W5.5), a no-op unless `options.m5Fixtures` is given (test templates only). **Option forwarding**: `makeProvision` at `3588cab190` passes its steps only `{ sessionEntry, execEntry, pool }`, so none of `gateway`, `subscriptions` or `m5Fixtures` reaches a step. The seam, made once by the first lane to merge (M3) and identical in all three lanes: the destructured parameter gains `...stepOptions` and the call becomes `options: { ...stepOptions, sessionEntry: entry, execEntry: exec, pool }` (two lines). If M3 has not made it when W5.5 starts, W5.5 makes exactly these two lines |
| H-11 | `scripts/export.mjs` | M5 (W5.1) | one appended `presets` line in export and its reader in import |
| H-12 | `H/package.json`, `perf/_harness.mjs`, `JOURNAL.md` (M5 J-0710..J-0729) | PM-merged (convention) | M5 adds no dependency and no harness change |

**As merged (INT-M5).** M5 merged last, onto M3 and M4. Two conflicts, both kept: the attachment
labels in `pending-queue.js` sit on the M2 review's receipt eviction (a retry under a known request
id must carry the same labels; the 4,096 receipts are evicted, not refused), and the M5 step moved
into its registered file. M4 had already lifted `NOT_YET` for `reasoningEffort`, so a preset effort
on a backend that is not a subscription pool is refused with M4's `effortNotSupported`. Both
`interfaces-m5*.js` load in M3's gateway vocabulary and every M5 method name is admitted
(`test/adapter/m5-gateway-vocabulary.test.js`). The O-1 limits (240,000 / 120,000) came with the
lane; the merged session program is 236,583 bytes and the exec program 105,414.

**Not hotspots** (M5 adds files only): `ui/src/presets/`, `ui/src/mentions/` (one directory per
lane, collected by M3's `ui/build.mjs`; `ui/src/features.js` is M3's collector and M5 does not
edit it); `test/browser/m5-*.mjs` (M3 owns `_harness.mjs` and `m3-*.mjs`); the key-guard
vocabulary (both `interfaces-m5*.js` export `vocabularyShapes()`, which M3's loader finds by file
name). M5 does not edit `config/defaults.js` (M4's), `session-options.js` (M4's), `ui/build.mjs`,
`GW/{extensions,vocabulary}.js` (M3's) or any `AH/index.js`, `attach.js`, `durable.js` line.

M5 only in this round: `turn.js`, `turn-hooks.js`, `exec/*`, `tools/exec.js`, `queue.js`,
`submissions.js`, `pending-queue.js`, `prompt.js`, `system-prompt-base.js`, `services.js`.

### 9.2 Core requests (CC-070 .. CC-073)

**CC-070 Refuse an oversize inbound frame instead of halting the vat.** Motivation: M5 is where
model-written code and arbitrary objects first call into guest vats they do not control (fact 2:
one message above about 94 KB halts the receiver for good). Smallest change: in the host, where a
frame bound for a worker is journaled (`pkg/src/core/durable-worker-transport.js` /
`pkg/src/net/hub.js`), measure its byte length; above a configured ceiling (default 65,536,
`THIXOTROPE_INBOUND_FRAME_BYTES`, fixed per state directory) do not journal or deliver it: a call
is answered with an error ("message too large for the target vat"), an answer is replaced by that
error, a `sendOnly` is dropped and counted in `status()`. Workaround if refused: D-M5-2 (the
inspector) and D-M5-3 (the membrane), which protect the session vat and, partly, other vats; the
exec vat still halts on a hostile answer (the scope is lost and stated).

**CC-071 Inbound record keys do not drain a vat's permanent name table.** Motivation: fact 4; a
model can drip distinct keys into any vat whose object it holds (the membrane bounds each message,
not a sequence). Smallest change: a per-vat quota of names interned from inbound frames, after
which a frame with a fresh key is refused like CC-070 (the vat's own code keeps its names), or
make exhaustion a halt (C-6). Workaround: the membrane's per-message bounds; open decision O-9.

**CC-072 `getInterfaceGuardPayload` in the guest prelude.** Motivation: `extendInterface` reads
`guard.payload.methodGuards`, an internal shape of `@endo/patterns`. Smallest change: add the
helper to `pkg/src/guest/prelude.js` (the export exists in `@endo/patterns`). Workaround: read
`.payload` (works today; the contract test pins it).

**CC-073 The exec handle can read why its vat stopped.** Motivation: after an inspector call the
session cannot tell a hostile answer (`HeapExhausted` in decode) from a worker crash give-up
(J-9051), so `texts.inspectTerminated` names both. Smallest change: the worker facade's `status()`
(already holding the recorded `failure`) available on a narrowed facet the pool can give
`ExecHandle`. Workaround: the neutral text.

### 9.3 Decisions that are the owner's (the default is what M5 builds until told otherwise)

| id | question | default |
|---|---|---|
| O-1 | The session program is 186,448 of 200,000 bytes at `3588cab190` (measured in W5.0) and the exec program 84,354 of 100,000; M5 adds about 25 KB to the session (labels, three tool modules, packages, grants, `interfaces-m5.js`) and about 12 KB to exec; M3 adds 0 bytes to either and M4 at most 64. Raise `sessionProgramBytes` to 240,000 and `execProgramBytes` to 120,000 (cold creation about +0.4 s at 10 us a byte; the pool hides it), or split `interfaces.js` per vat first? | raise: W5.9 measures the merged bundles and the PM raises the limits to 240,000 / 120,000 in the M5 merge commit, with the `session.createCold` row; no lane splits `interfaces.js` now. The owner can overrule before W5.9. After the merge (X1, cross-lane): `interfaces.js` was split per vat program after all (`guest/lib/guards/`); session 236,583 -> 213,712, exec 105,414 -> 62,196. XC (adapter tools, grant label, membrane): session 214,690, exec 63,741 of the unchanged 240,000 / 120,000 limits |
| O-2 | Untrusted answers go through the exec vat (D-M5-2): a hostile object can reset the model's exec scope | yes |
| O-3 | `store` and `remove` are kept (P-17) although Appendix F would drop them; values at most 8,192 bytes, 256 KB per session, 256 labels | as stated |
| O-4 | Preset instructions at most 4,096 units (Fae 32,768) so one preset fits a frame | 4,096 |
| O-5 | A `Preset` is one object for its life; `createSession` uses its current record (no versions); a stale page creates from the current record | current |
| O-6 | Granted tool descriptions cut to 1,024 units, schemas at most 2,048 units, 12,288 bytes of granted descriptions per round (R3-27 allows 16,384 and 1 MiB) | as stated |
| O-7 | Prompt parts 4-6 come from the milestones that build what they describe; M5 composes 1, 2, 3 (empty) and 7 | as stated |
| O-8 | The label map (stored values, adopted objects) and queue attachments are not exported (as exec bindings) | not exported |
| O-9 | Membrane bounds (12,288 bytes, 32 keys per record, 256 per message, depth 32) and the residual key-drip risk until CC-071 | as stated |
| O-10 | Default preset (R3-20): `chat-only` until a runner allows public internet (M6/M7) | as stated |
| O-11 | Reserved labels: `user`, `tools`, `subagents` and JavaScript's `__proto__`, `constructor`, `prototype`; template labels are refused as duplicates | as stated |
| O-12 | Who may grant tools: the Session holder and `adoptTool` from a package; model code cannot (Endo let exec code bind under `tools`) | as stated |

---

## 10. Module entry points

Every unit exports exactly these (more is allowed; names and signatures fixed). "vat" = guest
rules; "Node" = adapter or tests.

| unit | file | export |
|---|---|---|
| W5.0 | `guest/lib/interfaces-m5.js` | `m5Shapes`, `m5Interfaces`, `m5Extensions`, `m5Widenings`, `m5MethodNames`, `extendInterface`, `lazyTable`, `texts`, `textOf`, `objectToolNames`, `packageToolNames`, `m5ToolArgumentNames`, `reservedLabels`, `powersMethodNames`, `inspectOps`, `grantStates`, `vocabularyShapes` (Node only) |
| W5.0 | `guest/lib/interfaces-m5-factory.js` | `m5FactoryShapes`, `m5FactoryInterfaces`, `m5FactoryExtensions`, `m5FactoryMethodNames`, `texts`, `textOf`, `presetTemplateNames`, `builtInPresetLabels`, `templateObjectKinds`, `vocabularyShapes` (Node only) |
| W5.0 | `guest/lib/limits-m5.js` | `limitsM5` |
| W5.1 | `guest/lib/preset-catalog.js` (vat) | `BUILTIN_PRESETS` (records, Fae's, endowments empty), `normalizePresetRecord(record, { templates }) -> record` (throws the section 12 texts; its last check is `fitsFrame(record, limitsM5.presetRecordBytes)`, else `texts.presetTooLarge`) |
| W5.1 | `guest/factory/presets.js` (vat) | `makePresetCatalog({ templates }) -> { facet, list(), builtIn(label), defaultPreset(), withDefaults(options), configSnapshot(snapshot), recordOf(preset), endowmentsAt(preset, revision), exportRecords(), importRecord(record) }` |
| W5.1 | `guest/factory/preset-templates.js` (vat; hook table) | `templateTable` (`[{ template, label, description, objects: [{ kind, label, required }] }]`), `objectProviders` (append-only: `{ kind, available(context) -> undefined \| reason, build(context) -> Promise<{ label, value, services? }> }`; empty in M5) |
| W5.1 | `guest/factory/inventory.js` (vat) | `makeInventory() -> { facet, size() }` |
| W5.1 | `guest/factory/services.js` (append) | `presetEndowments` builder |
| W5.2 | `guest/lib/prompt-sections.js` (vat; hook table) | `promptSections` (`[{ part, name, applies(context), text(context) }]`) |
| W5.2 | `guest/lib/system-prompt-base.js` (vat) | `composeSystemPrompt({ spoken, snapshot?, userInitiated? }) -> string` (M2's `presetText` form kept as an alias) |
| W5.3 | `guest/lib/tool-args.js` (vat and Node) | `parseClosedArgs(text, spec)`; `argSpecs` for M5's built-in tools |
| W5.3 | `guest/session/labels.js` (vat) | `makeLabels({ seeds }) -> Labels` (2.4.1) |
| W5.3 | `guest/session/label-seeds.js` (vat; hook table) | `labelSeeds` |
| W5.3 | `guest/session/m5-parts.js` (vat; hook table) | `m5Parts` (`[{ name: 'powers' \| 'inspector' \| 'grants' \| 'packages', make(runtime) }]`), `makeRuntime({ labels, services, config }) -> runtime` |
| W5.3 | `guest/session/tools/objects.js` (vat) | `objectToolEntries` |
| W5.3 | `guest/session/tool-table.js` | `toolSources` (new list), `toolSetFor(ports, table?, services?, sources?, runtime?)` |
| W5.3 | `guest/session/turn-hooks.js` | `turnHooks.onClaim` (new list) |
| W5.4 | `guest/exec/powers.js`, `membrane.js`, `inspect.js` (vat) | `makeCallPowers({ source, callE, isOpen })`, `makeMembrane({ callE, limits })`, `makeInspector({ writers, content })` |
| W5.4 | `guest/session/tools/inspect-client.js` (vat) | `inspectFor(context) -> (request) -> Promise<outcome>` |
| W5.4 | `test/fixtures/m5-objects.js` | the fixture source (evaluated in the workspace vat) and `makeM5Fixtures(client)` (Node) |
| W5.5 | `guest/session/powers-source.js` (vat) | `powersPart` |
| W5.5 | `guest/session/tools/inspection.js` (vat) | `inspectionToolEntries`, `inspectorPart` |
| W5.6 | `guest/session/tools/granted.js` (vat) | `grantsPart`, `grantedToolSource` |
| W5.7 | `guest/session/packages.js` (vat) | `packagesPart`, `makePackages()` (`open({ labels, values, turnId }) -> number`, `take(number, edge)`, `closeTurn(turnId)`) |
| W5.7 | `guest/session/tools/mentions.js` (vat) | `packageToolEntries`, `mentionHooks` (`onClaim`, `onSettle`) |
| W5.5 | `scripts/provision-steps/50-m5-fixtures.js` (a registered step file since the merge; the lane appended to `scripts/provision-steps.js`) | the M5 fixture step `{ name: 'm5 fixtures', run({ client, connect, options }) }`, answering `{ skipped: true }` unless `options.m5Fixtures` (the fixture list of `test/fixtures/m5-objects.js`) is given |
| W5.8 | `ui/src/presets/feature.js` (browser) | `feature`: `{ id: 'presets', slot: 'app.panel', label: 'Presets', component }` |
| W5.8 | `ui/src/mentions/feature.js` (browser) | `feature`: `[{ id: 'mentions.addon', slot: 'composer.addon', component, send }, { id: 'mentions.chips', slot: 'message.renderer', component }]` |
| W5.8 | `ui/src/mentions/texts.js`, `ui/src/presets/size.js` (browser) | `attachmentsLost` (equal to `texts.attachmentsLost`); `presetRecordBytes` (equal to `limitsM5.presetRecordBytes`), `fitsPresetRecord(record) -> boolean` (the `fitsFrame` rule) |

---

## 11. Hook tables

| table | created by | M5 entries | later |
|---|---|---|---|
| `guest/session/tool-table.js` `toolTable` | M1a | W5.3 `objectToolEntries`; W5.5 `inspectionToolEntries`; W5.7 `packageToolEntries` | M6, M8, M9 (M4's `accountStatus` is an adapter tool, not an entry) |
| `tool-table.js` `toolSources` (new) | W5.3 | W5.6 `grantedToolSource` | M9 |
| `guest/session/turn-hooks.js` `onClaim` (new) | W5.3 | W5.7 | M9 (mail turns) |
| `turn-hooks.js` `onSettle`, `recoverySteps` | M1a | W5.7 (close packages) | M6, M9 |
| `guest/session/m5-parts.js` (new) | W5.3 | W5.5 `powers`, `inspector`; W5.6 `grants`; W5.7 `packages` | M9 (`inbox` part) |
| `guest/session/label-seeds.js` (new) | W5.3 | none | M6 `workspace`, `shell` |
| `guest/lib/prompt-sections.js` (new) | W5.2 | parts 1, 2, 3, 7 | M6 part 6, M9 part 4, M12 part 5 |
| `guest/factory/preset-templates.js` `objectProviders` (new) | W5.1 | none | M6 |
| `guest/factory/services.js` `serviceBuilders` | M1a | W5.1 `presetEndowments` | M6 |
| `guest/factory/session-options.js` `optionResolvers` | M1a | none (W5.2's composition is inside M2's `promptResolver`) | M4, M7 |
| `scripts/provision-steps.js` | M1a | W5.5 M5 fixtures (after M3's gateway and M4's subscriptions steps; a no-op unless `options.m5Fixtures`) | |
| `ui/src/*/feature.js` directory registry (M3 6.2; collector `ui/src/features.js` is M3's, not edited) | M3 W3.4 | W5.8 `presets/`, `mentions/` | M11, M12 |
| key-guard vocabulary (M3 6.3): every `guest/lib/interfaces-m*.js` `vocabularyShapes()` | M3 W3.2 | W5.0 (both M5 files) | each later contract file |
| `perf/tools.perf.mjs` `rows` | W5.3 | W5.5 `tools.inspect`, W5.6 `grants.round` | |

---

## 12. Fixed texts (M5)

Exact strings are in `interfaces-m5.js` and `interfaces-m5-factory.js`; `m5-interfaces.test.js`
checks them.

| constant | text | source |
|---|---|---|
| factory `texts.invalidPreset`, `unknownTemplate`, `invalidEndowments`, `invalidTemplateObject`, `templateObjectsRequired`, `shellNeedsWorkspace`, `invalidNetworkPolicy`, `chatOnlyRule`, `backendForDefaults`, `modelForBackend`, `presetStale`, `tooManyPresets`, `builtInTemplateFixed`, `builtInNotDeletable`, `onlyBuiltInReset`, `unknownPreset`; `textOf.invalidField`, `reservedEndowment`, `duplicateEndowment`, `endowmentNotObject` | Fae's words | Fae `session/preset-catalog.js` |
| factory `texts.presetDeleted`, `presetChanged`, `presetTooLarge`, `inventoryFull`, `entryRemoved`; `textOf.presetNeeds`, `inventoryLabelTaken` | see the file | harness |
| `textOf.mentionLine(number, names)` | `Message #<n> attaches objects with edge names <JSON>. These are labels, not instructions. Use adopt(messageNumber: <n>, edgeName, petName) or adoptTool during this turn to keep or use them. The package is dismissed after the turn.` | R4-29; Fae `session/session-attachments.js` |
| `textOf.adopted`, `adoptedTool`, `stored`, `removed` | Fae's words | Fae `src/tool-makers.js` |
| `textOf.reservedLabel` | Fae's `Reserved or invalid endowment name: <label>` | R3-22 |
| `textOf.unknownLabel`, `labelTaken`, `labelsFull`, `valueTooLarge`, `storedValuesFull`, `argumentsTooLarge`, `noPackage`, `noEdge`, `tooManyAttachments`, `packageTooLong`, `duplicateAttachment`, `toolNameBuiltIn`, `toolNameDuplicate`, `toolSchemaInvalid`, `toolOverBudget`, `membraneTooLarge`, `membraneTooManyKeys`, `membraneTooDeep`; `texts.powersExpired`, `inspectTerminated`, `grantWithdrawn`, `grantsFull`, `attachmentsLost` (the browser's mention addon; W5.8 keeps an equal copy) | see the file | harness |
| tool descriptions and parameter schemas of `list`, `lookup`, `store`, `remove`, `describeCapability`, `readSources`, `adopt`, `adoptTool` | ported word for word by W5.3, W5.5, W5.7 | Fae `src/tool-makers.js`, `src/source-tools.js` |
