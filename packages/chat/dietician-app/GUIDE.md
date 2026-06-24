# Run your own dietician

A portable, Endo-native restaurant-safety guide. It sweeps a city's restaurants (Google Places), judges each
against **your** binding diet spec (an LLM reads the menu vs your rules → VIABLE / BORDERLINE / SKIP / UNKNOWN),
and builds a Google-Maps KML + browsing guides — and the whole thing is a **capability** you can hold, hand out
narrowly, and revoke. No SSH, no shared database: your key, your diet, your data store.

## What you need

1. A **Google Places API (New)** key — for the sweep + geocoding.
2. An **Anthropic API key** — for the menu judge (Opus by default; a local model can be injected instead).
3. A **diet spec** — a Markdown file describing what you can/can't eat (it's fed to the judge verbatim).

Keys are read **server-side from the secret registry** (`getSecret` over `~/.config/field-agent/secrets/`,
env first) and **never** reach the agent/LLM/client or any capability. Onboard a key via an in-chat secret-ask
(`{type:'secret', key:'google-places-api-key'}` / `anthropic-api-key`), a 0600 file drop, or env vars.

## Run it

```sh
cd packages/chat/dietician-app
# put your diet spec in the instance store (or POST it via the editor cap)
mkdir -p ~/.local/state/dietician-app/instances/alexa && cp my-diet.md ~/.local/state/dietician-app/instances/alexa/diet.md
node grunt.mjs            # or: cp dietician-app.service ~/.config/systemd/user/ && systemctl --user enable --now dietician-app
```

On first boot it mints a stable **root swissnum** (`~/.config/dietician-app/<person>.swiss`, 0600) and logs a
fingerprint. `DIET_PRINT_ROOT=1 node grunt.mjs` prints the full owner + provisioner links once. Open
`http://127.0.0.1:8782/#cap=<root-swissnum>` — that swissnum **is** the authority.

Tests: `yarn test` (unit) · `yarn test:cap` / `yarn test:prov` (SES confinement) · `yarn smoke` (live Places).
Importing an existing `~/eating-out` DB: `node scripts/import-persona.mjs`.

## The capability model

- **root `DietConsole`** — full authority: `scan(city)`, `evaluate({city,limit})`, `buildMap()`,
  `generateGuide("eats"|"disney")`, `status()`, `readSpec`/`writeSpec`, and `share`/`listShares`/`revoke`.
- **`share(kind, label, opts)`** mints a **narrower, independently-revocable** facet (its own swissnum/URL):
  - `guide` — read-only: `readGuide`, `status`, `listCities`. The link you hand a friend. No scan/evaluate/diet.
  - `scanner` — `scan` + `evaluate`, optionally `{city}`-locked and rate/TTL-bounded. Can't publish or read the diet.
  - `editor` — `readSpec`/`writeSpec` + `evaluate`. Can't publish.
- **`revoke(swiss)`** drops the swissnum from the `/rpc` locator — the link goes dead; your own access is untouched.
- **`DietProvisioner.newInstance({person, dietSpec})`** spins up a fully-isolated instance (own store + diet) and
  returns owner + guide URLs — that's how Alexa, Dan, a guest each get their own dietician on one host.

**Cap-hygiene:** a swissnum is the authority — never render it to screen, log it, or put it in a path/query; hand
off a link by **copy** (or an on-demand local QR) only. The SPA strips its own `#cap=` from the address bar.

## Driving a link headlessly — agent manifest

A holder of any link (an LLM included) can use and re-delegate it over plain HTTP, no browser, no account:

```jsonc
// #agent-manifest
{
  "transport": "http-json-rpc",
  "endpoint": "POST {origin}/rpc",
  "auth": "the swissnum is the hex after #cap= in the link you were given",
  "call": "{ \"swissnum\": \"<hex>\", \"method\": \"<name>\", \"args\": [ ... ] } → { ok, result } | { ok:false, error }",
  "discover": "call method \"help\" and \"describe\" first — describe() returns { kind, can: [...] } for this cap",
  "methods": {
    "root":      ["describe","status","listCities","scan","evaluate","buildMap","generateGuide","readSpec","writeSpec","share","listShares","revoke","help"],
    "guide":     ["describe","status","listCities","readGuide","help"],
    "scanner":   ["describe","scan","evaluate","help"],
    "editor":    ["describe","readSpec","writeSpec","evaluate","help"],
    "provisioner":["describe","list","newInstance","signup","help"]
  },
  "delegate": "if you hold root: share(kind,label,opts) → a new { url } you can pass on; revoke(swiss) kills it",
  "hygiene": "never echo the swissnum; pass links by copy/QR only"
}
```

## Provenance

A from-scratch JS port of the agent-dietician persona pipeline (`sweep.py`/`rank.py`/`gen_prompts.py`/
`reevaluate.py`/`build_kml.py`/`gen_guide.py`). See `README.md` for the slice-by-slice build + proofs. The
live SSH bridge (`voice-agent/dietician.mjs`) stays the field-agent's `dietician` power until an explicit
operator cutover re-points it at a held `DietConsole` cap.
