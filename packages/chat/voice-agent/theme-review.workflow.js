export const meta = {
  name: 'theme-review',
  description: 'Adversarial design review of one confined island across themes (hierarchy, affordance, parity, a11y, kit, polish)',
  whenToUse: 'Authoring or changing a confined-Preact island/UI component — the judgement layer above the deterministic theme-matrix contrast test.',
  phases: [
    { title: 'Render', detail: 'run the render harness → per-theme computed-style report + source' },
    { title: 'Critique', detail: 'six adversarial design lenses, each hunting for what is wrong' },
    { title: 'Verify', detail: 'cross-check findings against the rendered facts, dedup, rank' },
  ],
};

// args = the island name (string) or { component }. Defaults to KitSampler (the whole kit).
const COMPONENT = (typeof args === 'string' && args.trim()) ? args.trim() : (args && args.component) || 'KitSampler';
const DIR = '/home/dan/endo-bfb-llm/packages/chat/voice-agent';

phase('Render');
const RENDER = {
  type: 'object', additionalProperties: false,
  properties: {
    ok: { type: 'boolean' }, summary: { type: 'string' },
    reportJson: { type: 'string', description: 'the FULL contents of report.json, verbatim' },
    source: { type: 'string', description: 'the full component source file text (or "" if none)' },
  }, required: ['ok', 'summary', 'reportJson', 'source'],
};
const rendered = await agent(
  `Gather the render evidence for the "${COMPONENT}" confined island so a design review can run.
Do exactly this:
1. Bash:  cd ${DIR} && node theme-review.cjs ${COMPONENT}
2. Read  /tmp/theme-review/${COMPONENT}/report.json  — return its FULL text as reportJson.
3. From report.signals.sourceFile (e.g. client/<kebab>.js), Read ${DIR}/<that path> and return its full text as source ("" if missing).
Return ok=true if the harness ran and report.json was read. summary = one line (nodes probed, worst contrast, renderError).
Do NOT analyse or judge — just gather + return the raw evidence.`,
  { label: `render:${COMPONENT}`, phase: 'Render', schema: RENDER });

if (!rendered || !rendered.ok) { log(`render harness failed for ${COMPONENT}`); return { component: COMPONENT, error: 'render failed', rendered }; }
log(`rendered ${COMPONENT}: ${rendered.summary}`);

phase('Critique');
const FINDINGS = {
  type: 'object', additionalProperties: false,
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      title: { type: 'string' }, severity: { type: 'string', enum: ['high', 'med', 'low'] },
      evidence: { type: 'string', description: 'the concrete value/node from the report (or source line) that proves it' },
      fix: { type: 'string' },
    }, required: ['title', 'severity', 'evidence', 'fix'],
  } } }, required: ['findings'],
};
const CONTEXT = `COMPONENT: ${COMPONENT}
RENDER REPORT (computed styles per theme + signals) — your evidence base:
${rendered.reportJson}

COMPONENT SOURCE (preact h()-based, render-safe; state lives in props):
${rendered.source || '(source unavailable)'}

Notes: this is a confined island in Agent C (a voice/text chat OS). It renders into the page DOM and inherits
theme CSS vars (--bg/--panel/--ink/--mut/--acc/--acc2/--bad/--you*/--trace*/--warn). The deterministic test
already enforces contrast ≥ 3:1 and that colours are themed — so do NOT just re-report raw contrast unless it
is genuinely a hierarchy/parity problem. WCAG: text AA = 4.5:1, UI/large = 3:1; tap target ≥ ~44px (≥24 min).`;
const LENSES = [
  { key: 'hierarchy', brief: 'VISUAL HIERARCHY: is the most important element the most prominent? Judge the font-size/weight progression across nodes — is the title clearly above the body, the body above secondary/meta? Is it too flat (everything one weight) or too noisy? Does the primary action read as primary?' },
  { key: 'affordance', brief: 'AFFORDANCE & INTERACTIVITY: do interactive nodes look interactive? Check cursor (should be pointer on buttons/links), whether actions are visually distinct from static text, and whether the PRIMARY action is more prominent than secondary/destructive ones. Flag clickable things that look like plain text, or destructive actions that look identical to safe ones.' },
  { key: 'parity', brief: 'DARK/LIGHT PARITY: compare each node\'s computed values between the dark and light arrays in the report. Flag any colour that is IDENTICAL across themes when it should flip (a stuck/un-themed value), anything that looks intentional in one mode but accidental in the other, and contrast that is comfortable in one mode but marginal in the other.' },
  { key: 'a11y', brief: 'ACCESSIBILITY: tap-target size (w×h of interactive nodes — flag < 44px, hard-flag < 24px), presence of a :focus-visible outline (report.signals.usesFocusVisible; outlineWidth at rest), aria/role on custom/non-native interactive elements (signals.usesAria), text contrast below AA 4.5 for normal-size text, and reduced-motion handling if animated (signals.respectsReducedMotion/definesAnimation).' },
  { key: 'kit', brief: 'KIT CONSISTENCY: does the source REUSE ui-kit primitives (Btn, Chip, Field, Banner, Card…) or hand-roll equivalents? Are radius / padding / font-scale consistent with the rest (compare borderRadius + padding + fontSize across nodes)? Flag hardcoded colours in the source (report.signals.hardcodedColorsInSource) and any reinvented control that a kit primitive covers.' },
  { key: 'polish', brief: 'POLISH & ROBUSTNESS: spacing rhythm + alignment, radius consistency, overflow/truncation risk for long text, empty-state handling, and anything that would look unfinished. Concrete, not vibes.' },
];
const reviews = await parallel(LENSES.map(L => () =>
  agent(`You are an ADVERSARIAL design reviewer. Find what is WRONG with this component through ONE lens. Default to reporting a concern when unsure; cite the concrete value from the report as evidence. If the component is genuinely clean on this lens, return an empty findings array — do not invent issues.\n\nLENS — ${L.brief}\n\n${CONTEXT}`,
    { label: `lens:${L.key}`, phase: 'Critique', schema: FINDINGS })
    .then(r => ({ lens: L.key, findings: (r && r.findings) || [] }))));

const raw = reviews.filter(Boolean).flatMap(r => r.findings.map(f => ({ ...f, lens: r.lens })));
log(`${LENSES.length} lenses produced ${raw.length} candidate findings`);

phase('Verify');
const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    verified: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, severity: { type: 'string', enum: ['high', 'med', 'low'] },
        lens: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' },
      }, required: ['title', 'severity', 'lens', 'evidence', 'fix'],
    } },
    dropped: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'] } },
    verdict: { type: 'string', description: 'one-paragraph overall judgement of the component' },
  }, required: ['verified', 'dropped', 'verdict'],
};
const verified = await agent(
  `You are the skeptical EDITOR consolidating an adversarial design review. For EACH candidate finding, check its evidence against the render report facts below: keep it only if the cited value is actually present and the concern is real and actionable; DROP duplicates (merge overlapping ones, keeping the clearest) and anything unsupported or contradicted by the report (record why in "dropped"). Re-rank by real user impact. Then write a one-paragraph verdict.\n\n${CONTEXT}\n\nCANDIDATE FINDINGS:\n${JSON.stringify(raw, null, 2)}`,
  { label: 'verify:editor', phase: 'Verify', schema: VERDICT });

return { component: COMPONENT, summary: rendered.summary, screenshots: `/tmp/theme-review/${COMPONENT}/{dark,light}.png`,
  verdict: (verified && verified.verdict) || '', findings: (verified && verified.verified) || [], dropped: (verified && verified.dropped) || [], rawCount: raw.length };
