# dietician-app

A **portable, Endo-native** restaurant-safety guide — a from-scratch JS port of the agent-dietician persona
pipeline (`sweep.py` / `rank.py` / `gen_prompts.py` / `reevaluate.py` / `build_kml.py` / `gen_guide.py`), with
**no SSH-to-persona dependency**. The goal: package it so anyone can run their own instance in the Endo
environment with **their own** Google Places key (from the secret registry), **their own** diet spec, and
**their own** data store.

## Why

The live `voice-agent/dietician.mjs` SSH-drives ONE box (`agent@10.89.0.8`) with dan's hardcoded paths and
Alexa's spec — that coupling is the whole non-portability problem. This port replaces *"ssh into MY persona"*
with *"`core.mjs` runs against caps YOU hold"*: the Places provider, the LLM judge, the data store, and the
diet spec are all **injected**, so swapping them gives a different person's dietician from the same source.

## Architecture (three-layer split, like rover-app / gpu-studio)

- **`core.mjs`** — PURE node (no `@endo/init`, no `harden`): the whole pipeline over injected I/O. Headless-
  testable. This is where the Python logic ports verbatim.
- **`providers/`** — the small impure adapters. `places.mjs` (Google Places searchText + geocode; key read
  from the registry via `getSecret('google-places-api-key')`, returns results only — never the key).
- **`grunt.mjs`** *(Slice 8)* — `import '@endo/init'` first; the cap layer (`makeDietician` → `DietConsole`
  root + attenuated `guide`/`scanner`/`editor` facets + `DietProvisioner`), the `/rpc` HTTP adapter, and the
  static SPA host. Hardens at the boundary.

Supporting modules: `cities.mjs` (the ONE unified city table — the persona hardcoded it in 3 divergent
places), `skiplists.mjs` (the two-tier a-priori filter, ported 1:1), `store.mjs` *(Slice 3)* over a home-folder
cap, `prompt.mjs` / `kml.mjs` / `guides/` *(Slices 4–7)*.

## Secret

The Google Places key lives in our named secret registry as **`google-places-api-key`** (`getSecret`, env
`GOOGLE_PLACES_API_KEY` first — the same var `sweep.py` read), at `~/.config/field-agent/secrets/`. Onboard a
new operator's key via an in-chat secret-ask `{type:'secret', key:'google-places-api-key'}`. Never a tool arg,
never logged, never on screen.

## Slice plan / status

- [x] **Slice 1** — `providers/places.mjs` + `cities.mjs` + `skiplists.mjs`: pure-JS Places searchText +
  geocode reading the registry key (NO SSH). *Proven: `npm run smoke`.*
- [x] **Slice 2** — `core.mjs` `scan`: ports `sweep.py` (two-tier skip-lists, in-city filter, slugify +
  collision/idempotency) + `rank.py` (PRIORITY/CAPS), in-memory (no `/tmp`). *Proven: `node --test` + a real
  `scan('oakland')` → 56 candidates, top-20 ranked.*
- [x] **Slice 3** — `store.mjs` (typed wrapper over a folder cap — the `makeFsFolder` shim now, the SES
  home-folder cap in grunt later) + `import-db.mjs`, the importer that pulls dan's `~/eating-out` DB
  (1077 places + 947 evals) into one instance store, normalizing the 130 inline-verdict a-priori SKIPs into
  `evaluations/`. *Proven: `node --test` + `scripts/import-persona.mjs` → instance counts VIABLE/BORDERLINE/
  UNKNOWN match the live persona DB exactly (COPY; the instance lives at `~/.local/state/dietician-app/
  instances/<person>/`, outside the repo — `diet.md` is PHI).*
- [x] **Slice 4** — `prompt.mjs` (EVAL rubric + verdict taxonomy + exact schema + `parseVerdict`, ported from
  `dietician.mjs`, parameterized by person), `providers/judge.mjs` (UNKNOWN-safe LLM evaluator),
  `providers/anthropic.mjs` (the package's own plain-node model adapter — key from env/registry/`~/.env`),
  and `core.evaluate` (cached_menu-preferred; web lookup only if a `web` cap is injected; idempotent; scan
  now persists candidates so evaluate finds them). *Proven: `node --test` (13/13) + `smoke/evaluate-smoke.mjs`
  — real Opus re-judges dan's cached menus and reproduces the persona verdicts (decisive SKIPs match;
  disagreements are the fuzzy VIABLE↔BORDERLINE↔SKIP boundary).*
- [x] **Slice 5** — `kml.mjs`: ports `build_kml.py` (lng,lat,0; ABGR `ff00aa00`; CDATA + `&<>` escape; VIABLE
  + BORDERLINE folders only) + `core.buildMap`. *Proven: `node --test` (16/16) + `smoke/kml-smoke.mjs` built
  `safe-eats.kml` from dan's imported DB → 251 placemarks (75 VIABLE + 176 BORDERLINE), 524900 bytes —
  essentially byte-identical to the persona's live ~525KB file.*
- [x] **Slice 6** — `guides/shared.mjs` (esc/cityOf/mapsUrl/dishHtml/card, shared by both guides) +
  `guides/sort-js.mjs` (the client script) + `guides/eats-guide.mjs` (city-grouped dark-theme page) +
  `core.generateGuide('eats')`. *Proven: `node --test` (20/20) + `yarn test:eats-guide` (headless over dan's
  imported DB): 237 cards across 19 cities, city tabs filter, "safe bets only" hides all 171 borderline,
  sort.js search works.*
- [ ] **Slice 7** — `guides/disney-guide.mjs` (park-grouped + hotel section + 2 inline-SVG maps).
- [ ] **Slice 8** — `grunt.mjs` cap layer: `DietConsole` + `guide`/`scanner`/`editor` facets + `/rpc` + SPA.
- [ ] **Slice 9** — `DietProvisioner.newInstance` + `signup` (multi-tenant).
- [ ] **Slice 10** — `dietician-app.service` + `GUIDE.md`; re-point the voice-agent `dietician` power at a
  held `DietConsole` cap (retire the SSH internals). *Needs dan's go for the public-guide publishing change.*
- [ ] **Slice 11** *(explicit)* — public chu-bind (ngrok `--domain` sidecar), per-instance operator step only.

## Run

```
npm test          # deterministic unit tests (no network)
npm run smoke     # LIVE: real Google Places sweep of Oakland, key from the registry, no SSH
```

Full design + the persona system map: see the investigation in the session memory / the design doc.
