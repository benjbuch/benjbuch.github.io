'use strict';
/* Pinned deliberately. The console warning "The WebAssembly exception handling 'try'
   instruction is deprecated ... use 'try_table' instead" comes from THIS binary, not from
   anything we compile; the legacy opcode still executes and the warning is soft. Do not chase
   it by bumping: as of 2026-07-25 duckdb-wasm publishes `latest` as a -dev prerelease
   (1.33.1-dev57.0, `next` 1.33.1-dev61.0), so there is no stable release above 1.29.0 to move
   to, and a bump would put the site's whole query engine on an unverified prerelease to silence
   a cosmetic message. Revisit when a non-dev 1.3x ships.
   (Written as a JS block comment: HTML-style comment markers are a SyntaxError inside a
   module script, and they also flip the HTML parser into script-data-escaped state.) */
// NOT A STATIC IMPORT [BB 2026-09-23]. `import * as duckdb from …` at the top of this module
// meant NOTHING below it could run until the CDN had delivered the whole graph — the +esm entry,
// apache-arrow, flatbuffers and tslib: five fetches, three levels deep, 61 KB brotli — so on a
// slow connection the chips, the atlas and the menus sat inert while a module that only the
// query engine needs was still arriving; and a blocked CDN (seen 2026-07-29) aborted the module
// and took the page down with it. The engine is loaded by initDuckDB() in duckdb.js with a
// dynamic import(), so the page wires itself the moment parser2.js is in, and an engine that
// cannot load reports itself in the field instead of killing everything. The <link
// rel="modulepreload"> in the head keeps the download starting early; this constant and that
// href must name the same version.
const DUCKDB_ESM = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';
let duckdb = null;

// URLs resolved by Jekyll at build time. Every parquet URL carries a ?v=<content hash>
// cache-buster (docs/_data/assets.yml, one stamp per file, written by `make docs`): DuckDB-WASM
// fetches each file once and the browser HTTP-caches it, so without a stamp a rebuilt table is
// served stale until a hard reload — and with the build CLOCK as the stamp (until 2026-09-22)
// every deploy refetched every table. A file's URL now changes exactly when its bytes do.
const stamped = (path, key) => new URL(path + '?v=' + key, document.baseURI).href;
const PROTEINS_URL = stamped('/nucleosomekb/data/proteins.parquet', '1de3b813e46c');
const MASSES_URL = stamped('/nucleosomekb/data/residue_masses.parquet', 'bf2e8fabc7a5');
const PTM_URL = stamped('/nucleosomekb/data/ptm_deltas.parquet', '2b4f22337b21');
const WATER_URL = stamped('/nucleosomekb/data/water_mass.parquet', '1228c733ea8f');
const PROTEIN_MASSES_URL = stamped('/nucleosomekb/data/protein_masses.parquet', 'fd3fcb702f69');
const LOOKUP_URL = stamped('/nucleosomekb/data/measurement_lookup.parquet', 'b46d611d3312');
const MEASUREMENTS_URL = stamped('/nucleosomekb/data/measurements.parquet', '5da89a1d3e86');
// Third table of the measurements middle layer (specs/2026-07-24-measurements-middle-layer.md):
// per-particle config for the three-tier query. LOOKUP_URL/MEASUREMENTS_URL above are now the
// three-table shape (column superset), read unchanged by the existing views + matcher.
const CONFIG_URL = stamped('/nucleosomekb/data/measurement_config.parquet', '830d336019ea');
// AlphaMissense, pre-joined and on its own (create_measurements_v2.R): fetched on the first
// position query, not at boot — see LAYERS.alpha_missense in query-engine.js.
const ALPHA_MISSENSE_URL = stamped('/nucleosomekb/data/measurement_alpha_missense.parquet', 'c8794359008f');
const TIER1_MENTIONS_URL = stamped('/nucleosomekb/data/literature_mentions.parquet', 'd7a3da19898e');
const TIER1_PAPERS_URL = stamped('/nucleosomekb/data/literature_papers.parquet', 'bbf1506ad775');
const TIER1_DESCRIPTORS_URL = stamped('/nucleosomekb/data/literature_descriptors.parquet', '3fc0a87a8feb');
// Reading effort behind the literature artifact, inlined by Jekyll from _data/literature.yml.
// Shown ONLY when Further reading is empty: "no records" must not read as "not studied".
const LITERATURE_COVERAGE = {
  fullText: 155,
  abstracts: 2288,
  publications: 43051,
  from: 1996,
  to: 2026,
};
const SVG_URL          = '/nucleosomekb/assets/img/nucleosome_topview.svg';
// The cartoon's baked geometry (see scripts/build_sprite_atlas.js). SVG_URL is still used by the
// legacy diagram.js; the units bar reads the atlas instead and never fetches the sprite.
const ATLAS_URL        = '/nucleosomekb/data/sprite-atlas.json';
// The same particle drawn from the side. One file per projection — see build_sprite_atlas.js.
const ATLAS_URL_SIDE   = '/nucleosomekb/data/sprite-atlas-side.json';

// Shared mutable state (referenced by all included modules below).
let db        = null;
let lastKey   = null;
let cachedSvg = null;

// engine-notices FIRST: render.js and query-engine.js call into it, and it must not depend on
// shell.js. It also owns escapeHtml, which everything below uses.
// docs/_includes/js/engine-notices.js
// The engine self-check and the #enginewarn channel, extracted from shell.js on 2026-08-15
// (U2 of specs/2026-08-13-shell-seams.md).
//
// NOT a `*-model.js`, and it should not pretend to be one. This writes DOM and there is no pure half
// to peel off — it is a PANEL. What makes it a seam anyway is that it is the only block in shell.js
// with no coupling to that file's mutable state at all: it reads `window.__PARSER2_EXPECTED`,
// `window.__loadErrors`, `nucleosomeParser2` and two element ids, and nothing else.
//
// IT LOADS EARLY, BEFORE `render.js`. `engineNotice` is called from render.js and
// `reportQueryFailure` from query-engine.js; both were upward calls into shell.js that worked only
// because the page inlines everything into one scope. Declared here and exported onto `globalThis`,
// they are ordinary calls that resolve the same way from any of the three files.
//
// `escapeHtml` CAME ALONG, and that is a decision worth stating. It is declared once, here, and
// exported — shell.js's other ~23 calls resolve to this one. It could not stay behind: this module
// must not depend on shell.js (that is the whole point of loading before it), and a private copy
// would be a second HTML escape on a page that should have exactly one.
//
// `stampEngine` is EXPORTED AND NOT SELF-INVOKING. As an IIFE inside shell.js it ran at that point in
// the include sequence; called from the same point, the page's boot order is unchanged. Moving the
// module earlier must not also move when the stamp is painted — that would be a second change riding
// along inside a refactor, and the screenshot diff would be reporting two things at once.
(function (root) {
  'use strict';

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const engine = () => (typeof root.nucleosomeParser2 !== 'undefined' ? root.nucleosomeParser2 : null);

  // `adaptToLegacy` was in this list until 2026-08-05. It was the v2→v1 IR bridge; its stated
  // consumers (match.js, ir-interpret.js) were deleted on 2026-07-26, so the self-check was asserting
  // the presence of a translation into a shape nothing read — and that assertion is what kept two dead
  // modules in the bundle.
  const V2_SYMBOLS = ['parse', 'lift2', 'resolve2', 'meet2', 'interpret3', 'canon2'];

  // Is the loaded bundle the one this page was built against? The alarm's original test — "is v2 absent
  // or does it throw" — cannot see a STALE copy: docs/assets/js/parser2.js is refreshed only by
  // `make docs`, so a `make parse2` without it leaves an older engine that loads and runs perfectly and
  // answers with superseded code. That silence cost a full round trip on 2026-07-25 ("show more" could
  // not appear because the served interpret2 still sliced at 24). The build id travels in the bundle;
  // the expected id is inlined from _data/engine.yml, which Jekyll re-reads from source on every render.
  function engineStale() {
    const want = (typeof root.window !== 'undefined' && root.window) ? root.window.__PARSER2_EXPECTED : null;
    const P2 = engine();
    if (!want || !P2) return null;                       // nothing to compare — not a staleness verdict
    const got = P2.BUILD_ID || null;
    return (got === want) ? null : { want, got };
  }

  function engineStatus() {
    const P2 = engine();
    // THE ENUMERATOR THIS ASKS FOR IS `interpret3` (2026-08-05). It asked for `interpret2`, and
    // deleting that would have flipped `hasV2` false on a working engine — a permanent
    // 'v1 fallback active' banner over a page that runs fine. Second time in one sweep that an
    // ASSERTION, not a caller, was what kept a symbol alive.
    const hasV2 = !!P2 && typeof P2.interpret3 === 'function';
    const present = P2 ? V2_SYMBOLS.filter(s => typeof P2[s] === 'function') : [];
    const missing = P2 ? V2_SYMBOLS.filter(s => typeof P2[s] !== 'function') : V2_SYMBOLS.slice();
    const stale = engineStale();
    return {
      ok: hasV2 && !stale, present, missing, loaded: !!P2, stale,
      errors: ((typeof root.window !== 'undefined' && root.window) ? root.window.__loadErrors : null) || [],
      label: !hasV2 ? (P2 ? 'engine v1 — parser2.js loaded but INCOMPLETE' : 'engine v1 — parser2.js did not load')
           : stale ? `engine v2 — STALE bundle (${stale.got || 'unstamped'} ≠ ${stale.want})`
                   : `engine v2 (interpret3) · ${(P2 && P2.BUILD_ID) || 'unstamped'}`
    };
  }

  // The evidence block shared by both alarm paths: how far the bundle got, and what threw.
  function engineDetailHtml(st) {
    const errs = st.errors.length
      ? st.errors.map(e => `<span class="err">${escapeHtml(e.src)}:${e.line}:${e.col} — ${escapeHtml(e.msg)}`
          + (e.stack ? `<br>&nbsp;&nbsp;${escapeHtml(e.stack)}` : '') + '</span>').join('<br>')
      : '<span class="hint">no load-time error captured</span>';
    return `<br><span class="hint">nucleosomeParser2: ${st.loaded ? 'loaded' : 'MISSING'}`
      + ` · present: ${escapeHtml(st.present.join(', ') || '(none)')}`
      + ` · missing: ${escapeHtml(st.missing.join(', ') || '(none)')}</span>`
      + `<br>${errs}`;
  }

  // ── #enginewarn is ONE CHANNEL WITH SEVERAL NOTICES (2026-08-08) ───────────────────────────────
  // It had four writers and every one of them ASSIGNED innerHTML, so whichever fired last was the only
  // thing the reader ever saw. A stale bundle plus a failed query showed as a failed query alone — and
  // the stale bundle is the likelier CAUSE of the failure, erased by its own symptom.
  //
  // So notices are appended, and KEYED: a key replaces its own previous notice and leaves the others
  // standing. Keys are not optional bookkeeping — a query that fails on every keystroke would otherwise
  // append a notice per keystroke.
  //
  // TWO LIFETIMES, which is what appending forces you to decide. A build fact (stale bundle, missing
  // interpret3) is true until the page is reloaded. A query fact (this query threw, this SQL errored) is
  // true only of the query that produced it, so it carries `data-scope="query"` and `clearQueryNotices`
  // drops it when a new query starts. Without that half, appending just accumulates the last hour's
  // failures underneath the current answer, which is worse than overwriting them.
  function engineNotice(key, html, scope) {
    const el = root.document.getElementById('enginewarn');
    if (!el) return;
    let item = el.querySelector('[data-warn="' + key + '"]');
    if (!item) {
      item = root.document.createElement('div');
      item.className = 'warnitem';
      item.setAttribute('data-warn', key);
      if (scope === 'query') item.setAttribute('data-scope', 'query');
      el.appendChild(item);
    }
    item.innerHTML = html;
    el.hidden = false;
  }

  // Called at the top of every input, so a query's alarms belong to the query on screen. Build-scoped
  // notices survive; the element re-hides only once nothing is left in it.
  function clearQueryNotices() {
    const el = root.document.getElementById('enginewarn');
    if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('[data-scope="query"]'), (n) => n.remove());
    if (!el.children.length) el.hidden = true;
  }

  // Paint the fallback alarm. Called from the interpretWorlds() catch, so ANY v2 failure is visible on
  // the page rather than buried in console.warn — the whole point of the 2026-07-24 diagnosis.
  function reportEngineFallback(str, e) {
    const st = engineStatus();
    engineNotice('engine-fallback',
      '<b>V1 fallback active</b> — the v2 engine (interpret3) failed for '
      + `<code>${escapeHtml(str)}</code>. World counts and materials below are v1 output and may be wrong.`
      + `<br><span class="err">${escapeHtml(e && e.name || 'Error')}: ${escapeHtml(e && e.message || String(e))}</span>`
      + `<br><span class="hint">${escapeHtml(st.label)}</span>`
      + engineDetailHtml(st), 'query');
  }

  // A failed DuckDB query, surfaced. Same reasoning as the engine-fallback alarm above: the worker's
  // RuntimeError arrives as an uncaught promise rejection with a stack pointing only at
  // async_bindings.ts, so without this the page just renders an empty panel and says nothing.
  function reportQueryFailure(detail, sql, params) {
    console.error('duckdb query failed:', detail, '\nSQL:', sql, '\nparams:', params);
    engineNotice('query-failed',
      '<b>Data query failed</b> — a panel below is empty because its query errored, not '
      + 'because no data matched.'
      + `<br><span class="err">${escapeHtml(detail)}</span>`
      + `<br><span class="hint">${escapeHtml(String(sql).replace(/\s+/g, ' ').slice(0, 300))}</span>`, 'query');
  }

  // Fill the build stamp; flag the whole page when v2 never loaded at all. Called from shell.js at the
  // point its IIFE used to run, so nothing about WHEN this happens changed with the move.
  function stampEngine() {
    const st = engineStatus();
    const el = root.document.getElementById('engine-stamp');
    if (el) { el.textContent = st.label; el.className = st.ok ? 'ok' : 'bad'; }
    // A stale bundle needs its OWN message: v2 is present and working, it is simply not the v2 this page
    // was built against, so every "the engine failed" phrasing would be a lie and would send the reader
    // looking for a crash that never happened.
    // Build-scoped, both of them: no query can make either true or false, so they stay up until the
    // page is reloaded and a query alarm appended below them does not displace them.
    if (st.stale) {
      engineNotice('engine-stale',
        '<b>Stale engine bundle</b> — <code>assets/js/parser2.js</code> is not the build '
        + 'this page expects. It loads and runs, so nothing errors; the answers are just from '
        + 'superseded code.'
        + `<br><span class="err">loaded ${escapeHtml(st.stale.got || 'unstamped')} · expected ${escapeHtml(st.stale.want)}</span>`
        + '<br><span class="hint">run <code>make docs</code> (the bundle is a copy; <code>make parse2</code> alone does not refresh it), then hard-reload.</span>');
      return;
    }
    if (!st.ok) {
      // Two very different causes, distinguished by whether the bundle registered its EARLIER symbols:
      // a genuinely stale/absent file, versus a load-time throw that truncated a current one.
      const cause = st.loaded && st.present.length
        ? 'parser2.js loaded but stopped part-way — a module threw during load, so everything after it '
          + '(including interpret3) never registered. The captured error is below.'
        : 'parser2.js did not load or defines nothing — a stale cache, a 404, or a syntax error.';
      engineNotice('engine-missing',
        '<b>V1 fallback active</b> — <code>nucleosomeParser2.interpret3</code> is not a '
        + `function. ${cause} Every world count on this page is v1 output.`
        + engineDetailHtml(st));
    }
  }

  const api = { escapeHtml, V2_SYMBOLS, engineStale, engineStatus, engineDetailHtml,
                engineNotice, clearQueryNotices, reportEngineFallback, reportQueryFailure, stampEngine };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/notation-canon.js
// The query IR's readers, and the canonical string the page says out loud. Extracted from shell.js
// on 2026-08-15 (U3 and U4 of specs/2026-08-13-shell-seams.md).
//
// THE MAP HAD THESE AS TWO UNITS AND THEY ARE ONE. `captionRecanon` (U3, the elision's self-check)
// calls `emitCanon` (U4), and `emitCanon` is required to stay private with exactly two callers —
// which is a claim about who can reach it, so cutting either half first would have forced it either
// through a host or out through an export, and the privacy would have gone back to being a
// convention held up by a grep. Cut together it is a genuine module private: no name resolves to it
// from outside this file, and the gate in `notation-style.test.js` now asserts that of every other
// module, shell.js included.
//
// The stack is unchanged — see docs/CLAUDE.md, which states it as the boundary it is:
//
//   emitCanon(ir, opts)        private. canon2 → [abstract2] → emit2. The raw canonical string.
//   canonNotation(irOrStr)     WHAT to say — the refusal guards, the wild-type fill elision, and
//                              the check that proves the elision did not change the subject.
//   styleNotation(irOrStr)     HOW to spell it. It lives in notation-style.js, and it CONSUMES
//                              canonNotation, so page code has one call to make.
//
// THE QUERY LENS COMES FROM `species-lens.js`. Three functions here read `contextOverrideForQuery`,
// which decides what organism a query is read in. It arrived through an installer for one day —
// while it was declared in shell.js it could not be reached by name at all, since a shell.js
// declaration is lexical to the page's one module scope and is not on `globalThis`. U7 moved it into
// a module that exports it, so it is now reached the same way `escapeHtml` and `meetBench` are, and
// the installer and this module's one mutable both went with it.
//
// That distinction is the whole of the rule and it is easy to state backwards: a name a MODULE
// exports is a `globalThis` property and resolves fine; a name shell.js DECLARES resolves in every
// node suite and to nothing on the page. See docs/CLAUDE.md.
(function (root) {
  'use strict';

  // Read fresh on every call — the species control moves between two queries, and a memo here would
  // pin the first one. `root.` rather than a bare call, deliberately: a bare one resolves on the
  // page and throws under `require`, and five suites require this module. The guard is the honest
  // form of "the lens is not loaded", and null is what resolve2/abstract2 read as "no override".
  function contextOverrideForQuery() {
    return (typeof root.contextOverrideForQuery === 'function') ? root.contextOverrideForQuery() : null;
  }

  // ONE parse, ONE object. The v1-SHAPED tree that used to be threaded alongside is gone with its last
  // reader (Phase 5, step 5): `adaptTree2` was v2 code producing a v1 shape, and every view-model it
  // fed — the materials pane, describe(), the units bar, the cartoon — now reads the IR itself.
  //
  // `null` for an unparseable query, which is the caller's syntax branch.
  function buildQueryIR(raw) {
    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P2 || !raw || !raw.trim() || typeof P2.resolve2 !== 'function') return null;
    try {
      return P2.resolve2(P2.lift2(P2.parse(raw.trim())), contextOverrideForQuery(), P2.DEFAULT_REGISTRY);
    } catch (e) { return null; }
  }

  // The RESOLVED marks for one material card, in IDEA positions with the accession already applied.
  // Returns null when the IR cannot speak for this card, so the caller keeps its tree-derived mods
  // rather than silently losing them — a card is better stale than empty.
  // The SEGMENTS the IR states for a material, or null when it states none beyond the whole chain.
  //
  // Certainty lives here and nowhere else in the v2 IR: `[1-30]` is a defined extent, `{31-40}` a
  // native one, and `certAt` reads the certainty in force at a position off exactly this list. The
  // materials pane used to drop range marks on the floor (`shell-model.js`: `if (m.rangeEnd != null)
  // continue`) and `materialize-card.js` then FABRICATED a full-native segment — so `H3[1-30]` was
  // materialised, and drawn, as the whole of H3.
  //
  // A single full-native segment is the absence of a claim, not a claim, so it is reported as null:
  // callers can then treat "no segments" as "the whole chain" without inventing one.
  function irSegmentsFor(ir, family, variant) {
    if (!ir || ir.node === 'error' || ir.node === 'bottom') return null;
    let found = null;
    (function walk(n) {
      if (found || !n || typeof n !== 'object') return;
      if (n.node === 'proteoform') {
        if (n.family !== family) return;
        if (variant != null && !(n.variant || []).includes(variant)) return;
        const segs = n.segments || [];
        const whole = segs.length === 1 && segs[0].start === '-inf' && segs[0].end === '+inf'
                   && segs[0].certainty === 'native';
        if (segs.length && !whole) found = segs.map((x) => Object.assign({}, x));
        return;
      }
      (n.members || []).forEach(walk);
    })(ir);
    return found;
  }

  function irMarksFor(ir, family, variant) {
    if (!ir || ir.node === 'error' || ir.node === 'bottom') return null;
    const out = [], seen = new Set();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.node === 'proteoform') {
        if (n.family !== family) return;
        if (variant != null && !(n.variant || []).includes(variant)) return;
        // THE CARD IS LABELLED WITH THE TOKEN, so the marks must be in the token's numbering. A pinned
        // copy stores the number as WRITTEN — in its own molecule's numbering (R9) — and this card
        // says `H2B.1`, which also covers molecules numbering that site one lower. Restate it here,
        // through the engine's one implementation.
        const P0 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
        const mm = (P0 && P0.renumberForToken)
          ? P0.renumberForToken(n, variant != null ? variant : family, n.modifications || [])
          : (n.modifications || []);
        mm.forEach((m) => {
          const k = m.position + '|' + (m.substitution ?? '') + '|' + (m.modification ?? '') + '|' + !!m.negated;
          if (seen.has(k)) return;
          seen.add(k);
          out.push(m);
        });
        return;
      }
      (n.members || []).forEach(walk);
    })(ir);
    return out;
  }

  // CANON = emit2(abstract2(canon2(ir))) (BB, 2026-07-25).
  //
  // The abstract step is not a workaround for emit2's refusal, it is what a canonical form MEANS
  // here. Canon is the IDEA; an accession is the material the idea was reached through, so dropping
  // it is the last thing you do before writing the idea down. Without it every material-handled query
  // read "(no faithful notation for this construct)" — emit2 correctly refuses an accession-pinned
  // node, since `Q96A08` re-lifts to family null and `H2B.1` would drop the accession, so there is
  // nothing truthful to write. Abstract first and the question does not arise.
  //
  // It also makes the canonical form do the job a canonical form is for — two spellings of one idea
  // converge, including across the frame:
  //
  //   H2B1A:K121ub   ->  H2B.1:K121ub      material handle + its own numbering
  //   P02294:K123ub  ->  caH2B:K120ub      the yeast lysine, named in the idea layer
  //   HIST1H3A:K27M  ->  H3.1:K27M         a gene handle
  //
  // The first line stopped crossing a frame on 2026-08-24: H2B.1 holds only TSH2B since the two
  // bulk H2B that HistoneDB's H2B.1 model had captured became caH2B, so the token's reference is
  // Q96A08 and 121 is already its own number. The YEAST line is the frame-crossing example now.
  //
  // Every one of those round-trips (lift2(parse(s)) deep-equals the node), which the emit2 contract
  // requires and the accession-pinned form could never satisfy.
  // The canonical node for an IR — canon2 with the set/⊥ cases resolved. `canonNotation` emits from
  // exactly this, and the materials pane is built from its members, so the notation under the cartoon
  // and the cards beside it describe one object.
  function canonNode(ir) {
    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P2 || !ir || typeof P2.canon2 !== 'function') return null;
    try {
      const c = P2.canon2(ir);
      const n = Array.isArray(c) ? c[0] : c;
      return (!n || n.node === 'bottom' || n.node === 'error') ? null : n;
    } catch (e) { return null; }
  }

  // `material: true` writes the node on its OWN molecules instead of abstracting to the idea layer —
  // the mnemonic (or gene, or accession) and that molecule's own numbering, via emit2's registry mode.
  // A MEASURED datum is displayed this way (BB, 2026-07-29): the number a measurement was made at is a
  // fact about the material it was made on, and restating yeast K123 as K120 to match a human-framed
  // query produces a label no source would recognise. Relevance is settled separately, on idea
  // coordinates, by entails2 — which is what lets the two frames coexist without either one moving.
  function emitCanon(ir, opts) {
    const material = !!(opts && opts.material);
    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P2 || !ir || typeof P2.canon2 !== 'function') return null;
    try {
      const c = P2.canon2(ir);
      const n = Array.isArray(c) ? c[0] : c;
      if (!n || n.node === 'bottom') return '⊥ — no consistent form';
      const many = Array.isArray(c) && c.length > 1 ? ` (+${c.length - 1} more)` : '';
      if (material) {
        // No abstract2: the accessions are the point. emit2 falls back to refusing a pinned copy it
        // cannot spell, and the caller then shows the deposited string, which is still true.
        const e = (typeof P2.emit2 === 'function') ? P2.emit2(n, P2.DEFAULT_REGISTRY) : null;
        return e == null ? '(no exact notation for this)' : e + many;
      }
      const abstracted = (typeof P2.abstract2 === 'function')
        ? P2.abstract2(n, contextOverrideForQuery(), P2.DEFAULT_REGISTRY) : n;
      const e = (typeof P2.emit2 === 'function') ? P2.emit2(abstracted) : null;
      return e == null ? '(no exact notation for this)' : e + many;
    } catch (e) { return '(no canonical form — ' + (e && e.message ? e.message : e) + ')'; }
  }

  // The ACCESSION the IR resolved for a card, or null. Same reasoning as `irMarksFor`: the card was
  // asking a second resolver (the DuckDB realization lookup) for something the canonical IR already
  // knows, and the two do not always agree — `H2B1A` is an entry name shared by mouse P70696 and
  // human Q96A08, so the token pins no species and that lookup returns family/variant only, by its own
  // contract. `resolve2`'s classify IS context-aware, so the IR has the answer: Q96A08. Without this
  // the pane showed every human H2B.1 for a query that named ONE molecule.
  // The species this query NAMES, via any accession its materials resolved to, or null when it names
  // none. One taxon only: a query that names two materials from different organisms is not asking to
  // be looked at through either lens, so it moves nothing.
  function queryTaxon(ir) {
    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    const reg = P2 && P2.DEFAULT_REGISTRY;
    if (!reg || typeof reg.taxonOfAccession !== 'function' || !ir || ir.node === 'error') return null;
    const found = new Set();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.node === 'proteoform') {
        (n.accession || []).forEach((a) => { const t = reg.taxonOfAccession(a); if (t != null) found.add(t); });
        return;
      }
      (n.members || []).forEach(walk);
    })(ir);
    return found.size === 1 ? [...found][0] : null;
  }

  function irAccessionFor(ir, family, variant) {
    if (!ir || ir.node === 'error' || ir.node === 'bottom') return null;
    let found = null;
    (function walk(n) {
      if (found || !n || typeof n !== 'object') return;
      if (n.node === 'proteoform') {
        if (n.family !== family) return;
        if (variant != null && !(n.variant || []).includes(variant)) return;
        if (Array.isArray(n.accession) && n.accession.length) found = n.accession.slice();
        return;
      }
      (n.members || []).forEach(walk);
    })(ir);
    return found;
  }

  // The cartoon's caption, derived the SAME way as the inspector's Canon line (BB, 2026-07-25).
  //
  // It used to be built by `unitCaption`, a separate walk over the v1 parse subtree with its own
  // bracket rules — a third opinion about how to write a particle down, next to emit2 and the panel.
  // It also showed only the STATED slots, so `(H3:K27M)` read "(H3K27M)" while the engine, the tile
  // view and the material cards had all along been talking about a completed octamer.
  //
  // So: canon, plus the embellishments that make it a caption rather than notation — `·` for `@`, and
  // real subscript digits after a bracket. Nothing is re-derived; the difference between the caption
  // and the Canon line is now purely typographic.
  const CORE_FAMS = ['H3', 'H4', 'H2A', 'H2B', 'H1'];

  // Split a particle body on TOP-LEVEL `@` only — a co-bracket carries its own separators
  // (`[H2A@H2B]0` is one term, not two).
  function splitTerms(body) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '[' || ch === '{' || ch === '(') depth++;
      else if (ch === ']' || ch === '}' || ch === ')') depth--;
      if (ch === '@' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // A term the caption can drop: a bare wild-type COMPLETION fill. It carries no mark, names no
  // variant, and is not an absence — so it says only "this family is present in its usual number",
  // which the cards already show and the cartoon already draws.
  //
  // Elision is conditional on there being something to elide FOR. A tetrasome `(H3@H4@{H2A}0@{H2B}0)`
  // is all wild-type; dropping its fills would leave "({H2A}₀ · {H2B}₀)", a caption about what is
  // missing from a particle it no longer names. So terms are only dropped when at least one other
  // term is informative — a mark or a variant.
  // A `0` subscript on ANY wrapper — `{H2A}0`, `[H2A@H2B]0`, `(…)0`. The bracket class matters: the
  // co-bracket form ends in `]0`, and omitting it meant a dimer-absence was read as an ordinary term.
  function isAbsenceTerm(t) { return /[}\])]0$/.test(t); }

  function elidableTerm(t) {
    if (t.indexOf(':') >= 0) return false;                 // carries a mark
    if (isAbsenceTerm(t)) return false;                    // an absence is a statement
    // Strip only a WRAPPER and the subscript that follows it. A bare trailing-digit strip would eat
    // the family's own digit — `H3` became `H`, matched nothing, and every fill survived.
    const bare = t.replace(/^[\[{(]/, '').replace(/[\]})]\d*$/, '');
    return CORE_FAMS.indexOf(bare) >= 0;                   // a plain family token = a fill
  }

  // Re-derive the canon FROM a caption string, by the same route that produced it. This is how the
  // elision below proves it did not change the subject.
  function captionRecanon(str, opts) {
    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P2 || typeof P2.parse !== 'function') return null;
    try {
      // `emitCanon`, NOT `canonNotation` — the latter elides, and this is the call that CHECKS the
      // elision. Asking it would re-enter the step being verified.
      return emitCanon(
        P2.resolve2(P2.lift2(P2.parse(str)), contextOverrideForQuery(), P2.DEFAULT_REGISTRY), opts);
    } catch (e) { return null; }
  }

  // canon2 may return a SET; `canonNotation` reports the extras as a ` (+N more)` tail. That tail is
  // prose glued to notation, and it defeated `styleNotation`'s re-parse check — so a set-valued canon
  // was captioned with raw `@` and `:` while every other caption was styled. Split it off, style the
  // notation, put it back.
  const MANY_TAIL = / \(\+\d+ more\)$/;

  // ── TWO FUNCTIONS, ONE STACKED ON THE OTHER (BB, 2026-08-07) ─────────────────────────────────────
  //
  //   emitCanon(ir)              private. canon2 → [abstract2] → emit2. The raw canonical string.
  //   canonNotation(irOrStr)     WHAT to say — guards, then the fill elision, then its self-check.
  //   styleNotation(irOrStr)     HOW to spell it — and it consumes canonNotation, so page code has
  //                              exactly one call to make and it is the styled one.
  //
  // It was three peers with a rule about which to pick; picking wrong is how `materialCell` started a
  // second display path. Now the only choice left is whether you want it styled, and the two answers
  // are one call apart.
  //
  // Both take a STRING as well as an IR, because the material cells have only a string (it comes from
  // `emitMaterial`) and there must be no reason to step around either one.
  //
  // `emitCanon` is private for a REASON, not for tidiness: `captionRecanon` above verifies the elision
  // by re-canonicalising its own output, and if that call went through `canonNotation` it would
  // re-enter the step it is checking. One name for "canonical", one for "canonical and elided".
  function canonNotation(irOrString, opts) {
    const full = (typeof irOrString === 'string') ? irOrString : emitCanon(irOrString, opts);
    // A refusal or a ⊥ verdict is prose, not notation — leave it to the caller's fallback. The
    // `no canonical form` branch is `canonNotation`'s own catch, and it was NOT listed here: an engine
    // error message starting with `(` passed every guard and was rendered as notation, with a copy
    // button attached.
    if (!full) return null;
    if (full.indexOf('no exact notation') >= 0 || full.indexOf('no canonical form') >= 0
        || full.charAt(0) === '\u22a5') return null;
    if (!/^[(\[{]/.test(full) && full.indexOf(':') < 0 && !/^[A-Za-z]/.test(full)) return null;

    const tail = (full.match(MANY_TAIL) || [''])[0];
    const s = tail ? full.slice(0, -tail.length) : full;

    // Elide wild-type fills inside each particle, leaving anything outside (linkers, array
    // structure) untouched.
    const trimmed = s.replace(/([(\[{])([^()\[\]{}]*(?:[(\[{][^()\[\]{}]*[)\]}][^()\[\]{}]*)*)([)\]}])(\d*)/g,
      (m, open, body, close, sub) => {
        const terms = splitTerms(body);
        if (terms.length < 2) return m;
        // AN ABSENCE ANYWHERE STOPS THE ELISION (BB). Once a particle is missing something, its
        // composition is the thing being said, and every present copy is part of that statement — a
        // hexasome or a marked tetrasome needs its whole complement on screen to be readable.
        // Eliding the unmarked-but-PRESENT copies would turn `(H3:K27M@{H2A}0@{H2B}0)` into
        // "(H3:K27M · {H2A}₀ · {H2B}₀)", which drops the H4 that is there and reads as if only the
        // mark and the holes mattered.
        if (terms.some(isAbsenceTerm)) return m;
        const kept = terms.filter((t) => !elidableTerm(t));
        const informative = terms.some((t) => t.indexOf(':') >= 0 || !elidableTerm(t));
        if (!informative || !kept.length) return m;
        return open + kept.join('@') + close + sub;
      });

    // ── THE ELISION MUST PROVE ITSELF (BB, 2026-08-06) ─────────────────────────────────────────────
    // What it drops is a COMPLETION FILL — a copy the engine ADDED when completing a particle — so the
    // caption stays faithful because re-completing it puts the fill back. That premise holds inside
    // `(…)` and nowhere else, and the rule above could not tell the difference: in a bare co-bracket
    // group NOTHING was completed, so every term is a member the writer stated. `H2A.Z@H2B` was
    // captioned `{H2A.Z}` — a different molecule, on the one string a reader can copy and take away.
    // `H1` had the same defect by another route (it is in CORE_FAMS but is never a fill, so a
    // chromatosome captioned as a nucleosome), and `[H2B]2` → `{H2B}2` downgraded a stated exact
    // certainty to a native one.
    //
    // THAT LAST CLAUSE USED TO CARRY A SCALE — "across 461 of the 468 shipped measurement
    // descriptors" — and the number is REMOVED rather than re-measured [BB 2026-08-08]: it counts a
    // v1-era notion of a "shipped descriptor" that no longer exists. No constructible denominator
    // reproduces 468 (the nearest today are 294 distinct non-AM `entry_key`, 256 descriptors across
    // the container CSVs), so any replacement would be a different quantity wearing the old sentence.
    // The defect is the point and it stands without a count.
    //
    // Rather than enumerate where completion happened — which is a fact about the engine this string
    // no longer carries — the elision CHECKS ITS OWN WORK, exactly as `styleNotation` does one step
    // later: re-canonicalise the elided form and require it to land on the canon it came from. That is
    // the invariant `canon-caption.test.js` already states in prose, now enforced where it is decided.
    // Three defect classes, one guard, and no change to `elidableTerm` or the regex.
    //
    // `styleNotation`'s own check could not have caught any of this — it is handed `trimmed`, so it
    // compares the elided string against itself.
    const faithful = trimmed === s
                  || (captionRecanon(trimmed, opts) || '').replace(MANY_TAIL, '') === s;
    return (faithful ? trimmed : s) + tail;
  }

  // NOT exported, and that is the point of the unit: `emitCanon` and `captionRecanon`. The raw
  // canonical string and the wrapper that re-derives it are reachable only from inside this file. A
  // third caller of `emitCanon` either bypasses the elision or re-enters the step that verifies it,
  // and neither announces itself; `captionRecanon` takes a string and hands back the unelided canon,
  // so exporting it would be the same bypass by proxy. `CORE_FAMS` and `MANY_TAIL` stay in for no
  // stronger reason than that nothing outside asks for them.
  //
  // The three term predicates DO go out. They are pure string tests with no bearing on the privacy
  // rule, and `canon-caption.test.js` asserts each of them by name — `elidableTerm('{H2A}0')` is
  // false because an absence is a statement, and there is no way to ask that through `canonNotation`
  // without also asking nine other things. Keeping them in would have traded real coverage for a
  // tidier export list.
  const api = { buildQueryIR, irSegmentsFor, irMarksFor, canonNode,
                queryTaxon, irAccessionFor, canonNotation,
                splitTerms, isAbsenceTerm, elidableTerm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// notation-style.js — ONE function decides how notation LOOKS on this page.
//
// The engine's canonical string keeps its separators: `H3:K27M,K5ac`, `@` between members. That form
// is the interface — it is what a chip inserts, what the copy button hands over, what `canon2`/
// `emit2` round-trip, and what every reviewed claim asserts. NOTHING HERE CHANGES IT.
//
// What the reader SEES is a style laid on top: `H3K27MK5ac`. The two used to be one string, so
// making the display more idiomatic meant making the canon less exact, and the choice was posed as
// if it had to be one or the other. It does not — it needs a styler, and a styler is only safe if
// there is exactly one of it. Two would drift, and a caption that disagrees with a material card
// about how to write the same molecule is worse than either style alone.
(function (root) {
  'use strict';

  // The registry's own token sets, via the generated catalogue (registry/vocabulary.yaml →
  // docs/assets/js/messages.js). Resolved the same two ways shell-model.js resolves it: inlined into
  // the page, where the <script> has already run, and `require`d by the node suites, where it has not.
  const MSG = (typeof MESSAGES !== 'undefined' && MESSAGES) ? MESSAGES
            : (typeof require === 'function' ? require('../../assets/js/messages.js') : {});
  const TOK = (MSG && MSG.tokens) || {};
  const IDEA_TOKENS = new Set([].concat(TOK.family || [], TOK.variant || []));

  const SUBDIGITS = ['₀', '₁', '₂', '₃', '₄',
                     '₅', '₆', '₇', '₈', '₉'];

  // The colon separates a family/variant token from its marks, and THERE it is redundant — `H3K27M`
  // is the same molecule said more briefly. After an entity handle it is not: "a number after a
  // family/variant token is an IDEA position; after an entity handle it is read in THAT molecule's
  // numbering". So membership decides, not the shape of the token — `Cse4` looks like a gene symbol
  // and is a variant spelling, `H2B1A` looks like a variant and is a handle.
  function isIdeaToken(t) { return IDEA_TOKENS.has(t); }

  // ── THE GUARANTEE: STYLE, NEVER TRANSLATION (BB, 2026-08-06) ────────────────────────────────────
  // Every rule below is a shortening the grammar accepts, so a styled string should mean exactly what
  // it was made from. "Should" is not good enough. `H3:F3A` styles to `H3F3A`, which is a GENE — the
  // shortening quietly names a different molecule, and the page would be printing a claim the engine
  // never made.
  //
  // Rather than enumerate the collisions (the handle list is 592 long and embedding it would be a
  // fourth derivation of the same set, free to disagree with the other three), THE STYLER CHECKS ITS
  // OWN WORK: parse the styled form back, and if it is not the same tree, hand over the canonical
  // string untouched. That covers every collision class, including ones nobody has thought of, and it
  // fails to the exact form the engine writes rather than to a guess.
  //
  // The comparison is on the LIFTED tree, which takes no context and no registry — so styling is a
  // pure function of the string and cannot vary with the organism lens.
  const parser = () => (typeof nucleosomeParser2 !== 'undefined' && nucleosomeParser2) ? nucleosomeParser2 : null;

  function sameMeaning(styled, canonical) {
    const P = parser();
    if (!P) return false;                     // no engine, no guarantee — so no styling
    try {
      return JSON.stringify(P.lift2(P.parse(styled)))
          === JSON.stringify(P.lift2(P.parse(canonical)));
    } catch (e) { return false; }
  }

  // IR or canonical string → display, or the canonical string back unchanged if the two would not
  // mean the same.
  //
  //   H3:K27M,K5ac              → H3K27MK5ac
  //   (H3:K27M@H4:K16ac)        → (H3K27M·H4K16ac)
  //   ({H3}2@{H2A}0)            → ({H3}₂·{H2A}₀)
  //   H3:F3A                    → H3:F3A            (H3F3A is a gene — kept)
  //   H2B1A:K121ub              → H2B1A:K121ub      (handle — kept)
  function styleNotation(irOrString, opts) {
    // THE PRIMARY CONSUMER OF `canonNotation` (BB, 2026-08-07). Handed an IR, this runs the WHAT —
    // guards and the fill elision, with its own self-check — and then the HOW below. Page code
    // therefore has one call to make, and the unstyled interface string is one call away rather than
    // one rule away. Handed a string, it styles that string, which is how the material cells reach
    // it (they have only `emitMaterial`'s output).
    //
    // Resolved off the global for the same reason the parser is: this module is inlined into the
    // page beside `shell.js` and `require`d bare by the node suites, where `canonNotation` is absent
    // and every existing caller passes a string anyway.
    const s = (typeof irOrString === 'string' || irOrString == null) ? irOrString
            : (typeof canonNotation === 'function' ? canonNotation(irOrString, opts) : null);
    if (s == null) return s;
    const canonical = String(s);
    let out = canonical;

    // 1. The colon, where it follows a family/variant token. A token is the run of token characters
    //    immediately left of it; `(`, `@`, `[`, `{`, `!` and the string start all end that run. Dots
    //    and hyphens are IN a token (`H3.1`, `CENP-A`), and so are spaces — twenty variant spellings
    //    contain one (`ca H3`, `sperm H2B`) — so the class is permissive and membership decides.
    out = out.replace(/([A-Za-z][A-Za-z0-9._ -]*):/g, (m, token) =>
      isIdeaToken(token) ? token : m);

    // 2. The comma between marks. It is the mod separator and nothing else in the grammar — ranges
    //    use `-`, sets use `|` — so every comma in a canonical string is one of these.
    out = out.replace(/,/g, '');

    // Checked BEFORE the typographic rules, because those two are not notation changes: `·` is an
    // accepted spelling of `@` and a subscript an accepted spelling of a count, but re-parsing a
    // string full of `₂` to prove it is work the grammar already promises. What needs proving is the
    // two rules above, which remove characters.
    if (!sameMeaning(out, canonical)) return canonical;

    // 3. `@` → `·`, tight. Members are terms in one expression, not words in a sentence.
    out = out.replace(/@/g, '·');

    // 4. A count after a closing bracket becomes a real subscript — how a count is TYPESET. The copy
    //    path undoes this, because nobody types `₂`.
    out = out.replace(/([}\])])(\d+)/g, (m, br, d) =>
      br + String(d).split('').map((c) => SUBDIGITS[+c]).join(''));

    return out;
  }

  // What a copy button hands back: the styled string with ORDINARY digits.
  //
  // The `·` STAYS — it is notation, and the grammar has always taken it. The subscripts do not: they
  // are typesetting, and nobody writes `₂` at a keyboard. Both spellings parse, so this is about what
  // is idiomatic rather than what is accepted.
  function styleForCopy(styled) {
    return String(styled == null ? '' : styled)
      .replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080));
  }

  const api = { styleNotation, styleForCopy, isIdeaToken };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ── DuckDB ────────────────────────────────────────────────────────────────

// THE BOOT STATUS IS THE FIELD'S PLACEHOLDER [BB 2026-09-23]. It was a line of its own above the
// query bar, and a line that appears before the bar and vanishes when the data is ready moves the
// whole layout at the one moment the reader has just found the field — and they had barely
// registered the line in the first place. The placeholder is where the eye already is, it is text
// the field owns, and writing into it moves nothing. The caret pulses while it reads (`.booting`
// in _shell.scss) so the state is visible even if the words are not read. A typed query is never
// overwritten: the placeholder is invisible under text, and duckdb's ready path re-runs the query.
//
// The #bootstatus element stays in the markup for the FAILURE case only — an error must not be a
// placeholder, which clears the moment someone types.
// ON A PHONE THE FIELD IS NARROW [BB 2026-09-23]: "Loading the engine and data (about 8 MB)…" was
// cut off inside it. So the state is carried by the GLYPH — the prompt caret becomes an hourglass
// while the data loads (`.qfield.booting .prompt::before`, Font APEX, in _shell.scss) — and the
// words are just "Loading…", short enough for any width. The staged counts stay in the console.
const BOOT_PLACEHOLDER = 'H3K27';
function bootStatus(text, { error = false } = {}) {
  if (typeof document === 'undefined') return;
  const input  = document.getElementById('notation-input');
  const field  = input && input.closest('.qfield');
  const el = document.getElementById('bootstatus');
  const ready = () => {
    if (input) input.placeholder = BOOT_PLACEHOLDER;
    if (field) field.classList.remove('booting');
  };
  if (error) {
    if (el) { el.textContent = text; el.hidden = false; }
    ready();
    return;
  }
  if (text == null) { ready(); if (el) el.remove(); return; }
  if (text) console.info('boot:', text);
  if (input) input.placeholder = 'Loading\u2026';
  if (field) field.classList.add('booting');
}

async function initDuckDB() {
  bootStatus('Loading the query engine…');
  // The engine module arrives HERE, not at the top of the page's module (see DUCKDB_ESM in
  // index.html): everything the page can do without a database is already wired by now.
  if (!duckdb) {
    try { duckdb = await import(DUCKDB_ESM); }
    catch (e) { throw new Error(`the query engine could not be fetched from the CDN (${e && e.message || e})`); }
  }
  const bundles = duckdb.getJsDelivrBundles();
  const bundle  = await duckdb.selectBundle(bundles);
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );
  const worker = new Worker(workerUrl);
  db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger('WARNING'), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  // Fetch parquet files and register as buffers.
  // HTTP range requests (registerFileURL) fail in Firefox on GitHub Pages,
  // so we fetch the full files up front and register them as local buffers.
  //
  // THE BOOT SET IS WHAT THE FIRST PAINT NEEDS [BB 2026-09-22]: the proteins, the masses and the
  // container layer of the measurement tables — 0.7 MB. AlphaMissense (0.45 MB, read only by a
  // position query) and the literature (3.8 MB, read only by Further reading) are registered on
  // first use through `ensureLayerFile` / `ensureLiterature` below. Before the split the boot set
  // was 2.7 MB, 2.5 MB of it AlphaMissense.
  const tables = [PROTEINS_URL, MASSES_URL, PTM_URL, WATER_URL, LOOKUP_URL, MEASUREMENTS_URL, CONFIG_URL];
  let done = 0;
  bootStatus(`Loading data… 0 of ${tables.length} tables`);
  await Promise.all(
    tables.map(async url => {
      await registerUrl(url);
      bootStatus(`Loading data… ${++done} of ${tables.length} tables`);
    })
  );

  await initLayers();
}

// One fetch per URL for the life of the page. `read_parquet('<url>')` then reads the registered
// buffer under that exact name — the same mechanism the boot set uses, so the SQL that names the
// URL is unchanged whether the file arrived at boot or on demand.
const _registered = new Map();
function registerUrl(url) {
  if (!_registered.has(url)) {
    _registered.set(url, (async () => {
      const buf = await fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} fetching ${url}`); return r.arrayBuffer(); });
      await db.registerFileBuffer(url, new Uint8Array(buf));
    })().catch((e) => { _registered.delete(url); throw e; }));
  }
  return _registered.get(url);
}

// A lazy layer (query-engine.js LAYERS[*].file): fetch the file, then create the view over it.
// Called through `layerReady`, which memoizes per layer, so the view is created once.
async function ensureLayerFile(url, viewSql) {
  await dbReady();
  await registerUrl(url);
  const conn = await db.connect();
  try { await conn.query(viewSql); } finally { await conn.close(); }
}

// The literature tables: fetched whole and registered the first time Further reading asks. They
// were read through DuckDB's own HTTP range requests before — the mechanism the boot comment above
// records as failing in Firefox on GitHub Pages, and one that re-read the 5 MB papers file for
// every count and every render. Now it is one download, and the SQL still names the URLs.
function ensureLiterature() {
  return Promise.all([TIER1_MENTIONS_URL, TIER1_PAPERS_URL, TIER1_DESCRIPTORS_URL].map(registerUrl));
}

// Single memoized readiness gate. External (user-triggered) query entry points
// await this so a query fired during page load doesn't hit an uninitialized db.
// IMPORTANT: the init-internal connection in initLayers() must NOT use this — it
// runs *inside* initDuckDB, so gating it makes init await its own completion and
// deadlocks (this was the regression that got the first fix reverted).
let _dbReady = null;
function dbReady() { return _dbReady || (_dbReady = initDuckDB()); }
async function dbConnect() { await dbReady(); return db.connect(); }

// ── Context resolution via proteins.parquet ──────────────────────────────

// Cache: contextKey → resolved context object
const contextCache = new Map();

function contextCacheKey(family, variant, overrides) {
  return JSON.stringify([family, variant, overrides]);
}

// Resolve a materialization context for a given family/variant.
// `overrides` is an optional object with: { uniprot_id, protein_name, species, taxon_id }
// Returns: { family, variant, uniprot_id, protein_name, species, taxon_id,
//            sequence, average_mw, monoisotopic_mw, n_residues, modifications }
// Returns null if no match.
async function resolveContext(family, variant, overrides = {}) {
  const key = contextCacheKey(family, variant, overrides);
  if (contextCache.has(key)) return contextCache.get(key);

  const conn = await dbConnect();
  try {
    const lookupKey = variant ?? family;
    const userOv    = contextOverrides[lookupKey] ?? contextOverrides[family] ?? {};
    // PRECEDENCE, lowest first (BB, 2026-07-29 — the YAML is the single source of context):
    //   1. the context-level default   `context: taxon_id:` — reaches families the YAML never names
    //   2. the family block            a per-family entry, which MUST beat the default
    //   3. `overrides`                 an accession the query itself named; it pins its own species
    //
    // The old order was `{...userOv, ...overrides}` with the species dropdown supplying `overrides`
    // as a call-level taxon. That made the dropdown win over anything typed in the editor: you could
    // set H3 to Xenopus, see it ignored, and have nothing tell you why. The dropdown no longer feeds
    // this path at all — it writes the YAML instead — so `overrides` is now only the accession pin.
    const defaultOv = (typeof contextDefaultOverride === 'function') ? contextDefaultOverride() : {};
    const ov        = { ...defaultOv, ...userOv, ...overrides };

    // A PINNED MATERIAL CARRIES ITS OWN SPECIES (BB, 2026-07-26: "maybe it shouldn't pin species").
    // An accession names ONE molecule, and that molecule already has a taxon; constraining taxon
    // alongside it asks the material to agree with a lens the query never put it under. `P02294`
    // (yeast H2B) resolved against `taxon_id = 9606 AND uniprot_id = 'P02294'` — zero rows, no
    // context, for a query that names a real molecule unambiguously.
    //
    // The rule was written as `ov.taxon_id ?? (pinsMaterial ? null : 9606)`, which said the same
    // thing only while the context-level default could be ABSENT. It cannot now (2026-08-07): the
    // Read-as context is stated from startup, so `ov.taxon_id` is always set and that expression
    // would rule out every pinned foreign accession. The distinction it was drawing is by LAYER, so
    // it is drawn by layer here: the context default is the reader's background lens and yields to
    // a material the query named, while a taxon stated ABOUT this material — the family block, or
    // the call — still constrains, and a human family block over a yeast accession still yields
    // nothing, which is the honest answer the walk has a word for (accession-ruled-out).
    const pinsMaterial = ov.uniprot_id != null || ov.protein_name != null;
    const aboutThisMaterial = overrides.taxon_id ?? userOv.taxon_id ?? null;
    const taxon = pinsMaterial ? aboutThisMaterial : (ov.taxon_id ?? null);

    // The variant clause is built rather than fixed, because a clade token expands to a SET (see
    // `variantSubtree`). The other five predicates keep positions $1..$5 and the set takes $6+, so
    // adding it cannot silently renumber them — the failure mode of a hand-numbered param list.
    // ORDER BY n_gene_loci DESC, uniprot_id still picks ONE representative out of the subtree,
    // which is the same rule that already chose among a clade's members.
    const vset = variantSubtree(family, variant ?? ov.variant ?? null);
    const params = [family, ov.uniprot_id ?? null, ov.protein_name ?? null, ov.species ?? null, taxon];
    let vClause = '';
    if (vset) {
      vClause = `\n          AND variant IN (${vset.map((_, i) => `$${params.length + i + 1}`).join(', ')})`;
      params.push(...vset);
    }

    const sql = `
      WITH pick AS (
        SELECT DISTINCT
          family, variant, uniprot_id, protein_name,
          species, taxon_id, n_gene_loci
        FROM read_parquet('${PROTEINS_URL}')
        WHERE family = $1
          AND ($2 IS NULL OR uniprot_id = $2)
          AND ($3 IS NULL OR protein_name = $3)
          AND ($4 IS NULL OR species = $4)
          AND ($5 IS NULL OR taxon_id = $5)${vClause}
        ORDER BY n_gene_loci DESC, uniprot_id
        LIMIT 1
      ),
      seq AS (
        SELECT
          p.uniprot_id,
          STRING_AGG(p.residue, '' ORDER BY p.protein_position) AS sequence
        FROM read_parquet('${PROTEINS_URL}') p
        JOIN pick ON p.uniprot_id = pick.uniprot_id
        WHERE p.protein_position >= 1
        GROUP BY p.uniprot_id
      ),
      mw AS (
        SELECT
          p.uniprot_id,
          SUM(rm.average)      + w.average      AS average_mw,
          SUM(rm.monoisotopic) + w.monoisotopic  AS monoisotopic_mw,
          COUNT(*)                               AS n_residues
        FROM read_parquet('${PROTEINS_URL}') p
        JOIN pick ON p.uniprot_id = pick.uniprot_id
        JOIN read_parquet('${MASSES_URL}') rm ON p.residue = rm.residue
        CROSS JOIN read_parquet('${WATER_URL}') w
        WHERE p.protein_position >= 1
        GROUP BY p.uniprot_id, w.average, w.monoisotopic
      )
      SELECT
        pick.*,
        seq.sequence,
        mw.average_mw,
        mw.monoisotopic_mw,
        mw.n_residues
      FROM pick
      JOIN seq ON pick.uniprot_id = seq.uniprot_id
      JOIN mw  ON pick.uniprot_id = mw.uniprot_id`;

    const stmt = await conn.prepare(sql);
    const result = await stmt.query(...params);
    await stmt.close();

    const rows = result.toArray().map(r => r.toJSON());
    if (rows.length === 0) {
      contextCache.set(key, null);
      return null;
    }

    const ctx = rows[0];
    // Attach user-specified default modifications (from context editor).
    // Look up by: explicit overrides → input key → resolved variant → family.
    // This ensures that an override on "H31" is picked up when querying "H3"
    // (which resolves to H3.1 / variant H31).
    const mods = ov.modifications
      ?? contextOverrides[ctx.variant]?.modifications
      ?? contextOverrides[ctx.family]?.modifications
      ?? [];
    ctx.modifications = mods;
    contextCache.set(key, ctx);
    return ctx;
  } finally {
    await conn.close();
  }
}

// ── The variant axis is a TREE, on this side of the boundary too ──────────
// A token denotes its SUBTREE (2026-07-28). The engine implements that; the data layer did not,
// and the two halves are `variantToken2` (set → name, for display) and this (name → set, for
// lookup). They are inverses, and every bug here was the name being used where the extension was
// needed: a flat `variant = 'H2A.Z'` against a column that stores LEAF assignments.
//
// `H2A.Z` was the case that showed it, because it is the only clade whose human members are all at
// the leaves — the parquet holds H2A.Z rows for yeast/worm/fly/frog and H2A.Z.1 / H2A.Z.2 for human,
// so under the default lens the scalar compare matched nothing and the card said "no H2A sequences
// are registered in Homo sapiens — a gap in this dataset". Both accessions were right there. Every
// other token happens to have a row carrying the token itself, which is why this survived.
//
// `expandVariants2` is the engine's own expansion — the ONE implementation of the tree — so this
// cannot drift from what `resolve2` did to the same token upstream.
function variantSubtree(family, variant) {
  if (variant == null) return null;                       // ⊤: bare family, no constraint
  const toks = Array.isArray(variant) ? variant : [variant];
  const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
  if (P && typeof P.expandVariants2 === 'function') {
    try {
      const out = P.expandVariants2(family, toks);
      if (out && out.length) return out;
    } catch (e) { /* fall through to the token itself */ }
  }
  // Engine absent (a Node model test) or the token is not in the tree: the token alone, which is
  // the pre-tree behaviour. Degrading to "too narrow" keeps a missing engine from widening a query.
  return toks;
}

// ── Material-layer variant resolution ─────────────────────────────────────
// Resolve a variant TOKEN to the SET of UniProt accessions it denotes, in a
// context (taxon). This is the idea→material step of
// specs/2026-07-18-material-layer-matching.md: a landmark like `caH2A` is NOT
// matched by string against a datum's variant column — it is resolved to the
// accessions it denotes, and datums are matched by accession. That is why
// `caH2A` surfaces its members' AM even though those rows are tagged with a
// different variant token (e.g. NULL/canonical). A null variant (bare family =
// ⊤ = any variant) returns null → "no accession constraint". Cached.
const accessionsCache = new Map();
// `taxon` IS REQUIRED, and its default was dead before it was deleted: the one caller
// (`queryLayers`) passes an explicit taxon, which is `null` — organism does not gate relevance —
// and `= 9606` only fires on `undefined`. A default here would be a second organism policy, in the
// one function whose job is NOT to have one.
async function resolveAccessions(family, variant, taxon) {
  if (variant == null) return null;                       // ⊤: bare family imposes no accession filter
  const key = JSON.stringify([family, variant, taxon]);
  if (accessionsCache.has(key)) return accessionsCache.get(key);

  const conn = await dbConnect();
  try {
    // The SUBTREE, not the token — see `variantSubtree`. The comment above this function has always
    // said a landmark "is NOT matched by string against a datum's variant column"; until 2026-07-29
    // the SQL did exactly that string match.
    const vset = variantSubtree(family, variant);
    const vph = vset.map((_, i) => `$${i + 2}`).join(', ');
    const tp = `$${vset.length + 2}`;
    const sql = `
      SELECT DISTINCT uniprot_id
      FROM read_parquet('${PROTEINS_URL}')
      WHERE family = $1
        AND variant IN (${vph})
        AND (${tp} IS NULL OR taxon_id = ${tp})`;
    const stmt = await conn.prepare(sql);
    const rows = (await stmt.query(family, ...vset, taxon ?? null)).toArray().map(r => r.toJSON());
    await stmt.close();
    const acc = rows.map(r => r.uniprot_id);
    accessionsCache.set(key, acc);
    return acc;
  } finally {
    await conn.close();
  }
}
function clearAccessionsCache() { accessionsCache.clear(); }

// Compute MW delta for a substitution: wt_residue → sub_residue
const subDeltaCache = new Map();

async function resolveSubstitutionDelta(wtResidue, subResidue) {
  const key = `${wtResidue}→${subResidue}`;
  if (subDeltaCache.has(key)) return subDeltaCache.get(key);

  const conn = await dbConnect();
  try {
    const sql = `
      SELECT
        new.average       - old.average       AS average_delta,
        new.monoisotopic  - old.monoisotopic  AS monoisotopic_delta
      FROM read_parquet('${MASSES_URL}') old,
           read_parquet('${MASSES_URL}') new
      WHERE old.residue = $1
        AND new.residue = $2`;
    const stmt = await conn.prepare(sql);
    const result = await stmt.query(wtResidue, subResidue);
    await stmt.close();
    const rows = result.toArray().map(r => r.toJSON());
    // No row = a residue the mass table does not know. It must NOT coalesce to a
    // delta of 0: that silently reports the UNSUBSTITUTED mass at full precision,
    // indistinguishable from a correct answer (e.g. C110U is ~+47 Da). Mark it
    // unknown and let the caller surface it.
    const d = rows[0] ?? { average_delta: 0, monoisotopic_delta: 0, unknown: true };
    subDeltaCache.set(key, d);
    return d;
  } finally {
    await conn.close();
  }
}

// Compute MW delta for a PTM
const ptmDeltaCache = new Map();

async function resolvePtmDelta(ptm) {
  // A SET OF MARKS HAS NO SINGLE MASS (CLAUDE.md §8), so `H3:K4me` — which lifts to
  // {me1, me2, me3} — is unknown by the same rule that leaves the group name out of ptm_deltas
  // altogether. Answered here rather than by a query: an array is a fresh object every call, so it
  // would miss this cache forever, grow it without bound, and reach the prepared statement as a
  // parameter it cannot bind.
  if (Array.isArray(ptm))
    return { average_delta: 0, monoisotopic_delta: 0, unknown: true };
  if (ptmDeltaCache.has(ptm)) return ptmDeltaCache.get(ptm);

  const conn = await dbConnect();
  try {
    const sql = `
      SELECT
        average       AS average_delta,
        monoisotopic  AS monoisotopic_delta
      FROM read_parquet('${PTM_URL}')
      WHERE ptm = $1`;
    const stmt = await conn.prepare(sql);
    const result = await stmt.query(ptm);
    await stmt.close();
    const rows = result.toArray().map(r => r.toJSON());
    // Same hazard as the substitution path: an unregistered PTM token must not
    // silently contribute 0.
    const d = rows[0] ?? { average_delta: 0, monoisotopic_delta: 0, unknown: true };
    ptmDeltaCache.set(ptm, d);
    return d;
  } finally {
    await conn.close();
  }
}

// Flush context cache (called when user edits overrides).
function clearContextCache() {
  contextCache.clear();
}

// ── Realization resolution via proteins.parquet ───────────────────────────
// A realization slot names a *material* (an unregistered head token: a UniProt
// accession, a protein name, or a material synonym like `macroH2A`). This
// classifies the token, queries proteins.parquet, and returns the `lookup`
// object consumed by resolveRealization() (realization-model.js), or null if
// nothing resolves. See specs/2026-07-14-realization-fluid-family-design.md.
//
// NOTE on gene symbols: the design also names gene→UniProt resolution via
// gene_index.parquet, but that table is not among the served/registered
// parquets (initDuckDB registers proteins/masses/ptm/water/lookup/measurements
// only). Gene resolution is therefore out of scope for the client build here;
// a bare gene symbol falls through to the protein_name attempt and, failing
// that, resolves to null (→ the unresolvable error card).

// Material synonyms → registered family/variant. Keyed lowercased. These pin
// family/variant only (species stays ambiguous, filled from the query context).
const REALIZATION_SYNONYMS = {
  'macroh2a':  { family: 'H2A', variant: 'H2AMAC' },
  'macro-h2a': { family: 'H2A', variant: 'H2AMAC' },
  'mh2a':      { family: 'H2A', variant: 'H2AMAC' },
  'h2a.bbd':   { family: 'H2A', variant: 'H2ABBD' },
  'h2abbd':    { family: 'H2A', variant: 'H2ABBD' },
  'cenp-a':    { family: 'H3',  variant: 'CENPA' },
  'cenpa':     { family: 'H3',  variant: 'CENPA' },
};

// Cache: token → lookup object (or null)
const realizationCache = new Map();

async function resolveRealizationLookup(token) {
  if (token == null) return null;
  const tok = String(token).trim();
  if (!tok) return null;
  if (realizationCache.has(tok)) return realizationCache.get(tok);

  let lookup = null;
  const conn = await dbConnect();
  try {
    // 1) UniProt accession — pins family + species (taxon_id set).
    //    Accessions are 6–10 alphanumerics (incl. the O/P/Q first-letter forms
    //    like P68431); try any token that fits, the query confirms it.
    if (/^[A-Za-z0-9]{6,10}$/.test(tok)) {
      const sql = `
        SELECT family, variant, uniprot_id, taxon_id
        FROM read_parquet('${PROTEINS_URL}')
        WHERE upper(uniprot_id) = upper($1)
        ORDER BY n_gene_loci DESC, uniprot_id
        LIMIT 1`;
      const stmt = await conn.prepare(sql);
      const rows = (await stmt.query(tok)).toArray().map(r => r.toJSON());
      await stmt.close();
      if (rows.length) lookup = rows[0];
    }

    // 2) Material synonym → registered family/variant (species from context).
    if (!lookup) {
      const syn = REALIZATION_SYNONYMS[tok.toLowerCase()];
      if (syn) {
        // Confirm the family/variant exists in the data; carry the canonical
        // family/variant. No taxon_id (species stays ambiguous → context fills).
        const sql = `
          SELECT family, variant
          FROM read_parquet('${PROTEINS_URL}')
          WHERE family = $1 AND ($2 IS NULL OR variant = $2)
          ORDER BY n_gene_loci DESC, uniprot_id
          LIMIT 1`;
        const stmt = await conn.prepare(sql);
        const rows = (await stmt.query(syn.family, syn.variant ?? null)).toArray().map(r => r.toJSON());
        await stmt.close();
        // Only resolve if the synonym's family/variant actually backs a protein in
        // the data; an unconfirmed synonym falls through (→ protein name → error).
        if (rows.length) lookup = rows[0];
      }
    }

    // 3) Protein name (`Histone H2B type 1-A`) or UniProt ENTRY name (`H2B1A`) — pins a protein.
    //
    // The entry name was missing here while the sync registry's classify() knew it, so `H2B1A`
    // resolved in one lookup and not the other — and this is the one the shell actually calls for a
    // realization slot. It is also the name the alignment grid PRINTS as a row label, so the pane
    // was showing an identifier its own resolver would reject.
    if (!lookup) {
      // NO `LIMIT 1`. This lookup is context-free by contract — it returns what the TOKEN
      // determines and nothing more, and `resolveRealization` reads a present `taxon_id` as "the
      // token pinned the species". Entry names are not unique across organisms (`H2B1A` is both
      // mouse P70696 and human Q96A08), so taking the first row would have pinned a species the
      // user never named, silently and differently depending on gene counts. When the matches span
      // more than one taxon the token has determined only family and variant; the query context
      // fills the rest, which is the precedence chain doing its job.
      const sql = `
        SELECT DISTINCT family, variant, uniprot_id, taxon_id
        FROM read_parquet('${PROTEINS_URL}')
        WHERE protein_name ILIKE $1 OR uniprot_name ILIKE $1
        ORDER BY n_gene_loci DESC, uniprot_id`;
      const stmt = await conn.prepare(sql);
      const rows = (await stmt.query(tok)).toArray().map(r => r.toJSON());
      await stmt.close();
      if (rows.length) {
        const taxa = new Set(rows.map(r => r.taxon_id));
        lookup = taxa.size > 1
          ? { family: rows[0].family, variant: rows[0].variant }   // ambiguous species → context decides
          : rows[0];
      }
    }
  } finally {
    await conn.close();
  }

  realizationCache.set(tok, lookup);
  return lookup;
}

function clearRealizationCache() {
  realizationCache.clear();
}

// ── Parser ────────────────────────────────────────────────────────────────

// `tryParse` and `describe` lived here (removed 2026-07-26, Phase 5 step 5).
//
// `tryParse` handed the page a v1-SHAPED tree via `adaptTree2` while the view-models were ported one
// at a time; `describe` was the descriptor built from that tree. Every consumer now reads the IR:
// the class is `classify2`, the physics verdict `valid2`, the canonical string `emit2`, the
// materials canon's own members, and the units bar the array's members. `adaptTree2` itself stays in
// the bundle — it is v2 code, and the JS suites use it to gate classify2 against the v1 oracle.

// ── Schema vocabulary ─────────────────────────────────────────────────────
// family/variant are normalized in the parse tree — no mapping needed.
//
// PTM_NAMES (vocabulary.js, generated from vocabulary.yaml) is still DEFINED but no longer read
// anywhere on the page: its last consumer was render.js `formatSequence`, deleted 2026-07-29 with
// the rest of the v1 `describe()` leftovers. Left in place because vocabulary.js is generated and
// must not be hand-edited; noted here so the next reader does not conclude the table is load-bearing.

// Describe a single modification entry → { canonical, type, pos, wt, ptm, sub }
//
// R0 (round-trip) lives or dies here: `canonical` must re-parse AND mean the same
// thing. Two ways it did not:
//
//  - NEGATION was dropped. `H3:!K27M` canonicalised to `H3:K27M` — the string
//    asserting the OPPOSITE. Not a rendering gap, an inversion: R0 was false for
//    every negated description, "Deduplication = Normalize → Canonical Equality"
//    fused two contradictory claims, and — because `lastKey` is
//    `describe(parsed).canonical` and every async render branch guards on
//    `if (key !== lastKey) return` — two opposite queries shared a key, so the
//    second one's re-render was silently suppressed and the pane kept the first
//    answer. `!` is the negation operator (`0` is a PTM-only alias for it), so the
//    canonical carries `!`.
//
//  - A POSITIONLESS PTM emitted the literal string "null": `H2A:ub` ("ubiquitylated,
//    site unstated") canonicalised to `H2A:nullub`, which does not parse at all.
function describeMod(m) {
  const pos    = m.position;
  const wt     = m.residue;
  const ptm    = m.modification;
  const sub    = m.variant;
  const neg    = m.negated ? '!' : '';
  const site   = pos == null ? '' : (wt ? `${wt}${pos}` : `${pos}`);
  const prefix = `${neg}${site}`;

  if (ptm && sub) return { canonical: `${prefix}${sub}${ptm}`, type: 'mut+ptm',      pos, wt, ptm, sub };
  if (ptm)        return { canonical: `${prefix}${ptm}`,        type: 'modification', pos, wt, ptm };
  if (sub)        return { canonical: `${prefix}${sub}`,        type: 'substitution', pos, wt, sub };
  return           { canonical: prefix,                          type: 'position',     pos, wt };
}

// Render a residue-range endpoint: α/ω sentinels → glyphs, else the number.
function ptStr(p) { return p === 'α' ? 'α' : p === 'ω' ? 'ω' : String(p); }

// ── THE SECOND NOTATION EMITTER IS GONE (BB, 2026-08-06) ─────────────────────────────────────────
// `famStr`, `modsCanonical`, `slotCanonical` and `nucleosomeCanonical` lived here: a complete
// parse-tree → notation serialiser, with its own rules for `@`-joining, certainty brackets,
// per-slot subscripts and the ⁺/⁻ spin mark. It was v1's canonical printer, and `emit2` replaced it.
//
// Nothing had called it since — checked across docs/, grammar/, tests/ and scripts/, where the only
// references were the four functions calling each other. It is deleted rather than kept "in case",
// because a second emitter is not dead weight, it is a second ANSWER: the next person needing a
// notation string finds it, uses it, and the page starts spelling one molecule two ways.
//
// The one emitter is `emit2` (grammar/emit2.js, plus emit_material.js for the material layer). The
// one styler on top of it is `styleNotation` (notation-style.js). `describeMod` below stays — it is
// live, and it describes ONE modification for a pill, which is not the same job.

// ── the v1 IR bridge is GONE (Phase 5) ───────────────────────────────────────────────────────────
// `classifyIR` re-serialised the query and fed it to `nucleosomeParser.normalize` — v1's engine —
// for two things: a display class, and a physics `error`. Both now come from v2. The class is
// `classify2` (below), gated 88/88 against v1's classifier. The error is `valid2` = meet2(A,A) ≠ ⊥,
// checked in shell.js BEFORE this function is reached.
//
// Measured before deleting, over tests/parser_cases.yaml: v1's gate rejects NOTHING that v2's does
// not, and v2 additionally rejects an unresolvable token. So the v1 gate was redundant, and the
// `error` field it fed is now always null.


// ── Render utilities ──────────────────────────────────────────────────────

function scoreColor(score) {
  if (score < 0.34)  return 'var(--accent-green)';
  if (score < 0.564) return 'var(--accent-gold)';
  return 'var(--accent-red)';
}

// Shared table constructor for every data layer (mass, AlphaMissense, screen). Given
// column defs [{ header, width }] and a pre-built <tbody> HTML string, it emits the
// unified chrome: a .scrollable-table wrapper + a fixed-layout .mtbl.ltbl table with a
// <colgroup> so the shared leading columns (Material/Species/Paralog) line up to the
// SAME width across tables regardless of the value columns that follow.
// A column may carry an optional `title`: what the column IS, said once in the header rather than
// once per row. `MW` and `Mass` are not self-describing, and which kind of mass each holds is a fact
// about the column — a per-row hover repeating it is the column again, at the cost of a gesture.
// Optional, so the two other callers (the AM table, the measurement sections) are unchanged.
//
// `extraHeadRow` [BB 2026-09-25, `specs/2026-09-25-one-object-heads.md` Ruling 1] is one more
// `<tr>` of raw HTML, placed BEFORE the column-title row inside the same `<thead>` — the header
// BAND, revealed with the table when an L2 section unfolds. `renderTypeSection` is the one caller
// that passes it (the axis meta and `Show all`/`Show fewer`, full-width via `colspan`), the same
// full-width-cell idiom `rowPair`'s identity line already uses one level down. Optional and empty
// by default, so the mass/AM/literature tables — which have no axis meta to hoist — are unchanged.
function renderLayerTable(columns, bodyHtml, { wrapClass = 'scrollable-table', extraHeadRow = '' } = {}) {
  const cols = columns.map(c => `<col${c.width ? ` style="width:${c.width}"` : ''}>`).join('');
  const head = columns.map(c =>
    `<th${c.title ? ` title="${escapeAttr(c.title)}"` : ''}>${c.header}</th>`).join('');
  // NO <tbody> HERE. Callers supply row GROUPS — one `<tbody class="rowpair">` per datum (see
  // `rowPair` below) — and a tbody nested inside a tbody is not something a browser will keep: it
  // closes the outer one and the grouping that makes a pair read as one row is gone.
  return `<div class="${wrapClass}"><table class="mtbl ltbl">`
       + `<colgroup>${cols}</colgroup><thead>${extraHeadRow}<tr>${head}</tr></thead>`
       + bodyHtml + `</table></div>`;
}

// ── A DATA ROW IS TWO ROWS [BB 2026-09-23] ───────────────────────────────────────────────────────
// specs/2026-09-23-one-layout-narrow-first.md, the ruling that opened this design. The identity of
// the thing measured — material, variant, species — takes a full-width line; the numbers take the
// line under it. At 402px a 4-6 column table has no honest rendering, and this is the answer.
//
// A <tbody> PER DATUM, NEVER rowspan. See the 2026-08-16 note in shell.js's further-reading
// builder: two rows joined by rowspan and a suppressed border were tried, and the title drifted
// from its metadata because nothing in the markup said the two rows were one thing. A row GROUP
// says it, browsers honour it, and the separator moves BETWEEN groups — so the line that used to
// split a pair down the middle now delimits pairs instead.
//
// ONE builder, shared by every table on the spine. Two tables writing their own two-row shape is
// exactly how the Arrays card and the Measurements table came to disagree about every column.
//
// THE ROW'S IDENTIFYING ATTRIBUTES GO ON THE DATA ROW, not on the group. `data-id`, `data-acc`,
// `data-variant`, `data-aln` and `data-pos` are what `measurement-highlight` and the `.meas-xref`
// banding address, through selectors of the form `tr[data-id]` — putting them on the tbody would
// silently stop every one of them matching. The group carries only the pair's class.
function rowPair(identityHtml, dataCells, colSpan, opts) {
  const o = opts || {};
  const cls = 'rowpair' + (o.cls ? ' ' + o.cls : '');
  // THE TOOLTIP IS THE ROW'S, NOT ONE TERM'S [BB 2026-09-24: "could be carried by the entire
  // row"]. It used to live only on `.mt-notation` inside the identity line, reachable by hovering
  // the four characters of a variant name — everything else in the row (species, the enzyme
  // prefix, the padding between them) had none. On `<tr class="rp-id">` rather than on its `<td>`:
  // the row has exactly one cell (`colspan`), so the two cover the same rendered box, but the
  // title attribute is a fact about the DATUM the row identifies, not about that cell's content —
  // and an element with no title of its own shows the nearest ANCESTOR's, so a term inside
  // (`.mt-notation`) that still carries its own title keeps it on hover, while the rest of the
  // line falls through to this one.
  const rowTitle = o.title ? ` title="${escapeAttr(o.title)}"` : '';
  return `<tbody class="${cls}">`
       + `<tr class="rp-id"${rowTitle}><td colspan="${colSpan}">${identityHtml}</td></tr>`
       + `<tr class="rp-data"${o.rowAttrs || ''}>${dataCells}</tr>`
       + `</tbody>`;
}

// material · Variant · Species, in that order, with absent parts simply not written [BB
// 2026-09-23: "Variant (optional for mass etc.) · Species (optional)"]. A row with neither states
// its material alone rather than trailing two em-dashes — which is what those columns held for
// every measurement row, since only the mass and AlphaMissense tables carry them.
//
// The separator is the same `·` the hoisted section meta uses, so a reader learns it once.
//
// ── WHAT THE ARGUMENTS ARE ──────────────────────────────────────────────────────────────────────
// `materialHtml` is HTML — it comes from `materialCell({ inline: true })` or from a caller's own
// span, and it carries the styled notation, which is markup by construction.
//
// `variant` and `species` are TEXT, and are escaped here. They arrive straight off a parquet row
// (`row.variant`, `abbrevSpecies(row.species)`), so the callers would each have to remember; one
// of them did not, and three callers with a shared builder disagreeing about whether its arguments
// are markup is the shape an injection arrives through later. A caller that needs a tooltip on the
// species passes `{ text, title }` rather than pre-built markup.
//
// `subject` LEADS the line rather than trailing it [BB 2026-09-24: "The name of the enzyme in
// measurement tables (remodelers) should not end up in the source column, perhaps prefixed to the
// material: `ACF \u00b7 (H3)2`"]. It was in `.msource`, a narrow qualifier cell that also carries the
// PMID \u2014 a fact about WHO did the measurement, not about the source it was published in, and a
// column meant to be dropped from a row entirely once a section hoists one shared value into its
// head (`sec.subjectHoisted`). The caller passes `null`/`''` in that case, same as an absent
// variant or species.
function identityLine(materialHtml, variant, species, subject) {
  const term = (v, cls) => {
    if (!v) return '';
    const text = (typeof v === 'object') ? v.text : v;
    if (!text) return '';
    const title = (typeof v === 'object' && v.title) ? ` title="${escapeAttr(v.title)}"` : '';
    return `<span class="${cls}"${title}>${escapeAttr(String(text))}</span>`;
  };
  const bits = [term(subject, 'rp-subject'), `<span class="rp-mat">${materialHtml}</span>`,
                term(variant, 'rp-var'), term(species, 'rp-sp')].filter(Boolean);
  return bits.join(' <span class="rp-dot">\u00b7</span> ');
}

// Column frame shared by the per-material tables (mass, AM): Material leads, the identity
// columns (Paralog, Species) trail, and each table's value/measurement columns sit
// BETWEEN them. This keeps the measurements next to the Material name, so when a table
// overflows to the right it is the least-critical identity columns (Paralog, then Species)
// that scroll off — the numbers stay legible. Widths fixed for cross-table alignment.
// MATERIAL_LEAD and MATERIAL_TRAIL are GONE [BB 2026-09-23]. They fixed the widths of the Material
// column and of the trailing Variant / Species pair so the mass and AlphaMissense tables agreed
// with each other. All three moved to the row's own identity line, so there is no column left for
// them to agree about — and a shared width constant for columns that no longer exist is the kind
// of thing a later reader adds a column back to satisfy.
//
// What they were FOR is not lost: `identityLine` (below) is now the one place that decides the
// order and the separator of those three, which is the same guarantee one level up.

// ── The measurement frame: Measurements and Arrays are ONE column of the page ────────────────────
// [BB 2026-08-06: "the layout of the array doesn't match up the layout of the arrangement card"]
// The Measurements table sits inside the Arrangements panel and the Arrays card is the panel
// directly beneath it, so the reader sees them stacked and reads down. They were built from two
// hand-written column lists that disagreed on every width — Material 31/35 vs 30, Effect 39/43 vs
// 28, Source 19/22 vs 20 — plus a 5th and 6th column on the Arrays side, so nothing lined up.
//
// The widths live here for the same reason MATERIAL_LEAD's do, and the note above applies verbatim:
// fixed, so tables agree. A caller states only what its middle column is CALLED; it cannot state a
// width, which is what stopped these two agreeing.
//
// The middle slot is the narrow per-row coordinate — `Condition` on a screen (ATP+/ATP−). Omitted
// when a section hoists it, and then the remaining three widen: a column of every row restating the
// section head is the thing the hoist exists to avoid, and hoisted is the ordinary case.
//
// One caller, `renderTypeSection`, and that is the point rather than an oversight — the Arrays card
// reached this function through its own table until 2026-08-06 and now goes through the section
// builder like everything else.
// MATERIAL LEFT THE COLUMNS [BB 2026-09-23] and is the row's identity LINE, so this is three
// columns at most and two in the ordinary case. The widths are restated rather than rescaled by
// hand: they are the old ones renormalised over what remains, so the Effect bar keeps roughly the
// share of the row it had.
function measFrame(middleHeader) {
  return middleHeader
    ? [{ header: middleHeader, width: '16%' },
       { header: 'Effect', width: '56%' },
       { header: 'Source', width: '28%' }]
    : [{ header: 'Effect', width: '66%' },
       { header: 'Source', width: '34%' }];
}

// ── The Further reading frame ────────────────────────────────────────────────────────────────────
// The literature pointer is the third card in the same column as Measurements and Arrays, so its
// Material column leads at the SAME width as theirs — 35%, matching measFrame's hoisted (3-column)
// case, which is what the measurement tables show once subject and unit are hoisted out.
//
// It lives HERE and not in shell.js for the reason layout-constants.test.js enforces: sharing a
// frame is worth nothing if a caller can still hand renderLayerTable a width of its own. That is
// exactly how the Arrays card and the Measurements table drifted apart in the first place.
//
// The columns AFTER Material are this card's own, because it is not a measurement table: there is no
// Effect and no Source, since a row says a paper MENTIONS the object and nothing about what it found.
//
// A PAPER IS TWO TABLE ROWS [BB 2026-08-16], in the shape of a reference listing: the TITLE leads,
// and authors · journal · year · PMID sit beneath it in secondary ink. Title first because it is
// what a reader scans for; the metadata line is what they check once the title has caught them.
//
// Material led as a real COLUMN until 2026-09-23 — the notation of what was studied is this
// artifact's own fact and the reason the row is here at all, and that is unchanged; it is the
// row's identity LINE now rather than a 30% column. (This paragraph asserted the opposite of the
// code for as long as the sentence below it said so too.) RCR files with the PMID on the metadata
// line [BB 2026-08-16] rather than taking a column: it qualifies the citation, it is not a second
// dimension of the table, and a numeric column would have pulled the eye away from the title.
// The title itself is the PubMed link, so the row has one obvious target.
// ONE COLUMN. Material moved to the identity line [BB 2026-09-23], and what a paper row shows is
// the paper — the title, the authors, the citation. The three-line stack inside the cell, ruled on
// 2026-08-16, is unchanged: it was always the cell's typography rather than the table's columns.
function furtherFrame() {
  return [{ header: 'Paper', width: '100%' }];
}

// Sort per-material rows to follow the alignment grid's order (agreement-with-consensus),
// so the mass/AM/sequence views read top-to-bottom the same way. Falls back to the
// given order when the alignment order for this slot isn't cached yet.
function orderBySequence(rows, info) {
  const order = (typeof sequenceOrder === 'function' && info)
    ? sequenceOrder(info.slotFamily, info.slotVariant) : null;
  if (!order || !order.length) return rows;
  const idx = id => { const i = order.indexOf(id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return rows.slice().sort((a, b) => idx(a.uniprot_id) - idx(b.uniprot_id));
}

// Render an AM rows table into `container`. Shows meta line when showMeta=true.
function renderAmTable(rows, info, container, { showMeta = true } = {}) {
  if (rows.length === 0) return;

  const nProteins = new Set(rows.map(r => r.uniprot_id)).size;
  const nTaxa     = new Set(rows.map(r => r.taxon_id)).size;
  rows = orderBySequence(rows, info);   // follow the alignment grid's order

  const rows_html = rows.map(r => {
    // `am_class` is a COLUMN of the AlphaMissense file (2026-09-22); the blob it came from carried
    // the score and the substitution too, as duplicates of `estimate` and `substitution`. A row from
    // an older table still reads through `meta`, so a fixture with a blob renders the same.
    const meta      = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
    const score     = +(r.estimate ?? meta.am_pathogenicity);
    const pct       = Math.round(score * 100);
    const color     = scoreColor(score);
    const amClass   = r.am_class ?? meta.am_class ?? '';
    const cls       = ({ LPath: 'pathogenic', LBen: 'benign', Amb: 'ambiguous' })[amClass]
                      ?? amClass.toLowerCase();
    const variant = r.variant && r.variant !== 'NA' ? r.variant : null;
    // NO EM-DASH. In a COLUMN an em-dash said "this row has no variant"; on an identity LINE it
    // would read as a term of the phrase — `H3 · — · H. sapiens`. Absent parts are simply not
    // written, which is what `identityLine` is built for.
    const variantDisplay = variant ?? '';
    // THE DATUM'S OWN RESIDUE NUMBER, AND ONE STRING TO SAY IT (BB, 2026-07-29). AlphaMissense scored
    // THIS accession at THIS residue; `histone_position` is that number and had been in the view all
    // along, unread, while the cell printed `info.position` — the query's idea coordinate — beside a
    // material handle. 11,457 of 94,392 lookup rows disagree between the two, and 6,251 of those also
    // printed a wild-type letter that does not exist at the idea position. Restating a measurement in
    // the frame of whoever queried it produces a label no source or database would recognise.
    // Relevance is unaffected: that is settled on `position` (idea) before any of this renders.
    //
    // The handle and the number come from ONE call, because a material handle is what makes a number
    // material — and the mark handed over is already a fact about the molecule (`r.residue` is this
    // accession's own wild type here, `variant_aa` the scored substitution), so `emitMaterial` decides
    // only the handle and the numbering. `histone_position` stands in if the emitter refuses outright.
    //
    // AND THE NUMBER HANDED OVER IS `histone_position`, DECLARED AS MATERIAL (2026-08-07). This
    // passed `info.position` with no `positionsAre`, which is wrong twice over: `info.position` is
    // the display anchor's own number — not the query's idea coordinate and not this molecule's —
    // and the omitted argument made the emitter read it as an IDEA position and translate it through
    // the family's canonical member. So the paragraph above was already the intent and the call
    // contradicted it: P0C0S5's own 7 printed as K9A, Q96A08's 121 as K122A, and P16104's 139 was
    // refused outright because canonical H2A has no residue in that column at all.
    //
    // `histone_position` needs no conversion — it IS the residue AlphaMissense scored, in the
    // molecule's own numbering, which is what `'material'` says. Nothing is translated here, and the
    // one remaining question, whether a readable handle would name this site, stays the emitter's.
    const P2m = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    const ownPos = typeof r.histone_position === 'number' ? r.histone_position : null;
    const mEmit = (P2m && typeof P2m.emitMaterial === 'function' && ownPos != null)
      ? P2m.emitMaterial(r.uniprot_id,
          [{ position: ownPos, residue: r.residue ?? null,
             substitution: meta.variant_aa ?? r.substitution ?? null,
             modification: null, negated: false }], P2m.DEFAULT_REGISTRY, 'material')
      : null;
    const matPos   = (mEmit && mEmit.marks[0] && mEmit.marks[0].mod.position)
                     ?? ownPos ?? info.position;
    const varLabel = `${r.residue ?? '?'}${matPos}${meta.variant_aa ?? r.substitution ?? '?'}`;

    const sp = r.species ? abbrevSpecies(r.species) : (r.taxon_id ?? '');
    // `matOpts` is kept, not just its rendered `mat`, so the row's own title (below) is the SAME
    // join `materialTitle` computes for the span inside it — one source, not two hand-typed copies.
    const matOpts = { uniprotName: r.uniprot_name, uniprot_id: r.uniprot_id,
                      handle: mEmit && mEmit.handle,
                      notation: (mEmit && mEmit.notation)
                        || ((mEmit && mEmit.handle) || r.uniprot_name) + ':' + varLabel,
                      protein_name: r.protein_name, species: r.species, inline: true };
    const mat = materialCell(matOpts);
    // `data-variant` is how this row reaches the grid when the organisms differ: under a port the
    // grid holds the TARGET's materials, so the accession matches nothing and the variant — the
    // idea-layer identity that survives the species change — is what couples the two.
    // `data-aln` is the SITE and `data-pos` is the query's idea coordinate. The grid is addressed by
    // the column (2026-08-03, BB), because a column is the one key an insertion residue also has —
    // `data-pos` is absent on an insertion cell by construction, so a datum about H2A.Z's K4 had
    // nothing to point at. The idea coordinate stays for the readout and for anything comparing
    // against the query's own number.
    // Material · Variant · Species is the row's identity LINE now [BB 2026-09-23]; the two score
    // columns are what remains of a five-column table. The identifying attributes stay on the data
    // row, where `measurement-highlight`'s `tr[data-acc]` / `tr[data-aln]` selectors reach them.
    const rowAttrs = ` data-acc="${r.uniprot_id}" data-variant="${variant ?? ''}"`
                   + ` data-aln="${r.aln_column ?? ''}" data-pos="${info.position}"`;
    const spTitled = sp
      ? { text: sp, title: String(r.species ?? '') + (r.taxon_id ? ' · taxon ' + r.taxon_id : '') }
      : '';
    return rowPair(identityLine(mat, variantDisplay, spTitled),
      `<td><div class="score-wrap"><div class="score-bar-bg">`
      + `<div class="score-bar-fill" style="width:${pct}%;background:${color}"></div></div>`
      + `<span class="score-num">${score.toFixed(3)}</span></div></td>`
      + `<td><span class="badge ${cls}">${amClass}</span></td>`,
      2, { rowAttrs, title: materialTitle(matOpts) });
  }).join('');

  const meta = showMeta
    ? `<p class="result-meta">${rows.length} variant scores &middot; ${nProteins} protein${nProteins !== 1 ? 's' : ''} &middot; ${nTaxa} organism${nTaxa !== 1 ? 's' : ''}</p>`
    : '';

  // TWO COLUMNS, from five. Material, Variant and Species moved to the row's identity line.
  const columns = [{ header: 'Pathogenicity', width: '65%' }, { header: 'Class', width: '35%' }];
  container.innerHTML = `${meta}${renderLayerTable(columns, rows_html)}`;
}

// Residues per wrapped block. The grid is broken into stacked text blocks (BLAST/Clustal
// style) rather than one horizontally-scrolling strip, so the whole set is readable at
// once. Column alignment holds within a block; blocks stack down the card.
//
// 59, NOT 60 (BB, 2026-07-30). A decade tick is written left-aligned from its own column,
// so a tick landing on the LAST column of a block has nowhere to put its remaining digits:
// at 60 the final tick starts at column 60 and prints "6", the "0" falling off the end.
// 59 puts the last tick of the first block at position 50 (columns 50-51, both inside), and
// every later block starts on a decade so its ticks have the whole block to sit in. The old
// value of 49 was the same reasoning one decade lower.
//
// PARAMETRIC, in both languages. This number is emitted onto the grid as `--seq-cols`, and
// _shell.scss sizes the block box from it — so the sticky header's background and the row
// tints span exactly one block rather than only the part of it currently on screen. The one
// thing CSS cannot derive is the pane's minimum width (`--seq-min-w`), because `ch` outside
// the grid resolves against the sans font; `layout-constants.test.js` holds those two together.
const AL_BLOCK = 59;

// (AL_INLINE_MAX is gone. It set how many out-of-frame residues were appended after the last block
// rather than collapsed to "+N" — a choice that only existed because an insertion had no column to
// be drawn in. It has one now; see the `aln_column` note in alignment-model.js. The run-length cap
// that replaced it, INS_EXPAND_MAX, lives there because it shapes the model, not the markup.)

// Monospace ruler over a block: a char array with the position VALUE written at every
// decade column (1, 10, 20, …), left-aligned so its first digit sits under that residue.
// user-select:none so it never lands in a residue copy. Spaces are preserved (pre).
// `label` maps a column's idea position to the number to PRINT — the representative material's own
// numbering (see alignment-model's `model.numbering`). Ticks fall on decades of the PRINTED number,
// so a yeast row is ruled 1…125 in yeast numbering and its K123 sits under a "120" decade three
// columns to its left, exactly as a yeast paper would draw it.
// `chunk` is a list of COLUMNS ({col, pos}) since 2026-07-31, not of bare positions — an insertion
// column has no `pos` to be identified by. `rulerLabel` is handed the whole column so it can answer
// from the representative's own residue there; over a column the representative does not carry it
// returns null and the ruler prints a blank, which is correct: there is no residue of that molecule
// to number.
function alignmentRuler(chunk, rulerLabel) {
  const cells = new Array(chunk.length).fill(' ');
  const at = rulerLabel || ((c) => (c && typeof c === 'object' ? c.pos : c));
  chunk.forEach((c, i) => {
    const n = at(c);
    if (n == null) return;
    if (n === 1 || (n > 0 && n % 10 === 0)) {   // no tick on the leading Met column (pos 0)
      const s = String(n);
      for (let k = 0; k < s.length && i + k < cells.length; k++) cells[i + k] = s[k];
    }
  });
  return `<div class="al-row al-ruler"><span class="al-label"></span>`
       + `<span class="al-rseq">${cells.join('').replace(/ /g, '&nbsp;')}</span></div>`;
}

// THE QUERY'S EXTENT, drawn as a rule under the ruler (BB, 2026-07-25: "underlined is great").
//
// Certainty lives only on segments in the v2 IR, and until now the front end had no way to SAY a
// segment: `H3[1-30]` drew a grid identical to `H3`. The vocabulary is deliberately small, because
// the distinction it carries is small — an extent is claimed, and the claim is either closed or open:
//
//   solid rule   `[1-30]`  defined — this extent and no more
//   dotted rule  `{31-40}` native  — this extent, open to more
//
// Segment positions are in the query's coordinate, which is the coordinate the grid's columns are
// keyed by (`alignmentCoord`), so no translation happens here — if that ever stops being true this
// band is the thing that will look wrong first, which is the right place for it to show.
function alignmentSegBand(chunk, segments, _rulerLabel) {
  if (!segments || !segments.length) return '';
  const lo = (x) => (x.start === '-inf' ? -Infinity : x.start);
  const hi = (x) => (x.end === '+inf' ? Infinity : x.end);
  let any = false;
  const cells = chunk.map((p) => {
    // COMPARE IN THE COLUMN'S OWN COORDINATE, not the printed label. This used to map `p` through
    // `rulerLabel` first — the representative material's own numbering — and then test it against
    // bounds written in the IDEA frame. The two agree for human H3, which is why it looked right;
    // they do not for a material whose numbering is offset (yeast H2B prints 123 for idea 120), and
    // there the band slid off the residues it describes. The ruler relabels what is PRINTED; it
    // must not change what a position MEANS.
    const n = p;
    if (n == null) return '<span>&nbsp;</span>';
    const seg = segments.find((x) => lo(x) <= n && n <= hi(x));
    if (!seg) return '<span>&nbsp;</span>';
    any = true;
    return `<span class="al-seg ${seg.certainty === 'defined' ? 'seg-d' : 'seg-n'}" `
         + `title="${seg.certainty === 'defined' ? 'defined' : 'native'} extent `
         + `${seg.start === '-inf' ? 'N-terminus' : seg.start}\u2013${seg.end === '+inf' ? 'C-terminus' : seg.end}">&nbsp;</span>`;
  });
  if (!any) return '';                       // this block lies entirely outside the stated extent
  return `<div class="al-row al-segrow"><span class="al-label"></span>`
       + `<span class="al-rseq">${cells.join('')}</span></div>`;
}

// Build the "possible sequences" alignment grid HTML (materials-alignment-grid-design §2,§6).
// model = { coord, positions[], rows[], conserved, counts:{pos:{res:n}} }.
// modPositions = Set of coordinate positions the query modifies (highlighted columns).
// Returns an HTML string (buildMaterialCard composes card bodies as strings). Residues
// are whitespace-free coloured monospace spans: columns align by monospace width, each
// residue keeps its colour, and a drag-select within a row copies clean residues (the
// label is user-select:none so it never pollutes the copy).
//
// Colouring is by MAJORITY, not strict conservation: a residue is left uncoloured only if
// it agrees with MORE than half of the PRESENT residues at its position (a gap is not
// counted either way; a tie is coloured). So a lone divergent variant (CENPA among the
// H3s) lights up while the agreeing majority stays quiet.
// `driftIdea` (Stage B) is Map<ideaPos, {from,to}> — positions where the SOURCE material and the
// target differ. Grid columns are idea positions, so this keying is the one that lines up.
// Visual language (from the design prototype): a MARK is a fill, species DRIFT is an outline. They
// compose — a mark sitting on a drifted position gets both, which is the case worth reading twice.
// `driftIdea` and `segments` are both in COLUMN space — the same coordinate as `modPositions` — so
// this function reads one numbering throughout. `segmentsText` is the reader's own numbering, used
// only where the extent is NAMED rather than drawn.
function alignmentGridHtml(model, modPositions, driftIdea, segments, segmentsText) {
  if (!model || !model.rows.length) return '';
  const mods = modPositions || new Set();
  const drift = driftIdea || new Map();
  // Columns are idea positions; the RULER is printed in the representative material's own
  // numbering (Result 4 — a number belongs to a context, a class does not).
  const num = model.numbering;
  // `colMap` (aln_column → the representative's own residue number) answers over insertion columns
  // too; `map` (idea position → own number) is the fallback for a model built without columns, which
  // is what the pure-pivot callers and the render tests hand in.
  const rulerLabel = (num && (num.colMap || num.map))
    ? ((c) => {
        if (num.colMap && num.colMap.has(c.col)) return num.colMap.get(c.col);
        if (c.pos != null && num.map && num.map.has(c.pos)) return num.map.get(c.pos);
        return null;
      })
    : ((c) => c.pos);

  // The columns to draw. `model.display` carries the insertion columns and the collapsed gutters;
  // a model built by a caller that predates them (the pure pivot, the render tests) falls back to
  // its idea positions, each standing as its own column.
  const columns = model.display
    || (model.columns || model.positions.map((p) => ({ col: p, pos: p })));
  const nRows = model.rows.length;

  // OUT OF THE STATED EXTENT. A segment declares which residues are PRESENT, so under `H3[1-30]`
  // residues 31+ are not part of the molecule — printing them in the same ink as the rest states a
  // longer chain than the query does. They are dimmed rather than removed: the columns are what
  // make one card comparable with another, and a truncated H3 that no longer lines up with a
  // full-length one would trade one wrong reading for a worse one. The band below says which
  // certainty each kept region carries; this says where the molecule stops.
  const segLo = (x) => (x.start === '-inf' ? -Infinity : x.start);
  const segHi = (x) => (x.end === '+inf' ? Infinity : x.end);
  const hasExtent = segments && segments.length &&
    !(segments.length === 1 && segments[0].start === '-inf' && segments[0].end === '+inf');
  // A COLUMN THE FRAME CANNOT NAME IS OUTSIDE EVERY STATED EXTENT, and this line is the whole of it
  // (BB, 2026-07-31). The mass is summed in SQL by `segmentWhere` — one bounded comparison on one
  // column, which a NULL coordinate can never satisfy — so an insertion residue is already out of
  // the number. It was still drawn in full ink, because the insertion branch below short-circuits
  // past `cellClass`: `H2A.Z[1-20]` printed AGGKAGKDSGKAKTKAVSRSQR beside 1931.1 u, twenty-two
  // residues beside nineteen residues' worth, disagreeing by exactly the KAG that H2A.Z carries and
  // canonical H2A does not. Two selections over one extent — and NEITHER was the peptide:
  // `H2A.Z[1-20]` is twenty residues, AGGKAGKDSGKAKTKAVSRS, 1904.16 u average / 1903.06 u
  // monoisotopic. The 22-letter string is `H2A.Z[1-22]`. `p == null` IS "the frame has no name
  // for this", so answering it here makes the two the same rule rather than two that agree.
  // THE COLUMN IS WHAT THESE TEST AGAINST (2026-08-03). `modPositions` and `segments` arrive in the
  // COLUMN coordinate, because the grid's geometry is columns and the printed `family_position` is
  // only a label. They used to be compared against `p`, the printed number, while the caller handed
  // in AUTHORED positions — so `H2A.Z:K7ac` shaded the cell labelled 7, which is H2A.Z's own 9, a
  // serine. And the summed extent had already moved to columns, so the drawn extent and the mass
  // disagreed: the exact pair this design exists to keep together.
  //
  // A caller with no columns (the pure pivot, the render suites) gets `col === pos` from the fallback
  // in `columns` above, so this is transparent for them.
  const outsideExtent = (c) => {
    if (!hasExtent) return false;
    if (c == null) return true;
    return !segments.some((x) => segLo(x) <= c && c <= segHi(x));
  };

  // The mark's own shading, as ONE writer, because two branches now need it — the ordinary cell and
  // the queried insertion column below. Physical-possibility verdict (the walk, via
  // materialize-card): impossible accessions were already dropped, so a mod cell here is accept or
  // warn. warn = the stated wt disagrees with this material (the mark still stands).
  const modClass = (row, c) => {
    const st = row && row.verdict && row.verdict.byCol && row.verdict.byCol[c];
    return st === 'warn' ? 'mod warn' : 'mod';
  };

  const cellClass = (res, p, row, c) => {
    if (outsideExtent(c)) return res == null ? 'ares gap outside' : 'ares outside';
    if (res == null)      return 'ares gap';
    if (mods.has(c)) return 'ares ' + modClass(row, c) + (drift.has(c) ? ' drift' : '');
    if (drift.has(c)) return 'ares drift';
    const matches = (model.counts[p] && model.counts[p][res]) || 0;
    const mismatches = (model.present[p] || 0) - matches;      // present residues only
    return matches > mismatches ? 'ares cons' : 'ares vary';   // tie → coloured
  };

  // THE SHADING EXPLAINS ITSELF — IN THE READOUT, NOT IN A POPUP (BB, 2026-07-31).
  //
  // This meaning used to live in a standing legend above the cards (`.driftlegend`), which is a
  // second place to maintain and had already drifted from the thing it described: its "mark"
  // swatch was a red tint, months after marks stopped being red. A legend states what the page is
  // DOING; this states what THIS cell IS, so it cannot go stale separately. That part is unchanged.
  //
  // What changed is the instrument. It was a per-cell `title`, added the same week as a status line
  // that answers the same gesture — so pointing at a modified residue wrote its identity to the
  // readout immediately and then, half a second later, popped a native tooltip over the columns
  // being compared. The cell now states its state as DATA and the readout does the talking; see the
  // subject split in `readoutFor`. Only cells with something non-obvious to say carry the attributes
  // — conservation (`cons`/`vary`) is the default reading of the grid, explained once in the meta
  // line above it, and would be noise on all ~1,500 cells.
  // `c` is the COLUMN, `p` the printed `family_position`. `cellClass` moved to the column when the
  // grid did; this did not, so the CSS class landed on one cell and `data-state` on another for any
  // token that renumbers — `H4:K16ac` is column 17 and family_position 16. Reviewed 2026-08-05.
  const stateData = (res, p, row, c) => {
    if (res == null) return '';
    const d = drift.get(c);
    const isMod = mods.has(c);
    const warn = isMod && row && row.verdict && row.verdict.byCol && row.verdict.byCol[c] === 'warn';
    let out = '';
    if (isMod) out += ` data-state="${warn ? 'warn' : 'mod'}"`;
    if (d) out += ` data-drift="${escapeAttr(d.from)}→${escapeAttr(d.to)}"`;
    return out;
  };

  // Chunk COLUMNS into stacked blocks; each block gets a decade ruler + row labels.
  let blocksHtml = '';
  for (let start = 0; start < columns.length; start += AL_BLOCK) {
    const chunk = columns.slice(start, start + AL_BLOCK);
    const rowsHtml = model.rows.map(row => {
      let seq = '';
      for (const c of chunk) {
        // A COLLAPSED INSERTION RUN. One cell standing for a whole run, drawn between the two idea
        // columns it sits between. The count is per row, because a run is shared by the card and
        // carried by each molecule to its own extent — macroH2A's macro domain is 213 columns and
        // canonical H2A carries none of them.
        if (c.gutter) {
          const n = c.cols.reduce((k, x) => k + (row.colCells[x] != null ? 1 : 0), 0);
          // The run's extent travels as data so the readout can word it; `after`/`before` may each be
          // null at a terminus, and the empty attribute is how that reaches `readoutFor` as null.
          seq += `<span class="ares ins-run${n ? '' : ' gap'}" data-run="${n}"`
               + ` data-after="${c.after == null ? '' : c.after}"`
               + ` data-before="${c.before == null ? '' : c.before}">${n ? '⟩' : '·'}</span>`;
          continue;
        }
        const p = c.pos;
        // AN INSERTION COLUMN CARRIES NO `data-pos` — it has no idea number, and printing one would
        // invent it. It DOES carry `data-aln`, and since 2026-08-03 that is what the highlight layer
        // paints by, so an insertion residue is addressable while still being unnumbered. The two
        // attributes answer different questions: `data-aln` is WHICH SITE, `data-pos` is WHAT THE
        // RULER CALLS IT, and only the second can be absent.
        const isIns = p == null;
        const res = isIns ? row.colCells[c.col] : row.cells[p];
        const own = row.ownAt ? row.ownAt[c.col] : null;
        // AN INSERTION COLUMN THE QUERY NAMED IS STILL THE SITE THE READER ASKED ABOUT (2026-08-07).
        // State is reported only where a residue is actually shaded for it, and an insertion column
        // says something about the COLUMN which the readout leads with and which outranks what the
        // shading would say about the residue — while the insertion is INCIDENTAL. Under
        // reference-sequence numbering it always was: a query's mark had an idea position, so it
        // could not land here. Since the walk (2026-08-03) it can, and `H2AX:S139ph` is exactly that
        // — column 177, which canonical H2A P0C0S8 has no `family_position` for. So the rule was
        // suppressing the one residue the query names. `mods.has(c.col)` is the distinction; an
        // unqueried insertion is unchanged.
        const isQueriedMod = mods.has(c.col);
        const st = ((isIns && !isQueriedMod) || outsideExtent(c.col)) ? '' : stateData(res, p, row, c.col);
        // `ins-col` still says WHICH kind of column this is — the readout leads with that — and
        // `outside` says the stated extent does not reach it, which is the same verdict the mass
        // query reached about the same residue. Both, because they are two different facts. The
        // mark joins them on the same terms: a queried insertion is two facts, not a choice.
        const cls = isIns
          ? (res == null ? 'ares gap ins-col'
                         : 'ares ins-col' + (isQueriedMod ? ' ' + modClass(row, c.col) : ''))
            + (outsideExtent(c.col) ? ' outside' : '')
          : cellClass(res, p, row, c.col);
        seq += `<span class="${cls}"${st}`
             + (isIns ? '' : ` data-pos="${p}"`)
             + ` data-aln="${c.col}"${own == null ? '' : ` data-own="${own}"`}>${res == null ? '-' : res}</span>`;
      }
      const label = row.uniprotName || row.uniprot_id;
      // A row whose own numbering differs from the printed ruler, as a MARKER and not a number.
      // The number it used to print was the offset at the first position where the two frames part,
      // stated as though constant; across the H2A.Z clade every row has three or more distinct
      // offsets and across H1 one row has thirteen. A degree sign says the one thing that is true of
      // the whole row, and the per-residue numbers live in the readout under the grid, where the
      // fact varies per residue as it actually does.
      const offTag = row.ownShifted
        ? `<sup class="al-off" title="${escapeAttr(`${label} numbers these residues in its own frame, not the one printed above`
            + (row.ownFrames > 1 ? ` — and not by a constant offset: ${row.ownFrames} different offsets across this grid` : '')
            + '. Point at any residue for its own number.')}">°</sup>`
        : '';
      const full = `${row.name || ''}${row.species ? ' · ' + abbrevSpecies(row.species) : ''} · ${row.uniprot_id}`;
      return `<div class="al-row" data-acc="${row.uniprot_id}" data-variant="${row.variant ?? ''}" data-handle="${escapeAttr(label)}"><span class="al-label" title="${full}">${label}${offTag}</span>`
           + `<span class="al-seq">${seq}</span></div>`;
    }).join('');
    // THE BAND IS PART OF THE HEADER, NOT A ROW ABOVE THE ROWS. The ruler used to be sticky on its
    // own with the band as an ordinary sibling below it, which cost twice: the band scrolled away
    // under the header on a long block, so you kept the numbers and lost the extent they were
    // annotated with; and nudging the band up toward the digits ran it into the header's opaque
    // background, where a scrolled block painted over it. Both are the same mistake — the band
    // annotates the COORDINATE, so it belongs to the thing that carries the coordinate.
    //
    // Sticking them together makes the gap between them ordinary flow, so it is a plain margin
    // again rather than a negative one fighting a stacking context.
    // THE BAND KEEPS ITS `number[]` SIGNATURE. It compares against bounds written in the idea
    // frame, so it wants idea positions and nothing else; a column with none maps to `null`, which
    // it already renders as a blank. That blank is the right answer semantically too — an extent
    // written in the idea frame neither includes nor excludes a residue that has no idea position.
    blocksHtml += `<div class="al-block"><div class="al-head">`
                + `${alignmentRuler(chunk, rulerLabel)}`
                + `${alignmentSegBand(chunk.map(c => c.col), segments, rulerLabel)}</div>${rowsHtml}</div>`;
  }
  // `--seq-cols` is AL_BLOCK handed to the stylesheet: the block box is sized from it, so the
  // header's opaque background and the row tints cover a whole block instead of stopping at the
  // edge of the viewport when the grid is scrolled sideways.
  // A STATUS LINE, NOT A TOOLTIP, and not a `title` on every cell. A four-family human card set is
  // ~6,600 cells; a title naming the molecule and the number on each is +110–450 KB of HTML per
  // card, rebuilt on every query, and it would fire a delayed native popup on every cell the pointer
  // crosses — the "noise and DOM weight" this file already warns about, undercounted. A delegated
  // handler reading `data-own`/`data-pos` costs one listener and one node. Below the grid rather
  // than floating: it never occludes the columns being compared, and it reserves its line once
  // instead of reflowing the card on hover.
  // The extent in plain text, once per grid rather than once per dimmed cell, for the readout to
  // name when the pointer is on a residue the query has excluded. "Outside the stated extent" is a
  // verdict; saying WHICH extent is what lets the reader check it.
  const extText = hasExtent
    ? (segmentsText || segments).map((x) => `${x.start === '-inf' ? 'N' : x.start}–${x.end === '+inf' ? 'C' : x.end}`).join(', ')
    : '';
  // THE TOKEN THE CARD WAS WRITTEN UNDER, stated on the grid rather than inferred from it. It no
  // longer decides a numbering — every grid prints `family_position`, and the columns are addressed
  // by `data-aln` — so what it is for now is labelling and R12's segment anchor.
  return `<p class="al-meta">${gridMeta(model)}</p>`
       + `<div class="al-grid" style="--seq-cols:${AL_BLOCK}"`
       + (model.frame ? ` data-frame="${escapeAttr(model.frame)}"` : '')
       + (extText ? ` data-extent="${escapeAttr(extText)}"` : '') + `>${blocksHtml}</div>`
       + `<p class="al-readout" aria-live="polite"></p>`;
}

// A material cell shared by the mass and AM tables: the UniProtName mnemonic + its marks,
// e.g. "H33:K27M". The mark carries the per-accession wt (R27M when the accession diverges),
// coloured on a mismatch; the accession/protein-name/species live on hover.
//
// THE SEPARATOR IS A COLON, and it is load-bearing (BB, 2026-07-29). It used to be a hyphen, which
// made this the one place on the page writing a mark list against a handle with a separator the
// engine never emits — `H3-K4me3` is a community spelling the parser accepts and canonicalises
// away. With the colon the cell is not merely consistent, it is VALID NOTATION: a reader can select
// this text, paste it into the query bar, and land on exactly this material.
//
// THE HANDLE AND THE NUMBER COME FROM `emitMaterial` (BB, 2026-07-29), and the note that used to sit
// here — arguing the cell should stay hand-built and away from emit2 — was BACKWARDS in a way worth
// recording, because it is the reasoning that kept the bug alive. It claimed abstracting would
// "RENUMBER the mark into the idea frame (K120ub → K119ub)", i.e. that the marks arriving here were
// material-framed. They were not: they are idea positions (`shell.js`, "in IDEA positions"), so the
// cell was already printing an idea number under a material handle — `H2B2:K120ub` for a molecule
// carrying K123 — and the comment was the defence of that. Its example was wrong too: P33778 is not
// frame-shifted at all (`materialPos(P33778, 120) = 120`).
//
// The half it got right is preserved: a materials row is one row per ACCESSION, so it must NOT be
// abstracted — that would collapse distinct rows onto one idea token. The fix was not to keep the
// string away from the engine but to give the engine a material layer to speak: `emitMaterial`
// returns the verified handle and that molecule's own numbering as ONE answer, so the two cannot be
// chosen independently and disagree, which is exactly how they came to.
//   opts: { uniprotName, uniprot_id, handle, protein_name, species,
//           marks: [{label, mismatch, gap, stated, actual}] }
// THE TITLE TEXT, SHARED BETWEEN THE MATERIAL SPAN AND ITS ROW [BB 2026-09-24]. Pulled out of
// `materialCell` so a caller that wants the row's own `<tr title>` (see `rowPair`) does not
// recompute this join by hand and drift from what the cell itself says — two spellings of "which
// molecule" reaching different text is exactly the failure `materialCell`'s own comment below
// warns about for `raw` vs `label`.
function materialTitle(opts) {
  const raw = opts.notation || opts.handle || opts.uniprotName || opts.uniprot_id;
  const idParts = [opts.protein_name || '', opts.species ? abbrevSpecies(opts.species) : '', opts.uniprot_id]
    .filter(Boolean);
  const warn = (opts.warn || []).filter(Boolean);
  return [raw].concat(idParts).concat(warn).filter(Boolean).join(' · ');
}

function materialCell(opts) {
  // ONE STRING, from the emitter (BB, 2026-07-29). This used to be a handle span plus one `.mark` span
  // per mark, assembled here. The cell's promise is that its text is valid notation for this molecule —
  // selectable, pasteable, and landing back on exactly this material — and that promise is easier to
  // keep when the string is produced by the emitter than when it is concatenated next to it. The chips
  // were also a second visual vocabulary for something the sequence grid already colours.
  //
  // `notation` is `emitMaterial(...).notation`. `warn` is a list of ways THIS molecule's chemistry
  // departs from what the query stated — a different wild type, or no residue at all at that position.
  // Those are the same facts the grid marks in gold, so the cell says them the same way rather than
  // inventing a third treatment. A warning does not make the string untrue: it still describes the
  // molecule; it says the query and the molecule disagree about it.
  //
  // Falls back to the handle (or the accession) when the emitter refused — a bare material with no
  // marks is a complete answer, and it is the honest one when no mark can be placed.
  // STYLED, by the one styler (BB, 2026-08-06). The cell's promise is that its text is valid notation
  // for this molecule, and `styleNotation` keeps that promise or hands back the canonical string — it
  // re-parses its own output and declines rather than guess. So a material card and the caption above
  // it now spell the same molecule the same way, which they did not while each had its own rules.
  // Through `styleNotation`, which is now the one call page code makes to show notation: it runs
  // `canonNotation` (guards + elision) and then the spelling rules. The cell has a string rather
  // than an IR — it comes from `emitMaterial` — which is why both take either. Falls back to the raw
  // string if the pipeline declines it.
  const raw = opts.notation || opts.handle || opts.uniprotName || opts.uniprot_id;
  const label = styleNotation(raw) || raw;
  const warn = (opts.warn || []).filter(Boolean);
  // ── THE FULL DESCRIPTOR ALWAYS LEADS THE TOOLTIP ─────────────────────────────────────────────
  // "BECAUSE THE CELL MAY BE CUT" IS SUPERSEDED FOR THE LIVE PATH [caught reviewing IMPORTANT 5,
  // review-findings 2026-09-24 — the stale rule that name checks]. `td.mt-material .mt-notation` is
  // bounded and ellipsized (_shell.scss), but both callers of `materialCell` now pass `inline:
  // true` (this file, two call sites), so the only shape this ever ships is a `<span>` inside the
  // row's own identity line — and BB ruled that line WRAPS rather than truncates: "the identity
  // line is a full-width single cell, so wrapping costs no column geometry." The `<td>` shape (and
  // its ellipsis) is dead code kept for a future bounded caller (see `_shell.scss`'s own note at
  // `td.mt-material`), not a fact about what ships today.
  //
  // UNCONDITIONAL ANYWAY, and for a reason that does not depend on truncation: the cell shows
  // STYLED notation (`·`, subscripts) while this tooltip is `raw`, the machine spelling that is
  // valid for this molecule and lands back on it — the form you would paste into the query field.
  // That is worth stating whether or not the line has wrapped, so a short, fully-visible cell
  // repeats itself in its own tooltip on purpose, not as an unproven guess about overflow. (Even
  // where the old rationale still applies — the `<td>` shape, if a future caller asks for one — a
  // STRING return has no layout to probe, so this could not be conditional either way.)
  //
  // `raw`, NOT `label`. `label` is `styleNotation`'s output and is HTML; a title attribute is text,
  // so interpolating it would put markup in the tooltip.
  const title = materialTitle(opts);
  const inner = `<span class="mt-notation${warn.length ? ' mt-warn' : ''}" `
              + `title="${escapeAttr(title)}">${label}</span>`;
  // `opts.inline` RETURNS THE CONTENT WITHOUT ITS CELL. The material left the table's columns and
  // joined the row's own identity line [BB 2026-09-23], where it is one term in a phrase rather
  // than a cell — so the callers that build a pair ask for the span and the ones that still build
  // a cell get the `<td>` they always did. One function either way: the tooltip, the styling
  // fallback and the warn treatment are the part worth sharing, and they are all above this line.
  return opts.inline ? `<span class="mt-material descriptor">${inner}</span>`
                     : `<td class="mt-material descriptor">${inner}</td>`;
}

// Titles are the only place this file interpolates prose that can contain a quote (a residue letter
// cannot, but a protein name can). Kept local and minimal — render.js has no escaping helper and did
// not need one while every title was an accession or a species.
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Per-material mass table (one row per possible accession, grid order). Unified with the
// AM table: Material (name + mark pill) · MW (kDa) · Mass (u) · Paralog · Species. The
// MW/Mass are the MODIFIED values (base + per-accession Δ); no base/delta columns.
//   row = { uniprot_id, uniprotName, name, species, variant, complete,
//           baseAvg, baseMono, dAvg, dMono, unknown, applied:[{label,gap,mismatch,…}] }
function alignmentMassTableHtml(rows /* , hasMods (unused: mark lives in Material) */) {
  if (!rows || !rows.length) return '';
  // TWO PRECISIONS, ONE FOR SCANNING AND ONE FOR TAKING [BB 2026-08-11]. The column is read DOWN a
  // list of materials, where 1 dp is what a reader compares; the exact figure is what they copy into
  // a notebook, and it is revealed IN PLACE on hover (`.mw-full`, _shell.scss) rather than in a
  // `title` — a native tooltip cannot be selected, so a hover showing a number nobody can take is
  // only half the feature. The revealed text is ordinary DOM content, so it selects and copies.
  //
  // 4 dp is the reveal, NOT the storage: `average_mass` carries 5 decimals in Da, which is 8 in kDa,
  // and printing all of them would state a precision the mass tables do not claim.
  const kDa     = a => (a / 1000).toFixed(1) + ' kDa';   // scanned
  const kDaFull = a => (a / 1000).toFixed(4) + ' kDa';   // taken
  const uMass = m => m.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' u';
  const staleMass = [];                  // accessions the mass table has no row for — see below
  const body = rows.map(row => {
    // MATERIAL, VARIANT AND SPECIES ARE THE ROW'S IDENTITY LINE now, not three of its five columns
    // [BB 2026-09-23]. Absent parts are simply not written, which is why `identityLine` takes the
    // values rather than pre-built cells: Paralog and Species printed an em-dash each on every row
    // that had neither, and two columns of em-dashes is the emptiest thing a table can hold.
    const matOpts = { uniprotName: row.uniprotName, uniprot_id: row.uniprot_id,
                      handle: row.handle, notation: row.notation, warn: row.warn,
                      protein_name: row.name, species: row.species, inline: true };
    const mat = materialCell(matOpts);
    const sp  = row.species ? abbrevSpecies(row.species) : '';
    const par = (row.variant && row.variant !== 'NA') ? row.variant : '';
    const ident = identityLine(mat, par, sp);
    // The identifying attributes stay on the DATA row — `measurement-highlight` addresses these
    // through `tr[data-acc]`, and moving them to the group would stop every such selector matching.
    const rowAttrs = ` data-acc="${row.uniprot_id}" data-variant="${row.variant ?? ''}"`;
    const pair = (cells) => rowPair(ident, cells, 2, { rowAttrs, title: materialTitle(matOpts) });
    // A stated extent this material has no residues in. Not a light molecule — a material the
    // query does not reach. A number here would be a claim; this is the absence of one.
    if (row.extentEmpty)
      return pair(`<td class="mt-na" colspan="2">outside the stated extent</td>`);
    // Two different absences, and they used to print the same words. `massKnown === false` means
    // protein_masses has NO ROW for this accession — the table is stale against proteins.parquet, a
    // build fault the reader can do something about. `complete === false` is the deliberate chemical
    // refusal (a non-standard residue has no mass to sum). Saying "mass unavailable" for both let a
    // stale artifact read as a fact about the molecule for as long as nobody queried a yeast histone.
    // THE BUILD INSTRUCTION IS NOT IN THIS TOOLTIP [BB 2026-08-08]. It used to end with "Rebuild
    // with: make tables/protein_masses.parquet docs" — a shell command in a hover, addressed to
    // whoever built the site, shown to a reader who cannot run it and has no page it belongs to.
    // The cell says what is true of THIS material; the maintainer's half is raised once in
    // #enginewarn, which is the page's one alarm channel and already the place build faults are told.
    if (row.massKnown === false) {
      staleMass.push(row.uniprot_id);
      return pair(`<td class="mt-na" colspan="2" title="protein_masses.parquet has no row for ${row.uniprot_id}, so no mass can be shown for it">not in the mass table</td>`);
    }
    if (!row.complete || row.baseAvg == null)
      return pair(`<td class="mt-na" colspan="2" title="a residue in this chain has no registered mass, so no total can be summed">mass unavailable</td>`);
    if (row.unknown)
      return pair(`<td class="mt-na" colspan="2">${MW_UNAVAILABLE}</td>`);
    const avg = row.baseAvg + row.dAvg, mono = row.baseMono + row.dMono;
    // MW is the AVERAGE, Mass the MONOISOTOPIC, and BOTH SAY SO IN THEIR HEADER now — see the
    // column defs below. The per-row hover that used to carry it said `X average · Y monoisotopic`
    // on both cells, which is the cell you are on restated in the other's unit plus the cell next to
    // it verbatim. A hover that repeats the column it hangs under is the column again, and it costs
    // a gesture to read [BB 2026-08-11].
    //
    // IT SURVIVES IN EXACTLY ONE CASE: a stated extent, where the cell answers a NARROWER question
    // than the reader asked. `3.4 kDa` for an H3 is not wrong, it is puzzling, and nothing else on
    // screen says why. That half was never the restatement, so it is what is kept.
    const massTitle = row.chainAvg != null
      ? `${row.extentN} residues of the stated extent; the whole chain is ${kDaFull(row.chainAvg)}`
      : '';
    const extMark = row.chainAvg != null ? '<span class="mt-extent" role="img" title="mass of the stated extent, not the whole chain" aria-label="mass of the stated extent, not the whole chain"></span>' : '';
    const massAttr = massTitle ? ` title="${escapeAttr(massTitle)}"` : '';
    // BOTH STRINGS ARE IN THE CELL and CSS decides which is visible, so the exact one is real text
    // the moment it is shown — selectable, copyable, no per-row id and no JS. The extent marker sits
    // OUTSIDE the pair: it annotates the cell, not either spelling of the number.
    const mwCell = `<span class="mw-swap"><span class="mw-short">${kDa(avg)}</span>`
                 + `<span class="mw-full">${kDaFull(avg)}</span></span>`;
    return pair(`<td class="mt-mw"${massAttr}>${extMark}${mwCell}</td>`
              + `<td class="mt-mw"${massAttr}>${uMass(mono)}</td>`);
  }).join('');
  // The maintainer's half of "not in the mass table", raised ONCE for the whole table rather than
  // per row, and keyed so a re-render replaces it. Guarded on `engineNotice` because render.js is
  // also require()d by the node suites, where there is no page and no alarm channel to write to.
  if (staleMass.length && typeof engineNotice === 'function')
    engineNotice('mass-table-stale',
      `<b>Mass table is stale</b> — <code>protein_masses.parquet</code> has no row for `
      + `${staleMass.length} accession${staleMass.length === 1 ? '' : 's'} the query reached `
      + `(${staleMass.slice(0, 6).join(', ')}${staleMass.length > 6 ? ', …' : ''}), so the mass `
      + 'cells for them are empty. The molecules are fine; the table is behind '
      + '<code>proteins.parquet</code>.'
      + '<br><span class="hint">rebuild with <code>make tables/protein_masses.parquet docs</code>.</span>',
      'query');
  // TWO COLUMNS, from five. Material, Paralog and Species moved to the row's identity line, so
  // what remains is the two numbers — which is the whole point: at 402px five columns had no
  // honest rendering and these two have room to be read.
  const columns = [{ header: 'MW',   width: '50%', title: 'Average molecular weight' },
                   { header: 'Mass', width: '50%', title: 'Monoisotopic mass' }];
  return renderLayerTable(columns, body, { wrapClass: 'scrollable-table mass-scroll' });
}

// Meta line for the alignment grid (extracted so alignmentGridHtml stays a single
// return path with the mass table appended by the caller).
function gridMeta(model) {
  const coordName = model.coord.replace('_position', '');
  const nRemoved = (model.removed && model.removed.length) || 0;
  // WHY THEY WENT, PER GROUP — not one sentence about chemistry over all of them [BB 2026-08-11].
  // The walk distinguishes three drop reasons and this printed the first one for every entry, so
  // `H3:K27M` reported CENP-A as PHYSICALLY IMPOSSIBLE when the node's own reason is `position-gap`:
  // a claim about chemistry aimed at a molecule with no residue there to refuse. The verdict was
  // split for exactly this on 2026-08-04 (walk2.js:190, R32) and one display site never read it.
  //
  // AND IT NAMED NOBODY. This read `r.name || r.uniprot_id`; the producer (materialize-card.js:92)
  // pushes walk2's own reason records, which are keyed on `accession`. Both fields were undefined
  // for every entry, so the shipped tooltip was ", — a mark is physically impossible on them" — a
  // hover that promises molecules and lists empty strings. `alignment-model.js:155` documents the
  // shape as `{uniprot_id, …}` and that comment is what this was written against; the comment is
  // wrong, the producer is right, and the fallback chain below is ordered so either would work.
  //
  // ONE SPAN, and the label stays `N ruled out` [BB]. Splitting the count would put the distinction
  // where a reader sees it without hovering, at the cost of width in an already-dense meta line.
  const REMOVED_WHY = {
    'accession-ruled-out': n => `a mark is physically impossible on ${n === 1 ? 'it' : 'them'}`,
    'position-gap':        n => `no residue at that position`,
    'no-frame':            n => `no alignment to the family reference, so ${n === 1 ? 'it is' : 'they are'} not in these columns`,
  };
  const removedNote = nRemoved
    ? ` &middot; <span class="al-removed" title="${escapeAttr(
        Object.entries(model.removed.reduce((g, r) => {
          const k = REMOVED_WHY[r.reason] ? r.reason : 'accession-ruled-out';
          (g[k] = g[k] || []).push(r.accession || r.name || r.uniprot_id || '?');
          return g;
        }, {})).map(([k, who]) => `${who.join(', ')} — ${REMOVED_WHY[k](who.length)}`).join('; ')
      )}">${nRemoved} ruled out</span>`
    : '';
  // What the coordinate CLAIMS. `family` means the columns correspond across materials; `protein`
  // means each row is on its own numbering and no column asserts a correspondence — which is the
  // honest report for a set the family reference cannot speak for. That set is now EMPTY: it was
  // H2B.W and all of H1 until both gained frames on 2026-07-28, then the two curated non-histones
  // (Q5SSJ5, Q149N8), and on 2026-08-15 `action: exclude` stopped shipping those at all. The branch
  // is kept because the STATE is a property of the data, not of today's registry — one unalignable
  // sequence brings it back — and saying "aligned on protein" would be a false claim of alignment.
  const frameNote = model.frameless
    ? ` &middot; <span class="al-noframe" title="These sequences have no alignment to the family reference, so positions cannot be compared across them.">own numbering &mdash; no correspondence to the reference</span>`
    : ` &middot; aligned on ${coordName}`;
  // Some, but not all, of the kept set is unalignable. They are not ruled out and must not read as
  // if they were; they simply cannot be placed in these columns.
  const nUnframed = (model.unframed && model.unframed.length) || 0;
  const unframedNote = nUnframed
    ? ` &middot; <span class="al-noframe" title="${model.unframed.join(', ')} — no alignment to the family reference, so ${nUnframed === 1 ? 'it is' : 'they are'} not placed in these columns">${nUnframed} not alignable</span>`
    : '';
  // Only worth saying when the printed numbers are NOT the reference's — otherwise it is noise.
  const num = model.numbering;
  const numberNote = (num && num.shifted)
    ? ` &middot; <span class="al-numbering" title="Columns are aligned positions; the ruler prints ${num.name || num.uniprot_id}'s own residue numbers.">numbered as ${num.name || num.uniprot_id}${num.species ? ' (' + abbrevSpecies(num.species) + ')' : ''}</span>`
    : '';
  // Insertion runs too long to draw out. Said at the level where the truncation happened — this used
  // to be a "+N" badge on each row LABEL, which reported a magnitude and never a place.
  const gutters = (model.display || []).filter(c => c.gutter);
  const insNote = gutters.length
    ? ` &middot; <span class="al-insnote" title="${gutters.map(g => `${g.cols.length} columns ${g.after == null ? 'before ' + g.before : g.before == null ? 'after ' + g.after : 'between ' + g.after + ' and ' + g.before}`).join('; ')}">${gutters.length} insertion${gutters.length !== 1 ? 's' : ''} not expanded (${gutters.map(g => g.cols.length).join(', ')} columns)</span>`
    : '';
  return `${model.rows.length} sequence${model.rows.length !== 1 ? 's' : ''}`
       + frameNote + numberNote + unframedNote + insNote + removedNote;
}

// "Homo sapiens" \u2192 "H. sapiens" (genus abbreviated). Species text comes from
// proteins.parquet per accession; no organisms.tsv round-trip needed.
function abbrevSpecies(s) {
  if (!s) return '';
  const p = s.trim().split(/\s+/);
  return p.length < 2 ? s : p[0][0].toUpperCase() + '. ' + p.slice(1).join(' ');
}

// Shown in place of a mass whenever any component symbol is absent from the mass
// tables. The alternative — treating the unknown part as 0 — reports the mass of the
// UNMODIFIED molecule at full precision, which is indistinguishable from a correct
// answer. A refusal is recoverable; a confident wrong number is not.
const MW_UNAVAILABLE = 'MW unavailable (unknown symbol)';

// docs/_includes/js/measurement-highlight.js
// Measurement → sequence highlight (feature #1). PURE core: derive the per-family
// grid overlay for a measurement row group. Positions are the GRID coordinate, which is
// `family_position` — the IDEA coordinate. Marks come from each lookup row's `position`, i.e.
// `query_position = COALESCE(family_position, variant_position)`, and the background from each
// prep-resolved context modification. NOT `variant_position`, which this header used to name: that
// is a real and DIFFERENT column (the variant reference), which is what made the wrong name
// dangerous rather than merely untidy. Idea coordinates throughout — an overlay paints grid columns,
// and the grid's columns are idea positions even when a row is LABELLED in its own numbering.
//
// WHICH idea frame those columns are in is now the QUERY's to state (spec 2026-07-31): under a
// variant token the grid is keyed in that variant's own numbering, so a mark carries its
// `aln_column` and the DOM layer places it by that column — `siteOf` below. The pure core stays DOM-free and
// does no translation of its own; it reports the coordinate the datum came with.
(function (root) {
  'use strict';

  function keyOf(family, variant) {
    var v = (variant && variant !== 'NA') ? variant : '';
    return family + '|' + v;
  }

  // group -> Map<famVarKey, { accession, marks:[…], drift:[…] }>
  //
  // `registry` is optional and falls back to the engine's, exactly as `driftBetween` below does.
  // BEWARE `\u0041rray.map(overlayForGroup)`: `map` passes (element, index, array), so the index
  // would land in `registry`. The one call site passes an explicit arrow for that reason.
  function overlayForGroup(group, registry) {
    var rows = (group && group.rows) || [];
    var meta = (group && group.meta) || {};
    var ctxMods = meta.context || {};
    var byKey = new Map();

    function ensure(family, variant, accession) {
      var k = keyOf(family, variant);
      if (!byKey.has(k)) byKey.set(k, { accession: accession || null, variant: (variant && variant !== 'NA') ? variant : null, marks: [], drift: [] });
      var e = byKey.get(k);
      if (!e.accession && accession) e.accession = accession;
      return e;
    }

    // Marks: matched lookup rows, on the consensus position (grid coordinate).
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.position == null) continue;
      var e = ensure(r.family, r.variant, r.uniprot_id);
      e.marks.push({
        position: r.position,
        // WHICH COORDINATE `position` IS. `query_position` is family_position where the family
        // reference has a counterpart and the datum's own variant-frame number where it does not,
        // and the two are different numbers on the same row set. Carried so the DOM layer can say
        // which column of a variant-framed grid this mark belongs to instead of assuming.
        frame: r.position_frame != null ? r.position_frame : 'family',
        // the SITE, independent of whose numbering the row's own `position` is in
        aln_column: r.aln_column != null ? r.aln_column : null,
        family: r.family != null ? r.family : null,
        residue: r.residue != null ? r.residue : null,
        variant: r.substitution != null ? r.substitution : null,
        modification: r.modification != null ? r.modification : null
      });
    }

    // Background construct: prep-resolved context mods carry variant_position +
    // residue. Only residue swaps outline (v1: PTM-type background is out of scope).
    //
    // AND THEIR COLUMN, WHICH IS WHAT THE DOM LAYER PLACES BY. `siteOf` reads `item.aln_column` and
    // nothing else — that is the columns rule (2026-08-03), and the marks above were given
    // `aln_column` when it landed. These were not: they kept only `variant_position`, the
    // pre-columns coordinate, so `siteOf` answered null and `decorate` dropped every one of them
    // with `if (at == null) return;`. Silently, and for every dataset that declares a construct
    // background — the C96A/C110A cysteine-free H3 the barcoded libraries are built on never
    // appeared on the grid at all. The derivation below was right the whole time and the suite
    // asserted it; nothing asked whether the result could be placed.
    //
    // `colAt` takes the molecule's OWN mature position, so it is `b.position` — the number the
    // depositor wrote — and not `variant_position`, which is a different frame's answer.
    var reg = registry
      || ((typeof nucleosomeParser2 !== 'undefined') && nucleosomeParser2.DEFAULT_REGISTRY) || null;
    byKey.forEach(function (e, k) {
      var parts = k.split('|');
      var family = parts[0], variant = parts[1] || null;
      var bg = ctxMods[variant] || ctxMods[family] || null;
      if (!bg || !bg.modifications) return;
      for (var j = 0; j < bg.modifications.length; j++) {
        var b = bg.modifications[j];
        if (b.variant_position == null) continue;   // unresolved → not painted
        if (b.substitution == null) continue;               // no residue swap → nothing to outline
        if (b.residue != null && b.residue === b.substitution) continue;  // no-op sub
        if (e.drift.some(function (d) { return d.position === b.variant_position; })) continue;
        var col = (reg && reg.colAt && bg.uniprot_id != null && b.position != null)
          ? reg.colAt(bg.uniprot_id, b.position) : null;
        e.drift.push({ position: b.variant_position, aln_column: col != null ? col : null,
                       from: b.residue != null ? b.residue : null, to: b.substitution });
      }
    });

    return byKey;
  }

  // ── the datum's own material, against what is on screen ───────────────────
  // THE THIRD DRIFT LAYER (BB, 2026-07-29). A query in one organism, ported to a second, may be
  // answered by a datum measured in a third. Relevance is decided on the idea layer and says nothing
  // about organisms, so the sequence layer is where the difference has to be shown:
  //
  //   baseline drift   source → port          (portAlignment, drawn on the grid already)
  //   datum drift      what is DISPLAYED → the datum's own material     ← this
  //
  // Against the PORT, not against the source: the row shows the ported residue, so a second outline
  // on that cell means "and the datum's organism differs from THAT too". Both shadings then describe
  // something visible on screen and compose; taken against the source they would contradict wherever
  // source and port already drift, which is exactly the interesting set.
  //
  // Computed per ROW, because the answer differs by row — a datum's material may agree with one
  // candidate and not another, and collapsing that to one verdict would invent agreement.
  //
  // Scoped to the positions the datum SPEAKS ABOUT. A whole-sequence third-organism diff is a
  // property of two proteins, not of this measurement; the positions the datum makes a claim at are
  // the ones where a difference changes what the claim means.
  // `frame` is the grid's frame — the numbering `positions` are written in. Omitted → the family
  // frame, which is every caller that predates the frame rule. It is not optional in the other
  // direction: reading a variant-frame number as a family one lands on a different residue and
  // reports a difference between two molecules at a position neither side was asked about.
  function driftBetween(rowAccession, datumAccession, positions, registry, frame) {
    var reg = registry
      || ((typeof nucleosomeParser2 !== 'undefined') && nucleosomeParser2.DEFAULT_REGISTRY);
    if (!reg || !reg.residueAt || !rowAccession || !datumAccession) return [];
    if (rowAccession === datumAccession) return [];        // same molecule: nothing to say
    var out = [], seen = {};
    for (var i = 0; i < (positions || []).length; i++) {
      var p = positions[i];
      if (p == null || seen[p]) continue;
      seen[p] = 1;
      // `positions` are COLUMNS now, so the residues are read at the column in each molecule's own
      // sequence — no frame, and an insertion column answers like any other.
      var shown = reg.residueAtCol ? reg.residueAtCol(rowAccession, p) : null,
          datum = reg.residueAtCol ? reg.residueAtCol(datumAccession, p) : null;
      // A null on either side is an absence of correspondence, not a difference. Painting it would
      // claim a substitution where the honest statement is "this position has no counterpart".
      if (shown == null || datum == null || shown === datum) continue;
      out.push({ position: p, from: shown, to: datum });
    }
    return out;
  }

  // ── DOM layer (browser only; requires document + the grid/card hooks) ──────
  var measSel = new Set();     // latched measurement ids
  var measHover = null;        // transient hover preview (single mid)

  function esc(v) {
    return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(String(v)) : String(v);
  }

  // "EVERY ROW" MEANS EVERY MATERIAL. The grid also draws a ruler and a segment band as `.al-row`
  // (they need the same column geometry), and neither is a molecule — banding them says a datum was
  // measured on a coordinate legend. `data-acc` is what makes a row a material, so it is the test.
  var MATERIAL_ROWS = '.al-row[data-acc]';

  // ── a datum's coordinate → the column of THIS grid (spec 2026-07-31) ────────────────────────────
  // A grid drawn under a variant query keys its columns in that variant's own numbering — that is
  // what makes an insertion column (H2A.Z's K4/A5/G6) addressable at all. A datum's `query_position`
  // is in one of two frames, and only one of them already agrees:
  //
  //   the datum is variant-framed → its number IS the variant frame's; paint it as it stands
  //   the datum is family-framed  → a family position, which on a variant grid names a different
  //                                 residue; invert it through the frame, and paint nothing when
  //                                 the frame has no name for it (null, never an approximation)
  //
  // On a family-framed grid nothing moves, which is every query against 22 of the 32 tokens.
  function gridFrameOf(grid) {
    return (grid && grid.getAttribute && grid.getAttribute('data-frame')) || null;
  }
  // WHERE THIS DATUM POINTS ON THE GRID — the COLUMN, and nothing else (BB, 2026-08-03).
  //
  // The grid is addressed by `data-aln`; the number under a residue stays `family_position` and stays
  // gapped, so an insertion cell shows no number and is still a target. That split is what removes
  // the last conversion from this file. It used to translate a datum's number into the grid's FRAME
  // (`framePos`), then into the grid's family name (`ownAtCol(canon, col)`) — two coordinates and a
  // rule for choosing, where there is one site.
  //
  // A row with no column is outside the alignment (42,503 lookup rows, almost all H1, which §9.1 of
  // the design says should not be numbered from this alignment). It points at nothing rather than at
  // an approximation.
  function siteOf(item) { return item && item.aln_column != null ? item.aln_column : null; }

  function markTitle(m) {
    var base = (m.residue || '') + m.position;
    if (m.variant) return base + '→' + m.variant + ' (measured mark)';
    if (m.modification) return base + ' ' + m.modification + ' (measured mark)';
    return base + ' (measured)';
  }

  // Decorate the alignment grid for one measurement's overlay. Synchronous class
  // toggling: light the card, band the measured accession's row (or all rows if
  // that accession is not among the query's candidates), fill mark columns and
  // outline background columns.
  //
  // TARGET BY ACCESSION (uniprot_id), not by family|variant card key: a measurement
  // resolves to a specific variant (e.g. H3.3) whose card key (H3|H3.3) need NOT
  // match a variant-agnostic query card (H3|) — but its accession IS one of that
  // card's possible-sequence grid rows (data-acc). So locate the grid rows by
  // accession and derive the card from them; fall back to the family|variant card
  // only when the accession is not among any grid row (degrade to column-decoration).
  function applyOneOverlay(overlay) {
    overlay.forEach(function (ov, key) {
      var accRows = ov.accession
        ? document.querySelectorAll('.al-row[data-acc="' + esc(ov.accession) + '"]') : [];
      if (!accRows.length && ov.variant)
        accRows = document.querySelectorAll('.al-row[data-variant="' + esc(ov.variant) + '"]');
      var card = accRows.length ? accRows[0].closest('.su')
               : document.querySelector('.su[data-cardkey="' + esc(key) + '"]');
      if (!card) return;
      card.classList.add('meas-lit');
      var grid = card.querySelector('.al-grid');
      if (!grid) return;
      var scope = accRows.length ? accRows : grid.querySelectorAll(MATERIAL_ROWS);
      var frame = gridFrameOf(grid);
      Array.prototype.forEach.call(accRows, function (r) { r.classList.add('meas-row'); });
      function decorate(items, cls, titleFn) {
        items.forEach(function (item) {
          var at = siteOf(item);
          if (at == null) return;                 // outside the alignment: no site to point at
          Array.prototype.forEach.call(scope, function (r) {
            var cell = r.querySelector('.ares[data-aln="' + at + '"]');
            if (cell) { cell.classList.add(cls); cell.setAttribute('title', titleFn(item)); }
          });
        });
      }
      decorate(ov.marks, 'meas-mark', markTitle);
      decorate(ov.drift, 'meas-drift', function (d) {
        return (d.from || '?') + d.position + '→' + d.to + ' (construct background)';
      });
      // Per ROW, so `decorate`'s paint-every-row-in-scope shape does not apply here.
      var markPos = ov.marks.map(siteOf)
                            .filter(function (p) { return p != null; });
      Array.prototype.forEach.call(scope, function (r) {
        var rowAcc = r.getAttribute && r.getAttribute('data-acc');
        driftBetween(rowAcc, ov.accession, markPos, null, frame).forEach(function (d) {
          var cell = r.querySelector('.ares[data-aln="' + d.position + '"]');
          if (!cell) return;
          cell.classList.add('meas-xdrift');
          // Says which molecule is which: a bare `K→R` here would read as a substitution the datum
          // reports, when it is a species difference between this row and where the datum came from.
          cell.setAttribute('title', 'this material has ' + d.from + ' here; the datum was measured on '
            + (ov.accession || 'another material') + ', which has ' + d.to);
        });
      });
    });
  }

  function applyMeasHighlights(overlays) {         // paint the union
    overlays.forEach(function (overlay) { applyOneOverlay(overlay); });
  }

  function clearMeasHighlight() {
    document.querySelectorAll('.su.meas-lit').forEach(function (c) { c.classList.remove('meas-lit'); });
    document.querySelectorAll('.al-row.meas-row').forEach(function (r) { r.classList.remove('meas-row'); });
    // `meas-xdrift` belongs in this list: it is only ever painted on cells that are also `meas-mark`,
    // so the selector already reached them and only the removal was missing — the underline outlived
    // its overlay and accumulated across hovers, which reads as a permanent property of the sequence.
    document.querySelectorAll('.ares.meas-mark, .ares.meas-drift').forEach(function (c) {
      c.classList.remove('meas-mark'); c.classList.remove('meas-drift'); c.classList.remove('meas-xdrift');
      c.removeAttribute('title');
    });
  }

  // ── a datum row (Mass · AlphaMissense) → the sequences it speaks about ─────
  // THE LINK IS THE IDEA POSITION, NOT THE ACCESSION (BB, 2026-07-30). This used to match a table
  // row to a grid row by uniprot_id equality. For Mass that can never miss — the mass rows ARE the
  // grid's rows. For AlphaMissense the two sets are different KINDS of thing: the grid holds the
  // candidates the query could mean, the table holds data that has been measured. Unported and human
  // they coincide, which is why identity looked like a link; under a port the grid is the TARGET
  // organism's materials and a human-scored datum matches nothing, silently, because an empty
  // NodeList throws nothing.
  //
  // WHEN THE ORGANISMS DISAGREE, COUPLE BY VARIANT (BB, 2026-07-30). Absence from the candidate set
  // is not a verdict about the datum — being ruled out is (that filter lives at the AM call site and
  // uses `verdicts.removed`). But "not this accession" does not license "all of them" either: a
  // human H3.1 score belongs beside the port's H3.1, not beside its H3.3. The variant IS the
  // idea-layer identity that survives the species change, so it is what carries the link across it.
  // Same ladder `applyOneOverlay` already walks for the latched overlay — accession narrows, variant
  // couples — and it stops there: a variant with no counterpart in the port has nothing on screen to
  // point at, and banding everything to avoid saying so would invent a relationship.
  //
  // What the column alone would still get wrong is implying the row's residue is the one scored, and
  // `driftBetween` is the answer to that — per row, at the one position the datum speaks about.
  //
  // No `title` here: the pointer is on the table row, so a tooltip on a grid cell is unreachable for
  // as long as the highlight exists. That also keeps this overlay from clobbering the titles the
  // latched measurement overlay owns — the two paint independently and share no attribute.
  function applyRowXref(tr, card, registry) {
    var grid = card && card.querySelector('.al-grid');
    if (!tr || !grid) return;
    var acc = tr.getAttribute('data-acc');
    var pos = tr.getAttribute('data-aln');       // the SITE, not the ruler's name for it
    var variant = tr.getAttribute('data-variant');
    var rows = acc ? grid.querySelectorAll('.al-row[data-acc="' + esc(acc) + '"]') : [];
    // Only material rows carry `data-variant`, so the ruler and the segment band are excluded by the
    // same attribute that does the coupling.
    if (!rows.length && variant && variant !== 'NA')
      rows = grid.querySelectorAll('.al-row[data-variant="' + esc(variant) + '"]');
    Array.prototype.forEach.call(rows, function (r) {
      r.classList.add('seq-xref');
      if (pos == null || pos === '') return;        // a mass row claims the molecule, not a residue
      var cell = r.querySelector('.ares[data-aln="' + esc(pos) + '"]');
      if (!cell) return;
      cell.classList.add('seq-xref-pos');
      // Own class, not `meas-xdrift`: the two overlays are independent layers with independent
      // clears, and sharing a class would let one erase the other's paint. Same style, set once.
      if (driftBetween(r.getAttribute('data-acc'), acc, [+pos], registry, gridFrameOf(grid)).length)
        cell.classList.add('xref-drift');
    });
  }

  function clearRowXref(card) {
    var scope = card || document;
    scope.querySelectorAll('.al-row.seq-xref').forEach(function (r) { r.classList.remove('seq-xref'); });
    scope.querySelectorAll('.ares.seq-xref-pos, .ares.xref-drift').forEach(function (c) {
      c.classList.remove('seq-xref-pos'); c.classList.remove('xref-drift');
    });
  }

  var api = { overlayForGroup, keyOf, measSel, measHover, applyMeasHighlights, applyOneOverlay, clearMeasHighlight, markTitle, driftBetween, applyRowXref, clearRowXref, siteOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/entails.js
// Phase 1 relevance matcher (non-pairing). Pure, DOM-free. See
// specs/2026-07-12-measurement-relevance-semantics.md §5, §6, §10.
(function (root) {
  'use strict';

  function _meta(row) {
    if (!row || row.metadata == null) return {};
    return typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
  }

  // Collapse one measurement's lookup rows into its pinned coordinates.
  function measurementConstraint(rows) {
    const coords = rows.map(r => ({
      family: r.family,
      position: r.position ?? r.variant_position,
      mod_value: r.substitution ?? r.modification ?? null,
    }));
    const notation = _meta(rows[0]).notation ?? '';
    const paired = /[@·]/.test(notation); // recorded; NOT used to filter in Phase 1
    return { coords, paired };
  }

  // A query mod matches a coordinate iff same family+position and the query
  // either leaves mod_value free (strict off) or pins the same value.
  function _matches(q, coord) {
    return q.family === coord.family
        && q.position === coord.position
        && (q.mod_value == null || q.mod_value === coord.mod_value);
  }

  // Relevance (Phase 1): the query asserts EVERY coordinate the measurement pins.
  function entailsNonPaired(queryMods, constraint) {
    return constraint.coords.every(coord => queryMods.some(q => _matches(q, coord)));
  }

  // Certainty from the outer wrapper of a canonical notation string.
  function notationCertainty(notation) {
    if (!notation) return null;
    const m = /^\(?\s*([[{])/.exec(notation.trim());
    if (!m) return null;
    return m[1] === '[' ? 'exact' : 'native';
  }

  // Given ALL lookup rows for a set of candidate measurements (any layer),
  // group by measurement_id, keep only measurements the query entails, and
  // tag each surviving row with the measurement's certainty. Pure.
  function filterEntailedRows(allRows, queryMods) {
    const byMid = new Map();
    for (const r of allRows) {
      if (!byMid.has(r.measurement_id)) byMid.set(r.measurement_id, []);
      byMid.get(r.measurement_id).push(r);
    }
    const out = [];
    for (const [, group] of byMid) {
      const constraint = measurementConstraint(group);
      if (!entailsNonPaired(queryMods, constraint)) continue;
      const notation = _meta(group[0]).notation ?? '';
      const cert = notationCertainty(notation);
      for (const r of group) out.push(Object.assign({ _certainty: cert }, r));
    }
    return out;
  }

  const api = { measurementConstraint, entailsNonPaired, notationCertainty, filterEntailedRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/three-tier-model.js
// Pure, DOM-free Tier-0 config logic for the three-tier measurement query
// (specs/2026-07-24-measurements-middle-layer.md). Node-require-able and browser-global,
// same convention as the other *-model.js files.
//
// The three-tier query is a funnel, cheapest first:
//   Tier 0  CONFIG gate    particle_count prefilter + composition-class containment   (SQL/JS, this file)
//   Tier 1  MARK coord     family / variant / position / mark on measurement_lookup    (SQL)
//   Tier 2  MEET verify    compatible2 / entails2(queryIR, datumIR)                     (meet2, JS)
//
// Tier 0 is a LENIENT over-approximation: it must never drop a datum that Tier 2 would confirm, so it
// gates only on what is monotone under entailment — the particle count (BB's spark: a query can entail
// a datum only when q.pc >= d.pc) and the multiset of composition classes. Exact linker length and
// array alignment are DELIBERATELY left to Tier 2's meet2 (which makes the linker a hard constraint,
// commit 169ef54). The config derivations below mirror walk2 in init/create_measurements_v2.R verbatim
// — the same node model produced the stored measurement_config rows this gate compares against.
(function (root) {
  'use strict';

  // ── THE COMPOSITION CLASS IS `classify2`, THE ONE NAMER ─────────────────────────────────────
  // A hand-written signature→name map lived HERE and, verbatim, in init/create_measurements_v2.R —
  // and on 2026-08-05 they were found to disagree about the same signature: '2/2/2/2' was
  // 'nucleosome' here and 'octamer' there. `configGatePass` compares those strings as a multiset and
  // `query-engine.js` DROPS on failure, so `octamer` — a name the query side could not produce —
  // gated out every assembly-level measurement at Tier 0. Invisible, because AlphaMissense is
  // material data with no config rows and `multisetContained([], …)` passes.
  //
  // The engine already names nodes, and it is the one place that decides: `classify2` calls a
  // DNA-bearing 2/2/2/2 a nucleosome and the DNA-free one an octamer, which is exactly the
  // distinction the two maps disagreed about. A hand-written lookup beside the engine's own
  // vocabulary was the third copy of naming.
  //
  // The old map also carried 'H2A-H2B dimer' and 'H3-H4 dimer'. Those are unreachable HERE: this
  // names PARTICLES (`particlesOf` yields assemblies and a config row exists only for DNA-bearing
  // ones), and a particle of one dimer is not an admissible species — `classify2` returns null and
  // the signature fallback below carries it, which is what the map's own `|| sig` did.
  // IT IS THE WRITER'S FUNCTION, not one that matches it (census §2, 2026-08-05). Deleting the two
  // maps left two thin wrappers, here and in the ingester, agreeing by construction rather than by
  // identity — the same arrangement one level down, and the same one that failed. The reader now
  // calls what the rows were written with: `grammar/deposit_rows.js`.
  //
  // Throws with no engine, where it used to fall back to '?/?/?/?'. That value was honest and it can
  // only produce an empty gate; an empty measurements panel is a quieter failure than a stack trace,
  // and this is the function whose silence cost two weeks.
  function compositionClass(p) {
    var P = parser();
    if (!P || typeof P.compositionClass !== 'function')
      throw new Error('three-tier-model: compositionClass unavailable — load build/parser2.js first');
    return P.compositionClass(p);
  }

  // The "H2A/H2B/H3/H4" signature — `compositionClass`'s fallback for a node the engine cannot name,
  // and reported by the ingester. The WALK is `compositionCounts` (grammar/stoichiometry.js, the one
  // counter); its predecessor here was a private copy that read a proteoform's own count and dropped
  // every enclosing one, so `([H3@H4]2@H2A@H2B)` — an octamer written with an explicit tetramer, the
  // very example stoichiometry.js was written for — signed as 2/2/1/1 instead of 2/2/2/2.
  //
  // Kept because this module's own suite drives it directly; the gate path reaches it only through
  // `compositionClass` above, which is the engine's.
  function famCounts(a) {
    var P = parser();
    var c = (P && typeof P.compositionCounts === 'function') ? P.compositionCounts(a) : null;
    if (!c) return '?/?/?/?';
    return c.H2A + '/' + c.H2B + '/' + c.H3 + '/' + c.H4;
  }

  // 0 material · 1 mononucleosome · 2+ array.
  //
  // IT IS THE WRITER'S FUNCTION — the same rule `compositionClass` above already follows, and for
  // the same reason (census §2). This said "Verbatim walk2.particleCount" and had stopped being
  // verbatim: `deposit_rows.js` learned on 2026-08-06 that a repeated particle is that many
  // particles, and this copy did not. The gate compares against rows the WRITER produced, so the
  // stale side was this one.
  //
  // What it cost: `(H3)2` and `(H3)3` returned 1, `shell.js` blanks the Arrays card below 2, and
  // those are the spellings the page ITSELF prints — `canon2` fuses `(H3)(H3)` into `(…)2`, so a
  // reader who copied the canonical form the page handed them and pasted it back got an empty panel.
  function queryParticleCount(n) {
    var P = parser();
    if (!P || typeof P.particleCount !== 'function')
      throw new Error('three-tier-model: particleCount unavailable — load build/parser2.js first');
    return P.particleCount(n);
  }

  // The particles of an IR node, repetition expanded — the writer's again, so a reader asking "which
  // particles" and a reader asking "how many" cannot come back with different lists.
  function particlesOf(node) {
    var P = parser();
    if (!P || typeof P.particlesOf !== 'function')
      throw new Error('three-tier-model: particlesOf unavailable — load build/parser2.js first');
    return P.particlesOf(node);
  }

  // Per-particle config signature: { particle_count, particles:[{array_position, composition_class,
  // linker}] }. Also the writer's — `configRows` expands repetition, which the copy here did not, so
  // `(H3)2` produced one particle row against a stored two.
  function queryConfig(node) {
    var P = parser();
    if (!P || typeof P.configRows !== 'function')
      throw new Error('three-tier-model: configRows unavailable — load build/parser2.js first');
    return { particle_count: P.particleCount(node), particles: P.configRows(node) };
  }

  // Multiset containment: is `sub` (as a multiset of values) contained in `sup`?
  function multisetContained(sub, sup) {
    var have = {};
    sup.forEach(function (v) { have[v] = (have[v] || 0) + 1; });
    for (var i = 0; i < sub.length; i++) {
      var v = sub[i];
      if (!have[v]) return false;
      have[v]--;
    }
    return true;
  }

  // Tier-0 predicate. `queryConfig` is queryConfig(queryIR); `datumParticleCount` is the scalar on
  // measurements; `datumConfigRows` are the datum's measurement_config rows (one per particle,
  // [] for material). Sound & lenient:
  //   (a) prefilter — q.particle_count >= datumParticleCount (a smaller query never entails a bigger datum)
  //   (b) composition — the datum's composition-class multiset ⊆ the query's
  // Material data (pc 0, no config rows) passes on (a) with an empty multiset — it is matched on the mark
  // axis (Tier 1) and confirmed at Tier 2. Linker is NOT gated here (Tier 2's job).
  function configGatePass(queryConfig, datumParticleCount, datumConfigRows) {
    if (queryConfig.particle_count < (datumParticleCount || 0)) return false;
    var datumClasses = (datumConfigRows || []).map(function (r) { return r.composition_class; });
    var queryClasses = (queryConfig.particles || []).map(function (p) { return p.composition_class; });
    return multisetContained(datumClasses, queryClasses);
  }

  // ── Tier 1: which lookup row a query mark is allowed to hit (spec 2026-07-31 §7) ────────────────
  //
  // `measurement_lookup` stores ONE coordinate per row, `query_position`, and a `position_frame`
  // saying what it is: the family position where the family reference has a counterpart, and the
  // datum's own variant-frame number where it does not (H2A.Z's KAG, γH2A.X's SQEY tail). The query
  // side has to answer in the same two cases, and it is the QUERY'S FRAME that decides which:
  //
  //   the position HAS a family counterpart   → look it up as a family position, on family rows
  //   it does NOT (a variant-only residue)    → look it up as the frame's own number, on variant
  //                                             rows, and only those labelled inside the subtree
  //
  // BOTH LEGS NEED THE `position_frame` GATE, and the second one is the easy half to miss. P0C0S5
  // carries a family row at query_position 5 (its own K7) AND a variant row at query_position 5
  // (its own A5) — the same accession, the same number, two different residues. An ungated lookup
  // returned both and called them one site.
  //
  // AND THE VARIANT LEG IS A SUBTREE TEST, NOT AN EQUALITY. A variant-framed row is labelled with
  // the LEAF (`H2A.Z.1`), or with the compound spelling of a set (`H2A.Z|H2A.Z.1|H2A.Z.2`), so
  // `variant = 'H2A.Z'` matched none of the 173 H2A.Z rows in the table. A token denotes its subtree
  // (CLAUDE.md §8), and the expansion is `expandVariants2` — the engine's own, the same one `lift2`
  // and `resolveAccessions` use, because a second variant tree written in SQL is a second tree.
  //
  // Nothing here narrows on ORGANISM: the subtree is an idea-layer set of tokens and says nothing
  // about taxon (CLAUDE.md §8, "organism does not gate relevance").
  function parser() {
    return (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2
         : (typeof globalThis !== 'undefined' ? globalThis.nucleosomeParser2 : null);
  }
  function frameSubtree(family, toks) {
    var P = parser();
    if (P && typeof P.expandVariants2 === 'function') {
      try {
        var out = P.expandVariants2(family, toks);
        if (out && out.length) return out;
      } catch (e) { /* fall through */ }
    }
    return toks.slice();          // engine absent: the tokens alone — narrower, never wider
  }

  // THE LOOKUP KEY IS THE ALIGNMENT COLUMN (R5, 2026-08-03).
  //
  // What this replaces, and why the replacement is smaller than the thing replaced: a two-legged
  // rule that decided whether a mark could be looked up in the FAMILY numbering or only in a
  // VARIANT one, and then had to gate the SQL on `position_frame` so the two legs could not collide
  // (P0C0S5 has a family row at 5 and a variant row at 5 — same accession, same number, two
  // residues). Both legs and the gate existed because one number could mean two things depending on
  // which numbering you read it in.
  //
  // A column is the thing a number MEANS, so there is one leg and no gate. The walk reads the stated
  // number in each candidate molecule's own numbering, and the molecules that hard-match identify
  // the column (R5); every datum row carries the column its own material sits in. Two rows match
  // iff they are the same site — which is what the `position_frame` gate was approximating.
  //
  // ASKED OF walk2, NOT OF A REFERENCE. Reading the number in `printRefOf(token)` would give the
  // right answer for most tokens and would be a reference-sequence rule wearing a column's clothes;
  // the walk is the one implementation and it is what the design ruled.
  function markLookup(mark) {
    var pos = mark ? mark.position : null;
    // A TERMINAL LOCUS IS NOT A RESIDUE NUMBER. α/ω carry the sentinel "-inf"/"+inf" and identify no
    // column; both call sites drop such marks before they reach SQL, and this function may not
    // depend on that.
    if (typeof pos !== 'number') return { aln_column: null, position: pos };
    var P = parser(), R = P && P.DEFAULT_REGISTRY, W = P && P.walk2;
    if (!W || !R || typeof R.colAt !== 'function') return { aln_column: null, position: pos };
    var toks = (mark.variant != null) ? mark.variant : (mark.frame != null ? mark.frame : null);
    var w = W.walkNode({
      node: 'proteoform', family: mark.family, accession: null,
      variant: toks == null ? null : (Array.isArray(toks) ? toks : [toks]),
      modifications: [{ position: pos, residue: mark.residue == null ? null : mark.residue,
                        substitution: mark.substitution == null ? null : mark.substitution,
                        modification: mark.modification == null ? null : mark.modification,
                        negated: false }],
    }, {}, R);
    var m0 = (!w.unposable && w.marks && w.marks.length) ? w.marks[0] : null;
    return { aln_column: (m0 && m0.col != null) ? m0.col : null, position: pos };
  }

  // The subtree membership test as SQL. Delimiter-padded LIKE rather than a list function or an IN:
  // it is the general form — one shape that answers whether a token is in the column whatever the
  // column holds — and the formulation every DuckDB build understands, over sets three or four
  // tokens wide. The compound spelling (`H2A.Z|H2A.Z.1|H2A.Z.2`) is what the padding exists for and
  // is NOT what forces it: all 21 compound-labelled rows and all 38 variant-framed screen rows carry
  // a NULL `query_position`, so the mark axis never reaches one. An IN over the leaves would pass
  // today's data and quietly stop working the first time a compound label carries a coordinate.
  // `push` binds a value and returns its placeholder. An empty set is FALSE — a token that denotes
  // no variant matches no variant-framed row, which is a true answer and not a silent widening.
  function variantSubtreeSql(col, toks, push) {
    if (!toks || !toks.length) return 'FALSE';
    return toks.map(function (t) {
      return "('|' || " + col + " || '|') LIKE ('%|' || " + push(t) + " || '|%')";
    }).join(' OR ');
  }

  var api = { famCounts, compositionClass, queryParticleCount, particlesOf, queryConfig, multisetContained, configGatePass,
              markLookup, variantSubtreeSql };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ── Universal query engine ──────────────────────────────────────────────────
// Layer registry: each layer defines a parquet URL, a SQL view, a render
// level, and a renderer.  Levels map to the parse-tree hierarchy:
//
//   array  →  rendered once above the nucleosome list
//   nucleosome  →  rendered once per nucleosome, above slots
//   slot  →  rendered once per histone slot, above mods
//   modification  →  rendered inside each mod-section (current AM behavior)
//
// Adding a new data layer requires only a new entry here + a render function.

const LAYER_LEVELS = ['array', 'nucleosome', 'slot', 'modification'];

const LAYERS = {
  alpha_missense: {
    level: 'modification',
    label: 'AlphaMissense',
    // ONE PRE-JOINED FILE, FETCHED ON FIRST USE [BB 2026-09-22]. The lookup and measurement rows
    // of this layer are strictly 1:1, so create_measurements_v2.R writes them joined; the boot
    // tables hold only the containers. `ensureLayerFile` (duckdb.js) registers the file the first
    // time a position query reaches this layer — 2.5 MB that used to load before the first query,
    // 0.45 MB that now loads when a score is asked for. `entry_key` is respelled from its parts,
    // verbatim to what the ingester asserted, so the ORDER BY in queryLayers is unchanged.
    file: () => ALPHA_MISSENSE_URL,
    viewSql: () => `
      CREATE OR REPLACE VIEW layer_alpha_missense AS
      SELECT
        a.family, a.variant,
        a.query_position AS position,
        a.position_frame,
        a.aln_column,
        a.histone_position,
        a.nucleosome_position,
        a.residue, a.substitution, a.modification,
        COALESCE(a.substitution, a.modification) AS mod_value,
        a.uniprot_id || ':' || a.residue || CAST(a.histone_position AS VARCHAR) || a.substitution AS entry_key,
        a.estimate, a.unit,
        a.uniprot_id, a.taxon_id, a.am_class,
        p.uniprot_name, p.species, p.protein_name
      FROM read_parquet('${ALPHA_MISSENSE_URL}') a
      LEFT JOIN (SELECT DISTINCT uniprot_id, uniprot_name, species, protein_name
                 FROM read_parquet('${PROTEINS_URL}')) p ON p.uniprot_id = a.uniprot_id`,
    render: renderAmTable,
  },
  screen: {
    level: 'nucleosome',
    label: 'Screens',
    viewSql: () => `
      CREATE OR REPLACE VIEW layer_screen AS
      SELECT
        l.measurement_id,
        l.family, l.variant,
        l.query_position AS position,
        l.position_frame,
        l.aln_column,
        l.histone_position,
        l.nucleosome_position,
        l.residue, l.substitution, l.modification,
        COALESCE(l.substitution, l.modification) AS mod_value,
        m.entry_key, m.estimate, m.unit,
        l.uniprot_id, m.taxon_id, m.metadata, m.glyph_mask
      FROM read_parquet('${LOOKUP_URL}') l
      JOIN read_parquet('${MEASUREMENTS_URL}') m USING (measurement_id)
      -- Every SINGLE-PARTICLE measurement layer, not just 'screen'. The old hardcode meant a new
      -- layer was invisible in the panel however cleanly it ingested (occupancy/binding sat in the
      -- parquet unreachable). The predicate is by SHAPE, not by name, so future layers of the same
      -- shape appear without another edit:
      --   particle_count = 1  → one nucleosome; exactly what a tile's glyph can attach to.
      --   arrays (pc >= 2) and materials/segments (pc = 0) are EXCLUDED on purpose — their
      --   glyph_mask is [] so glyph overlap can never match them; they need the particle_count-aware
      --   queryThreeTier path (arrays → the Arrays card; segments → mark-less materials, deferred).
      --   alpha_missense is material-keyed and has its own layer + renderer above.
      WHERE l.layer <> 'alpha_missense' AND m.particle_count = 1`,
  }
};

// Return layer entries filtered to a given level.
function layersAt(level) {
  return Object.entries(LAYERS).filter(([, l]) => l.level === level);
}

// ── A TERMINAL LOCUS IS NOT A RESIDUE NUMBER ────────────────────────────────────────────────────
// α/ω attach to the molecule's ends, and an unresolved terminal mark carries the sentinel `"-inf"` /
// `"+inf"` on its position (specs/2026-07-27-terminal-marks-attach-to-extent.md). Every measurement
// table keys marks by `query_position`, an INT32 residue number, so binding that string is not a near
// miss that returns nothing — DuckDB refuses the whole statement ("Could not convert string '-inf' to
// INT32") and the panel goes empty-with-an-error. `H4:αac` did exactly that.
//
// Dropping such a mark before it reaches SQL is the CORRECT answer, not a workaround: no row in a
// residue-keyed table can ever carry a terminal locus, so the result is empty by construction. In the
// two CANDIDATE fetches this only ever widens the candidate set (a mark-less list is ⊤ on that axis),
// which is the safe direction — Tier 2's meet2 still enforces the terminal mark on the survivors.
function isResidueLocus(position) {
  return typeof position === 'number' && Number.isFinite(position);
}
function residueKeyedMarks(mods) {
  return (mods || []).filter((m) => isResidueLocus(m && m.position));
}

// ── A MARK'S VALUE MAY BE A SET, AND A SET CANNOT BE BOUND TO `=` ───────────────────────────────
// `H3:K27M|L` and `H3:K27X` always were sets; `H3:R3me` became one when an asserted group name
// started expanding to its members (CLAUDE.md §8). Bound as a scalar the array reaches DuckDB as an
// array and the statement FAILS — "Invalid column type encountered for argument 2" — so the panel
// shows an error rather than a result, which is what `(H3K27me1|me2)` did.
//
// ONE HELPER, THREE PATHS, and that is the point of it. This rule was written once inline, in
// `queryThreeTier` alone, so the Arrays pane took a set while the AlphaMissense table and the main
// pane still bound one to `=`. That is section D of `column-query.test.js` — three functions serving
// three panes, and a rule that reaches only some of them makes one card contradict itself.
//
// ANY MEMBER HITTING IS A HIT: these are prefilters, whose job is to admit what might be relevant.
// The datum's set and the query's set are compared as wholes by `entails2` downstream, which is
// where "degree unstated does not prove monomethyl" is decided. Returns null for "no constraint" —
// a null or empty value states nothing on this axis, which is ⊤ and not ⊥.
function modValueTest(expr, value, push) {
  const vals = value == null ? [] : (Array.isArray(value) ? value : [value]);
  if (vals.length === 0) return null;
  return vals.length === 1
    ? `${expr} = ${push(vals[0])}`
    : `${expr} IN (${vals.map(push).join(', ')})`;
}

// The measurements middle layer (specs/2026-07-24-measurements-middle-layer.md): all-layer, all-column
// pass-through views over the three canonical tables, read by the three-tier query (queryThreeTier).
// Unlike the per-layer `layer_*` views (filtered + projected for their renderers), these are unfiltered
// so the funnel sees every layer at once.
function middleLayerViews() {
  return [
    `CREATE OR REPLACE VIEW all_measurements AS SELECT * FROM read_parquet('${MEASUREMENTS_URL}')`,
    `CREATE OR REPLACE VIEW all_lookup       AS SELECT * FROM read_parquet('${LOOKUP_URL}')`,
    `CREATE OR REPLACE VIEW all_config        AS SELECT * FROM read_parquet('${CONFIG_URL}')`,
  ];
}

// A layer with a `file` is registered and its view created on first use, not at boot: DuckDB binds
// a view's sources when it is CREATED, so creating it here would fetch the file here. `layerReady`
// is the one gate, memoized per layer; tests stub `dbConnect` and define no `ensureLayerFile`, so
// there it resolves without touching the file's URL.
const _layerReady = new Map();
function layerReady(name, layer) {
  if (!layer.file) return Promise.resolve();
  if (!_layerReady.has(name)) {
    _layerReady.set(name, (async () => {
      if (typeof ensureLayerFile !== 'function') return;   // tests: no db, no fetch, no view
      await ensureLayerFile(layer.file(), layer.viewSql());
    })().catch((e) => { _layerReady.delete(name); throw e; }));
  }
  return _layerReady.get(name);
}

async function initLayers() {
  const conn = await db.connect(); // raw: runs inside initDuckDB — must NOT gate (self-deadlock)
  try {
    for (const [name, layer] of Object.entries(LAYERS)) {
      if (layer.file) continue;                 // lazy: see layerReady
      await conn.query(layer.viewSql());
    }
    for (const sql of middleLayerViews()) await conn.query(sql);
  } finally {
    await conn.close();
  }
}

// Query layers at a given level for a family + position.
// Options: { modType, modValue, variant }
// Returns: Map<layerName, rows[]>
// `taxon` defaults to ⊤ (null = no organism narrowing), NOT to human (BB, 2026-07-29). A DATUM's
// relevance is settled on the idea layer: a C. elegans query about H2A.Z is asking about the idea of
// that position, and a measurement made in human is an answer to it — the organism is a fact about
// the datum to be DISPLAYED, not a filter on whether it exists. Narrowing here conflated the two.
//
// It also narrowed to the wrong organism. The default was 9606 and the one call site passes no
// taxon, so a Ce query with any variant token was answered with HUMAN accessions regardless of
// context or port — neither idea-layer nor context-faithful. Only a bare family (variant null → no
// filter at all) behaved as intended, which is why this went unnoticed.
//
// The VARIANT leg of the filter stays: that is an idea-layer constraint (the subtree a token
// denotes), and it is what makes `caH2A` reach its members' rows. Only the taxon leg goes to ⊤.
// A caller that genuinely wants one organism can still pass one.
//
// `frame` is the QUERY'S frame — `frameOf` of the card's proteoform (spec 2026-07-31). `position` is
// a number written IN THAT FRAME, so it is translated here and nowhere upstream: `H2A.Z:K7ac` asks
// for family position 5, and `H2A.Z:K4ac` — a residue the family reference has no name for — asks
// for 4 on the variant-framed rows of the H2A.Z subtree. Omitted → the family frame, unchanged.
async function queryLayers(level, family, position, { modType = null, modValue = null, variant = null, taxon = null, frame = null, residue = null } = {}) {
  const layers = layersAt(level);
  if (layers.length === 0) return new Map();

  // A terminal mark has no residue coordinate to look up — every layer at this level is empty for it.
  // Returning the empty result per layer (rather than an empty Map) keeps the callers' `.get(name)`
  // shape intact.
  if (!isResidueLocus(position)) return new Map(layers.map(([name]) => [name, []]));

  // Material-layer resolution (specs/2026-07-18-material-layer-matching.md): a
  // variant TOKEN resolves (in the query context) to a SET of UniProt accessions;
  // a datum is matched by ACCESSION, not by variant string. This is what makes
  // `caH2A` surface its members' AM even though the AM rows carry a different
  // variant token. A null variant (bare family = ⊤) → null → no accession filter.
  const accessions = await resolveAccessions(family, variant, taxon);
  // A LAYER THAT CANNOT BE FETCHED IS AN ABSENT LAYER, NOT A FAILED QUERY [BB 2026-09-23].
  // `layerReady` fetches over the network now (the AlphaMissense split moved this file out of the
  // boot set), so it can reject on a 404, an offline tab or a blocked request. `Promise.all` made
  // that rejection the whole query's: it propagated through buildMaterialCard → renderMaterials →
  // renderFocusedPanes, which is awaited in shell.js with no catch and `markReady()` on the next
  // line — so a missing file left a half-drawn card that never settled. While the file was in the
  // boot set `dbReady().catch` said "Could not load the data"; the split moved the fetch out from
  // under its only handler. The other layers still answer, and the absent one reports no rows,
  // which is exactly what it reports when it has no data for this site.
  const readiness = await Promise.allSettled(layers.map(([name, layer]) => layerReady(name, layer)));
  const unavailable = new Set(layers.filter((_, i) => readiness[i].status === 'rejected').map(([n]) => n));
  for (const [i, [name]] of layers.entries()) {
    if (readiness[i].status === 'rejected') {
      console.warn(`layer ${name} unavailable — reporting no rows`, readiness[i].reason);
    }
  }

  const conn = await dbConnect();
  try {
    const results = new Map();
    // THE LETTER IS WHAT IDENTIFIES THE COLUMN (R5), so it has to get here. This passed `frame`
    // alone, which was enough while a frame decided the numbering and is not enough now: the walk
    // reads the stated number in each candidate's own numbering and the molecules that HARD-MATCH
    // the residue letter pick the column. Without the letter `H2A:S139A` falls to the all-twenty
    // residue set, every H2A with a 139 hard-matches, and the family vote answers column 154 —
    // a real site, and not γH2A.X's S139 at 177. The flagship query, quietly pointed elsewhere.
    //
    // `modValue` rides along as the modification: it is COALESCE(substitution, modification), so a
    // substitution like "M" simply is not a PTM token and `ptmResidues` returns null for it, falling
    // through to the same set as before. A PTM narrows (R13 tier 2); a substitution cannot mislead.
    const L = markLookup({ family, position, variant, frame, residue, modification: modValue });
    for (const [name, layer] of layers) {
      if (unavailable.has(name)) { results.set(name, []); continue; }   // file never arrived
      const params = [];
      const push = (v) => { params.push(v); return `$${params.length}`; };
      // KEYED ON THE COLUMN. The `position_frame` gate that stood here was not decoration — P0C0S5
      // has a family row at query_position 5 (its own K7) and a variant row at 5 (its own A5): same
      // accession, same number, two residues, and without the gate one lookup returned both. A
      // column tells them apart by construction, because they are two columns.
      //
      // An unposable mark identifies NO column and matches nothing — which is R6, not an empty
      // result to paper over: nothing hard-matched the stated letter, so there is no site to ask
      // about.
      if (L.aln_column == null) { results.set(name, []); continue; }
      let sql = `
        SELECT * FROM layer_${name}
        WHERE family = ${push(family)}
          AND aln_column = ${push(L.aln_column)}`;

      if (accessions) {
        // The token resolves to a concrete accession set. Empty set = the token
        // denotes no material in this context → no rows (a true, not silent, miss).
        if (accessions.length === 0) { results.set(name, []); continue; }
        sql += `\n          AND uniprot_id IN (${accessions.map(push).join(', ')})`;
      }
      const modTest = modValueTest('mod_value', modValue, push);
      if (modTest) sql += `\n          AND ${modTest}`;
      sql += `\n        ORDER BY entry_key, estimate DESC`;

      results.set(name, await runPrepared(conn, sql, params, `layer:${name}`));
    }
    return results;
  } finally {
    await conn.close();
  }
}

// ── Prepared-statement execution, with the failure made attributable ────────────────────────────
// A DuckDB-WASM error surfaces as `RuntimeError: index out of bounds` thrown out of the worker's RPC
// handler, with a stack that names async_bindings.ts and nothing of ours — unusable. Every prepared
// statement therefore goes through here, so a failure carries the SQL and the bound values, and lands
// on the page instead of in an uncaught promise rejection.
//
// `undefined` is NOT BINDABLE: duckdb-wasm indexes its bind array by position and an undefined slot
// walks off the end — one of the ways to produce exactly that error. A null is a value; an undefined
// is a missing argument, and the two must not be conflated silently, so it is normalised AND reported.
function bindValues(params, label) {
  return (params || []).map((v, i) => {
    if (v === undefined) {
      console.warn(`duckdb ${label}: parameter $${i + 1} was undefined — bound as NULL`);
      return null;
    }
    return v;
  });
}
async function runPrepared(conn, sql, params, label) {
  const bound = bindValues(params, label);
  let stmt = null;
  try {
    stmt = await conn.prepare(sql);
    const res = await stmt.query(...bound);
    return res.toArray().map((r) => r.toJSON());
  } catch (e) {
    const detail = `${label}: ${e && e.message || e} · ${bound.length} params `
                 + `[${bound.map((v) => (v === null ? 'null' : typeof v)).join(', ')}]`;
    if (typeof reportQueryFailure === 'function') reportQueryFailure(detail, sql, bound);
    else console.error(detail, sql, bound);
    throw new Error(detail);
  } finally {
    if (stmt) { try { await stmt.close(); } catch (e) { /* already gone */ } }
  }
}

// Fetch candidate rows for a set of query-union mods — the MARK axis only. The shape axis (glyph
// up-sets) and the meet run downstream in shell.js.
//
// `mods` is [{ family, position, mod_value }]. An EMPTY list is not "no data": a query that states no
// mark is the most general element on this axis — ⊤, admitting everything — and the axes that DO
// constrain it (composition, shape, the meet) decide from there. Returning [] here encoded ⊤ as ⊥, so
// (H3) and (H3@H4@{H2A}0@{H2B}0) found nothing at all and looked indistinguishable from "no such data
// exists".
//
// THE FRAME REACHES HERE TOO, and it is this function that most needed it. `queryUnionMods` attaches
// a frame to every mark; two functions consume that list, and for a while only `queryThreeTier`
// routed it through `markLookup`. `queryThreeTier` serves the Arrays pane alone (minParticleCount 2),
// so the frame reached the arrays and the AlphaMissense table while the MAIN single-particle pane —
// and the arrangement has-data dots, which read the same candidates — kept asking with the raw
// number. Both directions of that miss are real:
//
//   H2A.Z:K7ac  asked for family 7. The 16 `ac` rows are at family 5 (H2A.Z's own K7 IS canonical
//               H2A's K5), so the pane emptied and every tile lost its dot — beside an AM table
//               that was answering on 5. One card contradicting itself.
//   H2A.Z:K5ac  H2A.Z's own 5 is in the KAG insertion and has no family counterpart, so the raw
//               fetch returned canonical H2A's K5: sixteen rows about a different residue. The
//               downstream meet does not catch it — `compatible2` of the two is true, correctly,
//               because they are different sites and not a contradiction.
async function queryScreenCandidates(mods) {
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  const conditions = residueKeyedMarks(mods).map(m => {
    const L = markLookup(m);
    if (L.aln_column == null) return 'FALSE';        // identifies no column ⇒ names no site (R6)
    let t = `(family = ${push(m.family)} AND aln_column = ${push(L.aln_column)}`;
    const modTest = modValueTest('mod_value', m.mod_value, push);
    if (modTest) t += ` AND ${modTest}`;
    return t + ')';
  });

  const conn = await dbConnect();
  try {
    const sql = conditions.length ? `
      SELECT * FROM layer_screen
      WHERE measurement_id IN (
        SELECT measurement_id FROM layer_screen
        WHERE ${conditions.join('\n          OR ')}
      )
      ORDER BY measurement_id, entry_key` : `
      SELECT * FROM layer_screen
      ORDER BY measurement_id, entry_key`;
    return await runPrepared(conn, sql, params, `screenCandidates(${conditions.length} marks)`);
  } finally {
    await conn.close();
  }
}

// ── The three-tier measurement query ────────────────────────────────────────
// specs/2026-07-24-measurements-middle-layer.md. A funnel, cheapest first, over the three tables:
//
//   Tier 0  CONFIG gate    particle_count prefilter (q.pc >= d.pc) + composition-class containment
//   Tier 1  MARK coord      the query's marks matched on all_lookup (or a mark-less datum admitted)
//   Tier 2  MEET verify     compatible2 / entails2(datumIR, queryIR) on the survivors (meet2, JS)
//
// Tiers 0 (prefilter) + 1 run in one SQL pass; the Tier-0 composition set-compare and Tier-2 meet2 run
// in JS on the narrowed candidates. `queryIR` is a v2 lifted IR (lift2(parse(query)) — an array node);
// `queryMarks` are the query's marks already resolved to idea coordinates ([{family, position,
// mod_value}], same shape queryScreenCandidates takes).
// `mode`: 'compatible' (discovery default, meet≠⊥) | 'entails' (opt-in, datum⊑query). `layer` filters.
// Returns survivor groups: [{ measurement_id, rows, config, particle_count }].
async function queryThreeTier(queryIR, queryMarks, { mode = 'compatible', layer = null, minParticleCount = 0 } = {}) {
  const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2
          : (typeof globalThis !== 'undefined' ? globalThis.nucleosomeParser2 : null);
  if (!P) throw new Error('queryThreeTier: nucleosomeParser2 (parser2.js) not loaded');

  const qConfig = queryConfig(queryIR);
  const params = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };

  // Tier 1 — the MARK axis.
  //
  // A MARK-LESS QUERY states nothing on this axis, which makes it ⊤ — it admits every datum, and the
  // axes that do constrain it (Tier 0 composition, Tier 2 meet) decide. Leaving `markBranch` empty
  // encoded that as the *mark-less-datum* branch alone, so (H3)-40-(H3) saw only data that also
  // happened to carry no marks and every marked array measurement was invisible.
  // Terminal marks have no residue coordinate for Tier 1 to hit (see isResidueLocus); dropping them
  // here only widens the candidate set, and Tier 2's meet2 still enforces them on the survivors.
  queryMarks = residueKeyedMarks(queryMarks);

  let markTier;
  if (queryMarks && queryMarks.length) {
    // A datum is admitted if any query mark hits one of its lookup rows...
    const conds = queryMarks.map((m) => {
      // One key, no frame leg and no subtree leg. What those legs were for: `query_position` held
      // family_position where the family reference had a counterpart and the datum's own
      // variant-numbering position where it did not (H2A.X's SQEY tail, H2A.Z's KAG), so a mark had
      // to declare WHICH numbering it was hitting, and a variant-numbered row then had to be
      // admitted only inside the subtree the query's token denotes — otherwise `H2A:S139ph` matched
      // γH2A.X while canonical H2A has no 139 at all. The column is the same site for both cases,
      // and γH2A.X's S139 has a column like any other residue.
      const L = markLookup(m);
      if (L.aln_column == null) return 'FALSE';      // identifies no column ⇒ names no site (R6)
      const f = push(m.family), c = push(L.aln_column);
      // A MARK'S VALUE MAY BE A SET, and a set cannot be bound to `=` — `modValueTest` above, which
      // the other two panes now share. A mark stating no value constrains nothing on this axis (⊤),
      // so the test is TRUE and Tier 0/2 decide.
      const test = modValueTest('COALESCE(l.substitution,l.modification)', m.mod_value, push) || 'TRUE';
      return `(l.family=${f} AND l.aln_column=${c} AND (${test}))`;
    }).join(' OR ');
    // ...or it is MARK-LESS ITSELF (a control, linker series, or bare composition class): such a datum
    // has no Tier-1 coordinate to hit, so it is admitted here and decided at Tier 0/2.
    markTier = `(EXISTS (SELECT 1 FROM all_lookup l WHERE l.measurement_id=m.measurement_id AND (${conds}))`
             + ` OR NOT EXISTS (SELECT 1 FROM all_lookup l WHERE l.measurement_id=m.measurement_id`
             + ` AND (l.substitution IS NOT NULL OR l.modification IS NOT NULL)))`;
  } else {
    markTier = 'TRUE';
  }

  const qpcP = push(qConfig.particle_count);           // Tier 0 prefilter: q.pc >= d.pc
  let where = `m.particle_count <= ${qpcP} AND ${markTier}`;
  // …and the caller's FLOOR. The Arrays card wants only multi-particle data; without a floor it pulled
  // every material-layer row (alpha_missense is particle_count 0 — 94,962 measurements) and discarded
  // them client-side. Pushing the bound into SQL is the difference between 96,156 candidates and 9.
  if (minParticleCount > 0) where += ` AND m.particle_count >= ${push(minParticleCount)}`;
  if (layer) where += ` AND m.layer=${push(layer)}`;

  const rowSql = `
    WITH cand AS (SELECT measurement_id FROM all_measurements m WHERE ${where})
    SELECT l.*, m.entry_key, m.estimate, m.unit, m.particle_count, m.metadata
    FROM cand
    JOIN all_lookup l USING (measurement_id)
    JOIN all_measurements m USING (measurement_id)
    ORDER BY l.measurement_id, m.entry_key`;

  const conn = await dbConnect();
  try {
    const rows = await runPrepared(conn, rowSql, params, 'threeTier:rows');
    if (rows.length === 0) return [];

    // Config rows for the candidate measurements (Tier-0 composition set-compare, done in JS).
    //
    // Selected by RE-STATING the candidate predicate, not by binding one parameter per id. Sending the
    // ids back cost one bind slot each — 96,156 of them on a query that admitted the material layer,
    // which is what duckdb-wasm reports as `RuntimeError: index out of bounds`. The candidate set is
    // already a query; ask for it again (DuckDB re-plans it in microseconds) instead of round-tripping
    // it through the client. Bounded by construction: the parameter count is now the QUERY's size, not
    // the RESULT's.
    const cfgSql = `SELECT measurement_id, array_position, composition_class, linker
                    FROM all_config
                    WHERE measurement_id IN (SELECT measurement_id FROM all_measurements m WHERE ${where})`;
    const cfgByMid = new Map();
    (await runPrepared(conn, cfgSql, params, 'threeTier:config')).forEach((r) => {
      if (!cfgByMid.has(r.measurement_id)) cfgByMid.set(r.measurement_id, []);
      cfgByMid.get(r.measurement_id).push(r);
    });

    const byMid = new Map();
    rows.forEach((r) => {
      if (!byMid.has(r.measurement_id)) byMid.set(r.measurement_id, []);
      byMid.get(r.measurement_id).push(r);
    });

    const rel = mode === 'entails' ? P.entails2 : P.compatible2;
    const survivors = [];
    byMid.forEach((group, mid) => {
      const head = group[0];
      const dpc = Number(head.particle_count) || 0;
      // Tier 0 — composition containment (the prefilter already ran in SQL).
      if (!configGatePass(qConfig, dpc, cfgByMid.get(mid) || [])) return;
      // Tier 2 — meet2 verify. Material (pc 0) has no assembly to meet: it matched on the mark axis
      // (Tier 1) and is accepted (material-layer matching, specs/2026-07-18). Assembly data is verified
      // by reconstructing the datum IR from its stored notation and running the mode's relation.
      if (dpc > 0) {
        const meta = typeof head.metadata === 'string' ? JSON.parse(head.metadata) : (head.metadata || {});
        if (meta.notation) {
          let datumIR = null;
          try { datumIR = P.lift2(P.parse(meta.notation)); } catch (e) { datumIR = null; }
          if (datumIR && !rel(datumIR, queryIR)) return;   // datum ⊑ query (entails) / meet≠⊥ (compatible)
        }
      }
      survivors.push({ measurement_id: mid, rows: group, config: cfgByMid.get(mid) || [], particle_count: dpc });
    });
    return survivors;
  } finally {
    await conn.close();
  }
}

// (Removed: renderLayerResults — the dead layer-dispatch renderer with zero live
// callers. The worlds-first shell renders AM via a direct renderAmTable() call
// and measurements via its own renderTypeSection path; nothing invoked this.
// Phase 1 shell consolidation, dead-code sweep.)

// ── Context editor ──────────────────────────────────────────────────────────

// js-yaml is imported by its own module script (index.html) and parked on window, so that a
// blocked CDN costs the editors and not the whole page. It can therefore legitimately be ABSENT —
// bare `jsyaml` would throw a ReferenceError, which reads as a crash rather than as the missing
// library it is. Every use goes through here.
function yamlLib() {
  return (typeof window !== 'undefined' && window.jsyaml) ? window.jsyaml : null;
}
const YAML_MISSING = 'YAML library unavailable — check whether a blocker is stopping cdn.jsdelivr.net';


// VERSIONED, because the stored FORMAT changed on 2026-07-29 (bare family map → the deposited
// container's `context:` shape). A value written under the old contract is still parseable, which is
// worse than if it were not: it carries families but no context-level default, so the buttons read
// human while the materials resolve somewhere else — and it cost a debugging round trip the day the
// format changed. Bumping the key retires those silently. The cost is one re-pick of a lens; the
// alternative is a saved value invisibly arguing with the code.
const CONTEXT_STORAGE_KEY = 'nucleosome-context-v2';
const CONTEXT_STORAGE_KEY_LEGACY = 'nucleosome-context';

// Mutable overrides — keyed by family or variant token.
// Each entry can have: { uniprot_id, protein_name, species, taxon_id, modifications }
// Empty by default (no overrides — SQL resolves to human canonical).
let contextOverrides = {};

// THE SHAPE IS THE DEPOSITED CONTAINER'S (BB, 2026-07-29). A data container states its context in
// data/<source>/*.yaml under a top-level `context:` key — see data/PMID33649601-ACF/library_specs.yaml.
// The editor now speaks exactly that, so what you type here and what a depositor writes are one
// format, and a container's context can be pasted in unchanged.
//
// `taxon_id` directly under `context:` is the DEFAULT for every family. A family block may restate
// it to override. Precedence, lowest first: context default → family block → an accession named by
// the query itself (which pins its own species; duckdb.js resolveContext).
// THE PROJECT'S REFERENCE ORGANISM, STATED ONCE (BB, 2026-08-07). Every other module used to carry
// its own `?? 9606`, which is the same rule copied to the places that noticed they needed one — and
// the one place that fed the engine never noticed. There is nothing to copy now: the context below
// is initialised from this and is never unset, so a function that receives a context receives a
// stated one. See the comment on `contextDefaultTaxon`.
const CONTEXT_DEFAULT_TAXON = 9606;

const CONTEXT_TEMPLATE = `context:
  taxon_id: ${CONTEXT_DEFAULT_TAXON}
# A family block overrides the default above. Uncomment and edit.
#  H3:
#    uniprot_id: P68431
#    uniprot_name: H31_HUMAN
#    modifications:
#    - {position:  96, substitution: A}
#    - {position: 110, substitution: A}
#  H4:
#    taxon_id: 8355
`;

// The context-level taxon: the default for any family the YAML does not name. Read by duckdb.js
// (contextDefaultOverride) BENEATH the per-family entries, which is what makes an edit to one
// family stick instead of being clobbered by the global lens — the bug this rework exists to fix.
//
// IT IS NEVER null (BB, 2026-08-07). It used to start that way and mean "nothing stated", which
// every consumer then had to translate — `resolveContext` and the Read as button translated it to
// human, and `contextOverrideForQuery` translated it to ⊤, so `H2AX:S139ph` was answered over five
// organisms under a button reading Hs. There is no unset state to translate now: the page starts in
// the reference organism and a reader moves it, so the context the engine gets is always the context
// the button is showing. Clearing the YAML returns here rather than to nothing (`adoptContext`).
let contextDefaultTaxon = CONTEXT_DEFAULT_TAXON;

// Accept both the container shape (`context:` wrapper) and a bare family map, because that is what
// every previously saved localStorage value looks like. Returns the two things the rest of the app
// needs: the default taxon, and the per-family entries with that default filled in where a block
// does not state its own.
function splitContextDoc(parsed) {
  if (!parsed || typeof parsed !== 'object') return { defaultTaxon: null, families: {} };
  const ctx = (parsed.context && typeof parsed.context === 'object') ? parsed.context : parsed;
  const { taxon_id: defaultTaxon = null, ...rest } = ctx;
  const families = {};
  for (const [k, v] of Object.entries(rest)) {
    if (!v || typeof v !== 'object') continue;
    families[k] = (v.taxon_id == null && defaultTaxon != null) ? { ...v, taxon_id: defaultTaxon } : v;
  }
  return { defaultTaxon, families };
}

// THE ONE PLACE THE READ-AS CONTEXT IS SET (BB, 2026-08-07: "all context should always be read from
// the editors, and this must be set at the very beginning"). Five paths used to assign the two
// globals directly — the species menu, Apply, Apply-on-an-empty-box, Reset, and the localStorage
// restore — and each carried its own idea of what an unstated default meant. They all hand a split
// to this now, so "the context is never unset" is one line rather than five agreements.
// `null`/an unstated default means the reference organism, which is what clearing the box asks for.
function adoptContext(split) {
  contextOverrides    = (split && split.families) ? split.families : {};
  contextDefaultTaxon = (split && split.defaultTaxon != null) ? split.defaultTaxon : CONTEXT_DEFAULT_TAXON;
}

// What duckdb.js applies UNDER the per-family entries, and what the engine is asked in
// (contextOverrideForQuery). UNCONDITIONAL: there is no unset context to represent, and the empty
// object that used to stand for one meant ⊤ to the engine and "human" to the button.
function contextDefaultOverride() {
  return { taxon_id: contextDefaultTaxon };
}

// The YAML a species pick writes. BB asked for the families spelled out rather than left implicit:
// repeating the taxon makes the next edit a one-line change on the family you care about, instead
// of first having to discover that a family block is allowed at all.
const CONTEXT_FAMILIES = ['H2A', 'H2B', 'H3', 'H4'];
function contextYamlForTaxon(taxonId, speciesName) {
  const lines = ['context:', `  taxon_id: ${taxonId}` + (speciesName ? `          # ${speciesName}` : '')];
  CONTEXT_FAMILIES.forEach((f) => { lines.push(`  ${f}:`, `    taxon_id: ${taxonId}`); });
  return lines.join('\n') + '\n';
}

// The split that contextYamlForTaxon's output WOULD parse to, computed directly. We wrote the text,
// so re-reading it through js-yaml only asks a CDN module for an answer we already have — and
// js-yaml is a network import, so that made the species menu fail whenever the CDN was blocked.
// Kept beside the generator on purpose: if one changes, the other has to.
function splitForTaxon(taxonId) {
  const families = {};
  CONTEXT_FAMILIES.forEach((f) => { families[f] = { taxon_id: taxonId }; });
  return { defaultTaxon: taxonId, families };
}

// `overridesToYaml(ov)` STOOD HERE, with `portOverridesToYaml` its twin in port-editor.js. Both
// serialised the live overrides back into the editor's box, both had ZERO callers — the box is
// written by the thing that changed it (the menu, Apply, Reset), never re-derived — and both
// branched on `…DefaultTaxon == null`, a state neither lens has any more. Deleted 2026-08-07.

// Trigger a full re-render of current input.
function reRender() {
  lastKey = null;
  cachedSvg = null;
  clearContextCache();
  // The field lookup that used to stand here went with the synthetic `input` it fed: a context
  // change is a request to re-answer, and it says so now instead of impersonating a keystroke.
  if (window.runQuery) window.runQuery();
}

// Write the YAML for a taxon and adopt it, WITHOUT re-rendering. Two callers need that: the species
// menu (which re-renders itself, right after) and the accession lens in onInput(), which rebuilds
// the IR on the spot and must not re-enter the input handler while it is running.
function setContextTaxon(taxonId, speciesName) {
  const text = contextYamlForTaxon(taxonId, speciesName);
  const box  = document.getElementById('context-yaml');
  if (box) box.value = text;
  adoptContext(splitForTaxon(taxonId));   // splitForTaxon, not js-yaml — see the note on it above
  try { localStorage.setItem(CONTEXT_STORAGE_KEY, text); } catch (e) { /* private mode */ }
}

// ── Apply / Reset ────────────────────────────────────────────────────────

function applyContext() {
  const textarea = document.getElementById('context-yaml');
  const errorEl  = document.getElementById('context-error');
  if (!textarea) return;

  try {
    const Y = yamlLib();
    if (!Y) { errorEl.textContent = YAML_MISSING; errorEl.className = 'context-error'; return; }
    const parsed = Y.load(textarea.value);
    if (parsed == null) {
      // Empty or all comments — back to the reference organism, which is what the box says when it
      // is untouched. Not to "no context": there is nowhere for that to mean anything downstream.
      adoptContext(null);
      localStorage.removeItem(CONTEXT_STORAGE_KEY);
      errorEl.textContent = 'Read as reset to defaults';
      errorEl.className = 'context-applied';
  
      if (typeof updateControls === 'function') updateControls();
      reRender();
      return;
    }
    if (typeof parsed !== 'object') {
      errorEl.textContent = 'YAML must be a mapping of family tokens to override entries.';
      errorEl.className = 'context-error';
      return;
    }
    adoptContext(splitContextDoc(parsed));
    localStorage.setItem(CONTEXT_STORAGE_KEY, textarea.value);
    errorEl.textContent = 'Read as applied';
    errorEl.className = 'context-applied';

    // The buttons read the YAML, so adopting new YAML must refresh them — otherwise Apply
    // changes the lens and leaves the label on whatever the menu last said.
    if (typeof updateControls === 'function') updateControls();
    reRender();
  } catch (e) {
    errorEl.textContent = `YAML error: ${e.message}`;
    errorEl.className = 'context-error';
  }
}

function resetContext() {
  adoptContext(null);
  localStorage.removeItem(CONTEXT_STORAGE_KEY);
  const textarea = document.getElementById('context-yaml');
  const errorEl  = document.getElementById('context-error');
  if (textarea) textarea.value = CONTEXT_TEMPLATE;
  if (errorEl)  errorEl.textContent = '';
  if (typeof updateControls === 'function') updateControls();
  reRender();
}

// ── Initialise ───────────────────────────────────────────────────────────

function initContextEditor() {
  const textarea = document.getElementById('context-yaml');
  if (!textarea) return;
  // Drop the pre-2026-07-29 value rather than leave it sitting there to be found later.
  try { localStorage.removeItem(CONTEXT_STORAGE_KEY_LEGACY); } catch (e) { /* private mode */ }

  // Restore from localStorage if available
  const saved = localStorage.getItem(CONTEXT_STORAGE_KEY);
  if (saved) {
    try {
      const Y = yamlLib();
      if (!Y) throw new Error('no yaml');   // caught below → falls back to the template
      const parsed = Y.load(saved);
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        adoptContext(splitContextDoc(parsed));
        textarea.value = saved;
      } else {
        // All-comment YAML or empty object — treat as no overrides
        localStorage.removeItem(CONTEXT_STORAGE_KEY);
        textarea.value = CONTEXT_TEMPLATE;
      }
    } catch {
      // Corrupted storage — fall back to defaults
      localStorage.removeItem(CONTEXT_STORAGE_KEY);
      textarea.value = CONTEXT_TEMPLATE;
    }
  } else {
    textarea.value = CONTEXT_TEMPLATE;
  }

  document.getElementById('context-apply')?.addEventListener('click', applyContext);
  document.getElementById('context-reset')?.addEventListener('click', resetContext);
}

initContextEditor();

// ── Port-to context editor ──────────────────────────────────────────────────

// Versioned with the context editor's key, and for the same reason — see context-editor.js.
const PORT_STORAGE_KEY = 'nucleosome-port-v2';
const PORT_STORAGE_KEY_LEGACY = 'nucleosome-port';

// Mutable overrides for the port-to context — same shape as contextOverrides.
let portOverrides = {};

// `isPortActive()` STOOD HERE and is deliberately gone (BB, 2026-07-30). It reported whether a
// Show-as YAML had been applied, and every caller wanted to know something else — whether the port
// points anywhere but the context. Picking any target writes the YAML, so it answered "yes" for
// Hs→Hs and could never be turned off again by setting the two to match.
//
// Not left in place as a helper: it reads like the function you want, and the next person to ask
// "is porting on?" would reach for it and re-introduce the same bug. The question now has one
// answer, `portTargetsElsewhere` in port-model.js, and it takes both ends so it can compare them.

// TWO CONTEXTS, SYMMETRIC, BOTH ALWAYS STATED (BB, 2026-08-07: "The single source of truth are the
// two contexts (context/port). They are initialized from local storage or default to human. They
// have the complete shape any other context file would have. No assumptions.")
//
// Everything this file carried about an UNSTATED Show as went with that ruling: `portInheritedTaxon`,
// `portInheritedYaml`, the null default, and the normalisation in BOTH writers that turned a target
// equal to the context back into an empty box. They were one design — "empty means follow Read as"
// — and it was a third state wearing the clothes of an absence. It kept breaking in the same way,
// because every consumer had to translate it and no two translated it alike.
//
// There is nothing to translate now. The Show as is a CONTEXT: it starts in the reference organism,
// it is restored from storage, and it always states a complete target. Whether a port is ON is a
// COMPARISON of the two — `portTargetsElsewhere` in port-model.js, which the shell asks. If the
// reader moves Read as to mouse and leaves Show as at human, the two DISAGREE and a port is on.
// That is what the two dropdowns are saying, and it is now also what the page does.

// The Show as YAML a species pick writes. Same shape as the Read as editor's, which is the deposited
// container's shape (context-editor.js, data/PMID33649601-ACF/library_specs.yaml) — with ONE
// difference, and it is not a hidden state: the Read as menu spells the four families out, this one
// does not. A family block in a Show as is a statement that THAT family is read somewhere else, which
// `portTargetsElsewhere` counts as a port on its own, so a menu writing four of them would turn
// porting on every time you picked the organism you are already in. An example belongs commented.
//
// The species name is PASSED IN, not looked up. Reaching for shell.js's `speciesNameForTaxon` from
// here ran at load — port-editor.js is included before shell.js — and the function hoists while
// the table it reads does not, so the call threw on `SPECIES_TAXON` before initialization and took
// the whole page module scope with it. This file has no business knowing where species names live.
function portYamlForTaxon(taxonId, speciesName) {
  return `context:
  taxon_id: ${taxonId}${speciesName ? '          # ' + speciesName : ''}
# A family block ports ONE family somewhere else. Uncomment and edit.
#  H3:
#    uniprot_id: P84233
#    uniprot_name: H32_XENLA
#  H4:
#    taxon_id: 4932
`;
}

// What an untouched — or reset — Show as box says. Generated from the same function the menu
// uses, so the box and the target it stands for cannot come apart.
const PORT_TEMPLATE = portYamlForTaxon(CONTEXT_DEFAULT_TAXON, null);

// The context-level taxon of the Show as YAML: the target for any family it does not name.
// Initialised exactly as `contextDefaultTaxon` is, from the same constant, and never unset.
let portDefaultTaxon = CONTEXT_DEFAULT_TAXON;

// THE ONE PLACE THE SHOW-AS CONTEXT IS SET (BB, 2026-08-07), mirroring `adoptContext` — including
// what an unstated default means: the reference organism. Clearing the Show as box asks to stop
// porting, and with both lenses stated that is the same request as pointing it where Read as starts.
function adoptPort(split) {
  portOverrides    = (split && split.families) ? split.families : {};
  portDefaultTaxon = (split && split.defaultTaxon != null) ? split.defaultTaxon : CONTEXT_DEFAULT_TAXON;
}

// Applied BENEATH the per-family port entries, mirroring contextDefaultOverride. UNCONDITIONAL:
// there is no unstated Show as to represent, and the empty object that used to stand for one meant
// ⊤ to everything that received it.
function portDefaultOverride() {
  return { taxon_id: portDefaultTaxon };
}

// Resolve a port-to context for a given family/variant.
// Uses portOverrides instead of contextOverrides.
// `callOverride` (e.g. { taxon_id } from the shell's query-global port species
// lens) is merged OVER the per-family portOverrides entry, mirroring
// resolveContext(family, variant, overrides) in duckdb.js. 2-arg callers pass
// callOverride = {} and are unaffected.
async function resolvePortContext(family, variant, callOverride = {}) {
  const lookupKey = variant ?? family;
  const userOv    = portOverrides[lookupKey] ?? portOverrides[family] ?? {};
  // Same precedence as the Read as side: context-level default, then the family block, then the
  // call override. The default is now always stated, so `merged` is never empty and the
  // "no port applies to this family" early return that stood here could not fire; the question it
  // answered is asked once, by the shell, as `portActive()`.
  const merged    = { ...portDefaultOverride(), ...userOv, ...callOverride };

  // A PINNED MATERIAL CARRIES ITS OWN SPECIES, on this side too. Same layering as resolveContext
  // (duckdb.js:69): the context-level default is the reader's background lens and yields to a
  // material the Show as names, while a taxon stated ABOUT this material — the family block, or
  // the call — still constrains. It used to be enough that an unset Show-as default left the taxon
  // null; with both lenses stated it is not, and without this a Show as porting one family to a frog
  // accession (`H3: {uniprot_id: P84233}`) resolves it against human and returns zero rows.
  const pinsMaterial = merged.uniprot_id != null || merged.protein_name != null;
  const aboutThisMaterial = callOverride.taxon_id ?? userOv.taxon_id ?? null;
  const taxon = pinsMaterial ? aboutThisMaterial : (merged.taxon_id ?? null);

  const conn = await dbConnect();
  try {
    const sql = `
      WITH pick AS (
        SELECT DISTINCT
          family, variant, uniprot_id, protein_name,
          species, taxon_id, n_gene_loci
        FROM read_parquet('${PROTEINS_URL}')
        WHERE family = $1
          AND ($2 IS NULL OR variant = $2)
          AND ($3 IS NULL OR uniprot_id = $3)
          AND ($4 IS NULL OR protein_name = $4)
          AND ($5 IS NULL OR species = $5)
          AND ($6 IS NULL OR taxon_id = $6)
        ORDER BY n_gene_loci DESC, uniprot_id
        LIMIT 1
      ),
      seq AS (
        SELECT
          p.uniprot_id,
          STRING_AGG(p.residue, '' ORDER BY p.protein_position) AS sequence
        FROM read_parquet('${PROTEINS_URL}') p
        JOIN pick ON p.uniprot_id = pick.uniprot_id
        WHERE p.protein_position >= 1
        GROUP BY p.uniprot_id
      ),
      mw AS (
        SELECT
          p.uniprot_id,
          SUM(rm.average)      + w.average      AS average_mw,
          SUM(rm.monoisotopic) + w.monoisotopic  AS monoisotopic_mw,
          COUNT(*)                               AS n_residues
        FROM read_parquet('${PROTEINS_URL}') p
        JOIN pick ON p.uniprot_id = pick.uniprot_id
        JOIN read_parquet('${MASSES_URL}') rm ON p.residue = rm.residue
        CROSS JOIN read_parquet('${WATER_URL}') w
        WHERE p.protein_position >= 1
        GROUP BY p.uniprot_id, w.average, w.monoisotopic
      )
      SELECT
        pick.*,
        seq.sequence,
        mw.average_mw,
        mw.monoisotopic_mw,
        mw.n_residues
      FROM pick
      JOIN seq ON pick.uniprot_id = seq.uniprot_id
      JOIN mw  ON pick.uniprot_id = mw.uniprot_id`;

    const stmt = await conn.prepare(sql);
    const result = await stmt.query(
      family,
      variant ?? merged.variant ?? null,
      merged.uniprot_id ?? null,
      merged.protein_name ?? null,
      merged.species ?? null,
      taxon
    );
    await stmt.close();

    const rows = result.toArray().map(r => r.toJSON());
    if (rows.length === 0) return null;

    const ctx = rows[0];
    ctx.modifications = merged.modifications ?? [];
    return ctx;
  } finally {
    await conn.close();
  }
}

// The source↔port numbering map used to be built HERE, as a DuckDB JOIN on `family_position`
// (`resolvePortAlignment`). It is gone: `portAlignment()` in port-model.js derives the same map
// synchronously from the registry frame, so numbering has ONE implementation instead of three.
// It was also keyed material→material while notation marks carry IDEA positions — see the note on
// portAlignment for what that moved. Nothing to cache; nothing to invalidate.

// Kept for the consensus→protein map below (measurement placement); the port alignment it also
// used to clear no longer exists.
function clearAlignmentCache() {
  variantPosCache.clear();
}

// Map variant_position → protein_position for a given protein.
// Used to place measurement modifications on the port protein's sequence.
const variantPosCache = new Map();

async function resolveVariantToProteinPos(uniprotId) {
  if (variantPosCache.has(uniprotId)) return variantPosCache.get(uniprotId);

  const conn = await dbConnect();
  try {
    const sql = `
      SELECT variant_position, protein_position
      FROM read_parquet('${PROTEINS_URL}')
      WHERE uniprot_id = $1
        AND protein_position >= 1
        AND variant_position IS NOT NULL`;
    const stmt = await conn.prepare(sql);
    const result = await stmt.query(uniprotId);
    await stmt.close();

    const map = new Map();
    for (const r of result.toArray().map(r => r.toJSON())) {
      map.set(r.variant_position, r.protein_position);
    }
    variantPosCache.set(uniprotId, map);
    return map;
  } finally {
    await conn.close();
  }
}

// ── Apply / Reset ────────────────────────────────────────────────────────

function setPortTaxon(taxonId, speciesName) {
  // MIRRORS setContextTaxon, and no longer normalises. Picking the organism you are already reading
  // in STATES it — it does not clear the box — because "the Show as follows the Read as" is the
  // state BB removed. The two lenses simply agree, which is what makes it no port.
  const text = portYamlForTaxon(taxonId, speciesName);
  const box  = document.getElementById('port-yaml');
  if (box) box.value = text;
  // What the text above parses to, computed directly — see splitForTaxon in context-editor.js for
  // why the menu path does not go through js-yaml. No families: the menu writes none.
  adoptPort({ defaultTaxon: taxonId, families: {} });
  try { localStorage.setItem(PORT_STORAGE_KEY, text); } catch (e) { /* private mode */ }
}

function applyPort() {
  const textarea = document.getElementById('port-yaml');
  const errorEl  = document.getElementById('port-error');
  if (!textarea) return;

  try {
    const Y = yamlLib();
    if (!Y) { errorEl.textContent = YAML_MISSING; errorEl.className = 'context-error'; return; }
    const parsed = Y.load(textarea.value);
    if (parsed == null) {
      // Empty or all comments — back to the reference organism, exactly as the Read as box does.
      // Not to "no Show as": there is no such state for anything downstream to read.
      adoptPort(null);
      localStorage.removeItem(PORT_STORAGE_KEY);
      clearAlignmentCache();
      errorEl.textContent = 'Show as reset to defaults';
      errorEl.className = 'context-applied';
      if (typeof updateControls === 'function') updateControls();
      reRender();
      return;
    }
    if (typeof parsed !== 'object') {
      errorEl.textContent = 'YAML must be a mapping of family tokens to override entries.';
      errorEl.className = 'context-error';
      return;
    }
    // APPLIED AS TYPED. This used to compare the applied target against the Read-as context and, when
    // they agreed, store nothing — the one representation of "follows the context" was an empty
    // box. With both lenses stated there is nothing to normalise: a Show as equal to the Read as is
    // stored, and it is not a port because the comparison says so, not because the box is blank.
    adoptPort(splitContextDoc(parsed));
    localStorage.setItem(PORT_STORAGE_KEY, textarea.value);
    clearAlignmentCache();
    errorEl.textContent = 'Show as applied';
    errorEl.className = 'context-applied';
    // The buttons read the YAML, so adopting new YAML must refresh them — otherwise Apply
    // changes the lens and leaves the label on whatever the menu last said.
    if (typeof updateControls === 'function') updateControls();
    reRender();
  } catch (e) {
    errorEl.textContent = `YAML error: ${e.message}`;
    errorEl.className = 'context-error';
  }
}

function resetPort() {
  adoptPort(null);
  localStorage.removeItem(PORT_STORAGE_KEY);
  clearAlignmentCache();
  const textarea = document.getElementById('port-yaml');
  const errorEl  = document.getElementById('port-error');
  if (textarea) textarea.value = PORT_TEMPLATE;
  if (errorEl)  errorEl.textContent = '';
  if (typeof updateControls === 'function') updateControls();
  reRender();
}

// ── Initialise ───────────────────────────────────────────────────────────

function initPortEditor() {
  try { localStorage.removeItem(PORT_STORAGE_KEY_LEGACY); } catch (e) { /* private mode */ }
  const textarea = document.getElementById('port-yaml');
  if (!textarea) return;

  const saved = localStorage.getItem(PORT_STORAGE_KEY);
  if (saved) {
    try {
      const Y = yamlLib();
      if (!Y) throw new Error('no yaml');
      const parsed = Y.load(saved);
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        adoptPort(splitContextDoc(parsed));
        textarea.value = saved;
      } else {
        localStorage.removeItem(PORT_STORAGE_KEY);
        textarea.value = PORT_TEMPLATE;
      }
    } catch {
      localStorage.removeItem(PORT_STORAGE_KEY);
      textarea.value = PORT_TEMPLATE;
    }
  } else {
    textarea.value = PORT_TEMPLATE;
  }

  document.getElementById('port-apply')?.addEventListener('click', applyPort);
  document.getElementById('port-reset')?.addEventListener('click', resetPort);
}

initPortEditor();

// docs/_includes/js/shell-model.js
// Pure view-model for the worlds-first shell. DOM-free, Node-exportable.
(function (root) {
  'use strict';

  // A modification's SUBSTITUTED residue. The v1 parse tree calls it `variant`, the v2 tree and the
  // IR call it `substitution` — the project's one documented field rename, and the slot-level
  // `variant` (the histone variant) is a different thing at a different nesting level, which is why
  // the names collide at all. Reading only `variant` meant a v2-shaped mod carrying a substitution
  // looked mark-less: `H3:K27M|K,K36ac` kept both mods in the model but showed only K36ac as a pill,
  // because K27M's value lives in `substitution`. Harmless on a v1 tree (undefined), required for
  // Phase 4, where the view-models are fed a v2 tree.
  // The substituted residue of a mark. The name is worth keeping even though the body is now one
  // field: "substitution" at the mark level and `variant` at the SLOT level are different concepts
  // that used to share a word (CLAUDE.md §8), and reading `m.substitution` bare invites the reader to
  // wonder which one they are looking at.
  //
  // The `m.variant ?? …` fallback that used to lead this was a v1 remnant. parse2 emits
  // `substitution` on the tree AND the IR — measured 2026-08-05 over the reviewed corpus plus the
  // chips, 231 parseable notations: zero marks carried `.variant`, 116 carried `.substitution`. Only
  // a test kept the branch alive, which is the third time this session an ASSERTION rather than a
  // caller has held dead code up.
  function modSub(m) {
    return (m && m.substitution) ?? null;
  }

  // Mark key of ONE modification — the WORLD-SIGNATURE key, so `renderMaterials` can resolve any
  // world copy (a subset or cis-combination of the stated marks) back to its mod objects.
  //
  // IT IS THE ENGINE'S, NOT A COPY OF IT. This was four lines here under a comment saying it "MUST
  // match the key interpret.js emits" — a requirement stated and then left to hope, and the two had
  // already drifted on a null position ("null" there, "" here). Calling the engine's makes the
  // requirement structural. (census §1.1, 2026-08-05)
  //
  // Note it is NOT `meet2`'s mark key, which drops the residue and sorts value sets because it
  // answers the lattice's question rather than the picture's. Both used to be called `markKey`.
  // No fallback, deliberately, and unlike `pinnedVariant` below. A missing engine there costs a
  // prettier token; here it would cost a DIFFERENT KEY, and a key that quietly disagrees is the
  // failure this whole change is undoing. Throwing is the same contract `emit_material.markStr`
  // keeps. The page loads parser2.js before every module, so this can only fire in a harness that
  // has not.
  function markKey(m) {
    const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.markSigKey !== 'function')
      throw new Error('shell-model: nucleosomeParser2.markSigKey unavailable — load build/parser2.js first');
    return P.markSigKey(m);
  }

  // ── extent pre-filter: bounds before the meet (BB's suggestion, 2026-07-28) ──────────────────────
  //
  // `compatible2` is a full meet plus a physics filter, and the measurements panel runs it once per
  // measurement group. Most rejections do not need any of that: if a datum states a mark at a
  // position the query's extent excludes, no object satisfies both, because the meet intersects the
  // extents and then requires every mark to sit on surviving material.
  //
  // ONE-SIDED ON PURPOSE. It answers "certainly not compatible" or "don't know", never "compatible" —
  // so it can only ever save work, and a bug in it shows up as slowness rather than as a wrong
  // answer. Everything it does not reject goes through the real relation unchanged.
  //
  // It does nothing for a MARK-LESS datum (unmodified H3 and the like), which is correct and worth
  // stating: such a datum really is co-satisfiable with almost any query on that family, and that is
  // discovery working, not a filter failing.
  function extentBounds(segs) {
    if (!segs || !segs.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const s of segs) {
      lo = Math.min(lo, s.start === '-inf' ? -Infinity : s.start);
      hi = Math.max(hi, s.end === '+inf' ? Infinity : s.end);
    }
    if (lo === -Infinity && hi === Infinity) return null;   // ⊤ excludes nothing
    return { lo, hi };
  }

  // Marks a proteoform positively asserts, per family. A NEGATED mark asserts absence and constrains
  // nothing about where material is, so it is not evidence of anything lying outside an extent.
  function markedPositions(node, into) {
    const out = into || new Map();
    if (!node || typeof node !== 'object') return out;
    if (node.node === 'proteoform') {
      for (const m of (node.modifications || [])) {
        if (!m || m.negated || m.position == null) continue;
        if (m.position === '-inf' || m.position === '+inf') continue;   // terminal loci float
        if (!out.has(node.family)) out.set(node.family, []);
        out.get(node.family).push(m.position);
      }
      return out;
    }
    for (const m of (node.members || [])) markedPositions(m, out);
    return out;
  }

  // Per-family extent bounds a node imposes.
  //
  // A FAMILY IS BOUNDED ONLY IF EVERY COPY OF IT IS. This is the whole subtlety, and the first
  // version got it wrong: `(H3[1-30])` is an OCTAMER, so completion gives it a second, full-length
  // H3 — and a datum marking K36 is genuinely co-satisfiable with THAT copy. Reading the bound off
  // the stated copy alone made the filter reject 16 datums that `compatible2` accepts.
  //
  // So a ⊤ copy clears the family: `null` is recorded as "unbounded" and, once recorded, wins.
  function extentByFamily(node, into) {
    const out = into || new Map();
    if (!node || typeof node !== 'object') return out;
    if (node.node === 'proteoform') {
      if (!node.family) return out;
      const b = extentBounds(node.segments);
      if (out.get(node.family) === null) return out;          // already unbounded — nothing can re-bound it
      if (!b) { out.set(node.family, null); return out; }      // this copy is ⊤ ⇒ the family is
      const prev = out.get(node.family);
      out.set(node.family, prev ? { lo: Math.min(prev.lo, b.lo), hi: Math.max(prev.hi, b.hi) } : b);
      return out;
    }
    for (const m of (node.members || [])) extentByFamily(m, out);
    return out;
  }

  // true  → certainly not co-satisfiable, skip the meet
  // false → unknown, ask the real relation
  function extentExcludes(datumIR, queryIR) {
    const bounds = extentByFamily(queryIR);
    if (!bounds.size) return false;
    for (const [fam, positions] of markedPositions(datumIR)) {
      const b = bounds.get(fam);
      if (!b) continue;
      for (const p of positions) if (p < b.lo || p > b.hi) return true;
    }
    return false;
  }

  // The variant token this proteoform PINS, or null when nothing is pinned. One line, because
  // `variantToken2` already answers exactly this: it returns null for a family-wide variant, so it
  // never hands back the family name.
  //
  // There were two of these, in this file and the other one, and they differed (census §2,
  // 2026-08-05). particle-scene's guarded `t !== pf.family`; shell-model's did not. Measured:
  // `variantToken2` returns null for `(H3)` and `(H2A)` and a real token for `(H3.1)`, `(caH3)`,
  // `(H2A.Z)` — the guard was dead defensiveness and the two agreed everywhere reachable. Agreeing
  // everywhere reachable is what a duplicate does right up until it does not.
  //
  // Throws rather than degrading, like `markKey`: the fallbacks the two copies carried differed from
  // each other too, and a fallback that only runs when the engine is missing is a second answer
  // nobody can see being wrong.
  function pinnedVariant(pf) {
    const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.variantToken2 !== 'function')
      throw new Error('variantToken2 unavailable — load build/parser2.js first');
    return P.variantToken2(pf.family, pf.variant);
  }

  function isFillMember(pf) {
    const marks = (pf.modifications || []).filter((m) => m && !m.negated);
    const variant = pinnedVariant(pf);
    return !marks.length && (variant == null || variant === pf.family);
  }

  // Certainty for the whole member: closed iff every stated extent is closed (meet2's `certAt` with a
  // null position — a positionless claim is closed only if all present material is).
  function memberCertainty(pf) {
    const segs = pf.segments || [];
    if (!segs.length) return null;
    return segs.every((x) => x.certainty === 'defined') ? 'defined' : 'native';
  }

  function materialsFromCanon(node) {
    if (!node || typeof node !== 'object') return [];
    // canon of a bare histone IS a proteoform, not an assembly with members.
    // `particleOf` unwraps a one-member array — the engine's own unwrap, not a fourth inline copy
    // of it. (canon of a bare histone IS a proteoform, not an assembly with members.)
    const PU = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    const inner = (PU && typeof PU.particleOf === 'function') ? PU.particleOf(node) : node;
    const members = node.node === 'proteoform' ? [{ pf: node, copies: 1 }]
                  : materialsFromCanonMembers(inner);
    const list = Array.isArray(members) ? members : [];
    const entries = list.map(({ pf, copies }) => {
      const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
      const vt = pinnedVariant(pf);
      const variant = (vt && vt !== pf.family) ? vt : null;
      const mods = (pf.modifications || []).filter((m) => m && m.rangeEnd == null && m.position != null);
        // NOT FILTERED to "stated extent only". A whole-chain segment carries no extent information, but
      // it does carry the query's CERTAINTY, and the grid band is the one place that is worth drawing:
      // a dotted rule across the full length says "full-length, native", which is true and is what a
      // reader expects to see. Everything that must react only to a STATED extent — the head badge, the
      // extent-restricted mass, the dimming — already tests for a whole chain itself and ignores it.
      const segs = (pf.segments || []).slice();
      // THE TOKEN THE CARD'S NUMBERS WERE WRITTEN UNDER (R5, 2026-08-03). This was `frameOf(pf)` —
      // the tree LCA of the variant set, the numbering the numbers were to be read in. There is no
      // numbering to name now: a number is read in EACH candidate's own numbering and identifies a
      // column, so what downstream actually needs from this field is the TOKEN, to resolve a
      // segment's endpoints (R12) and to label the card.
      //
      // A compound or complement spelling resolves to no printing reference and falls back to the
      // family's canonical member — which is the same answer `frameOf` gave for such a set, since
      // its LCA was null whenever the set spanned more than one top-level variant.
      //
      // The field keeps the name `frame` for now: six modules and the grid's `data-frame` attribute
      // read it, and renaming it is a sweep of its own rather than part of this one.
      const frame = variant;
      const e = {
        family: pf.family, variant, frame,
        // The copies this member stands for, enclosing repetition included — see
        // `materialsFromCanonMembers`. Reading `pf.count` alone dropped every wrapper.
        count: copies,
        certainty: memberCertainty(pf),
        segments: segs.length ? segs.map((x) => Object.assign({}, x)) : null,
        mods, _markMods: {},
        hasMark: mods.some((m) => modSub(m) || m.modification),
        isFill: isFillMember(pf),
      };
      mods.forEach((m) => { if (modSub(m) || m.modification) e._markMods[markKey(m)] = m; });
      // Card identity must distinguish two members of one family — the marked H3 and its wild-type
      // partner — or `openCards` and the ghost lookup collapse them back together, which is exactly
      // the merge this replaces.
      //
      // ASK THE IR, DO NOT RESTATE IT. `pfCanonKey` is the engine's own identity for a proteoform
      // and already carries every axis, segments included. The hand-built string below omitted them,
      // so `([H3[1-30]]@[H3[40-60]])` produced two correctly-distinct cards that then shared the key
      // `H3||` — and since that key is `data-cardkey` and drives `openCards`, expanding one expanded
      // the other and measurement highlighting targeted both. Two extents are two molecules; the
      // canon has always said so.
      //
      // The fallback keeps this module usable with no engine loaded (the isolated-Node path), where
      // saying something weaker is better than throwing.
      const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
      e.key = (P && typeof P.pfCanonKey === 'function')
        ? P.pfCanonKey(pf)
        : e.family + '|' + (e.variant ?? '') + '|' + mods.map(modSig).sort().join(',')
          + '|' + (e.segments || []).map((x) => x.start + '-' + x.end + ':' + x.certainty).join(',');
      return e;
    });
    // ── ONE ENTRY PER IDENTITY, COPIES SUMMED ────────────────────────────────────────────────────
    // The walk above emits one entry per COPY, which is right — it is how the marked H3 and its
    // wild-type partner stay two cards. What it must not do is hand back the same IDENTITY twice.
    //
    // `key` is `pfCanonKey`, it reaches the DOM as `data-cardkey`, and `openCards` is a Set of these.
    // So a repeated key is not a cosmetic duplicate: the two cards expand and collapse together and
    // measurement highlighting lights both. `(H4K4ac)(H3)` listed NINE cards over five identities —
    // H4[K4ac], H4, H2A, H2B, H3, H3, H2A, H2B, H4 — with the two plain H4 cards opening as one.
    //
    // IT TOOK TWO UNEQUAL PARTICLES TO SHOW, which is why the pane looked right for so long. A
    // single particle names each family once, and `(H3)(H3)` FUSES to one member with count 2 in
    // `fuseCanon` before this walk runs. Only a heterogeneous array — two particles that do not
    // fuse — reaches the duplicate.
    //
    // `worldView` has grouped by this key and summed the counts since it was written; this is the
    // same rule, so the two card lists now agree about what one card is. Summing rather than
    // dropping matters: discarding the duplicate would halve the pane's own copy count, and
    // `compositionCounts` (asserted below) would stop matching.
    //
    // Nothing else about the entry can disagree between two copies that share a key. `isFill` is
    // `isFillMember`, a pure function of the marks and the pinned variant, and `pfCanonKey` carries
    // both — so same key implies same fill, and there is no merge rule to choose here.
    const merged = [];
    const byKey = new Map();
    entries.forEach((e) => {
      const seen = byKey.get(e.key);
      if (seen) { seen.count += e.count; return; }
      byKey.set(e.key, e); merged.push(e);
    });
    // Conditional, as in the caption: quiet the fills only when something else is speaking.
    if (merged.every((e) => e.isFill)) merged.forEach((e) => { e.isFill = false; });
    return merged;
  }
  // THE ENCLOSING COUNT IS A COPY COUNT (BB, 2026-08-06). This walked into `members` with nothing
  // threaded through and each card then took the proteoform's OWN count, so every enclosing
  // repetition was dropped: `([H3@H4]2@H2A@H2B)` — an octamer written with an explicit tetramer —
  // listed one H3 and one H4 beside two H2A and two H2B, while `compositionCounts` said 2/2/2/2 and
  // `classify2` called it a nucleosome. `grammar/stoichiometry.js` says in as many words that this
  // is one of the two walks that need the copies rather than a tally, and that the multiplier is
  // what they share — so it is shared, rather than restated.
  //
  // A member is emitted once per copy and carries its multiplier, because the cards are per-COPY
  // (the marked H3 and its wild-type partner are two cards) and `pfCanonKey` is what tells them
  // apart. Multiplying the count on one entry would merge them again.
  function materialsFromCanonMembers(n) {
    const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    const mult = (x, root) => (P && typeof P.copyMultiplier === 'function')
      ? P.copyMultiplier(x, root)
      : (root && x && x.dna != null ? 1 : (x && x.count == null ? 1 : x.count));
    const out = [];
    (function walk(x, carried, root) {
      if (!x || typeof x !== 'object') return;
      const k = mult(x, root);
      if (x.node === 'proteoform') { out.push({ pf: x, copies: k * carried }); return; }
      (x.members || []).forEach((m) => walk(m, carried * k, false));
    })(n, 1, true);
    return out;
  }

  // ── the meet bench ───────────────────────────────────────────────────────────────────────────────
  // A DEBUGGING surface: given two resolved IR nodes, what does the lattice say about them?
  //
  //   meet   the set of maximal lower bounds — [] is ⊥, "these two describe nothing in common".
  //          meet2 is set-valued, so more than one result is normal and worth SEEING rather than
  //          collapsing: it is where the algebra stops being a single answer.
  //   entails  asymmetric — reported BOTH ways, because which direction holds is the whole question
  //            and having to press swap to find out would hide it.
  //   compatible  symmetric in every case checked; reported once, and the model asserts the symmetry
  //               rather than assuming it, so a future asymmetry shows up as a `compatAsymmetric`
  //               flag instead of a quietly arbitrary half-truth.
  //
  // `notate(node)` is injected — it is `canonNotation` on the page — so this stays free of the
  // context/registry plumbing and can be tested with a stub.
  function meetBench(a, b, P2, notate) {
    if (!P2 || typeof P2.meet2 !== 'function') return { error: 'engine unavailable' };
    if (!a || !b) return { error: 'two queries needed' };
    for (const [side, n] of [['left', a], ['right', b]]) {
      if (n.node === 'error') return { error: `${side}: ${n.reason || 'unresolved'}` };
      if (n.node === 'bottom') return { error: `${side}: ⊥` };
    }
    let set;
    try { set = P2.meet2(a, b) || []; } catch (e) { return { error: 'meet threw: ' + e.message }; }
    const say = (fn, x, y) => { try { return !!P2[fn](x, y); } catch (e) { return null; } };
    const cAB = say('compatible2', a, b), cBA = say('compatible2', b, a);
    return {
      bottom: set.length === 0,
      // A meet result that emit2 cannot write is reported as such, not silently omitted — the count
      // and the notations must agree or the bench lies about how set-valued the answer is.
      results: set.map((n) => (notate ? notate(n) : null) || '(no exact notation)'),
      entailsAB: say('entails2', a, b),
      entailsBA: say('entails2', b, a),
      compatible: cAB,
      compatAsymmetric: cAB !== cBA,
      error: null,
    };
  }

  const EXPECT_MAP = {
    '[A-Z]': 'a residue letter', '[0-9]': 'a position number', 'modification': 'a modification',
    ']': 'a closing bracket', ')': 'a closing paren', '}': 'a closing brace', '@': 'a histone separator',
  };
  // Peggy expectations come in several shapes and only two carry a string. A `class` expectation
  // (a character set) has neither `description` nor `text`, so `String(e)` printed "[object Object]"
  // into the user-facing error — an error message that is itself broken is worse than no message.
  function describeExpectation(e) {
    if (!e || typeof e !== 'object') return String(e);
    if (e.description) return e.description;
    if (e.text) return e.text;
    if (e.type === 'class' && Array.isArray(e.parts))
      return e.parts.map((p) => (Array.isArray(p) ? p[0] + '-' + p[1] : p)).join('');
    if (e.type === 'any') return 'any character';
    if (e.type === 'end') return 'end of input';
    return e.type ? String(e.type) : String(e);
  }

  function humanizeExpected(expected) {
    const out = [], seen = new Set();
    for (const e of (expected || [])) {
      const raw = describeExpectation(e);
      const label = EXPECT_MAP[raw] || raw;
      if (!seen.has(label)) { seen.add(label); out.push(label); }
    }
    return out;
  }

  // ── EXPECTATIONS ARE GROUPED, NOT LISTED (BB, 2026-08-06) ──────────────────────────────────────
  // Peggy returns one expectation per alternative the parser could still have taken, and for this
  // grammar that is thirty-odd: every PTM token separately, every residue class, every separator,
  // and the whitespace class printed as a literal newline. Joined with " or " it was a paragraph of
  // tokens that a reader has to scan character by character to learn one fact.
  //
  // The fact they need is the KIND of thing that fits, not the enumeration. Nobody is helped by
  // being told `bhb` is legal here; they are helped by "a modification would fit". So each raw
  // expectation is classified into one of a dozen categories and the card lists the categories
  // present, in a fixed order — which turns thirty items into six or seven bullets.
  //
  // Two categories are DROPPED rather than shown: whitespace and `_`. Both are optional connective
  // characters that are accepted almost everywhere and are therefore never the piece you left out;
  // listing them adds a line to every error card and answers nothing.
  //
  // THE WORDING IS NOT IN THIS FILE (BB, 2026-08-06). It lives in `copy/messages.yaml`, which
  // generates `docs/assets/js/messages.js` — the same hand-edited-YAML → generated-JS route
  // `registry/vocabulary.yaml` takes. What stays here is the part that is logic: which category a
  // Peggy expectation falls into, and when two categories collapse into one line. Editing a label
  // should not mean reading this function, and it no longer does.
  //
  // Resolved two ways because this module is loaded two ways: inlined into the page (where the
  // generated file has already run as a <script> and left `MESSAGES` global) and `require`d by the
  // node suites (where it has not). The `require` literal is never evaluated in the browser.
  const MSG = (typeof MESSAGES !== 'undefined' && MESSAGES) ? MESSAGES
            : (typeof require === 'function' ? require('../../assets/js/messages.js') : {});
  const SYNTAX_MSG = (MSG && MSG.syntax_error) || {};

  // A ONE-ITEM YAML LIST IS STILL A LIST. The generator unboxes length-1 vectors, so `only_if_alone:
  // [end]` arrives as the string "end" while `[end, foo]` arrives as an array — an editing trap that
  // would make a catalogue change behave differently at one item than at two. Normalised on the way
  // in, once, rather than guarded at each use.
  const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

  // ORDER IS THE ORDER ON SCREEN, and it is stated in the YAML rather than inferred from JSON key
  // order, which nothing promises. `group_order` is derived from the `groups:` key order by
  // `build_messages_js.R` and written alongside it — which it genuinely was not until 2026-08-07,
  // so this line ran its fallback for the whole of that key's life and the order held by luck. The
  // fallback stays as one: a catalogue that predates the key still renders, in the order it has.
  const EXPECT_GROUPS = asList(SYNTAX_MSG.group_order || Object.keys(SYNTAX_MSG.groups || {}))
    .map((k) => [k, SYNTAX_MSG.groups[k]]);

  // ONE LIST ANSWERS BOTH QUESTIONS (BB, 2026-08-06). Which kinds carry examples and which examples
  // go first were two catalogue keys, and a kind could be named in one and missing from the other.
  // `example_preferences` is now the whole answer: a kind named there carries examples, a kind absent
  // does not, and the VALUE distinguishes the two ways of having them —
  //
  //   mod: [ac, me3]   these first, then whatever else the parser is offering
  //   family:          (null) — whatever the parser is offering, in the vocabulary's own order
  //   entity: []       named, but no examples
  //
  // The null/[] distinction is why this cannot collapse to "non-empty means yes": an empty list is a
  // deliberate silence and a missing value is a deliberate deferral to the grammar.
  const EXAMPLE_PREFS = SYNTAX_MSG.example_preferences || {};
  const WITH_EXAMPLES = new Set(Object.keys(EXAMPLE_PREFS)
    .filter((k) => EXAMPLE_PREFS[k] == null || asList(EXAMPLE_PREFS[k]).length > 0));

  // MEMBERSHIP, NOT SHAPE (BB, 2026-08-06). This classified by pattern until it was measured: over
  // the 794 distinct expectations the grammar can report, "lowercase-ish alphanumeric ⇒ a
  // modification" claimed 679 of them, and the vocabulary has 19. The rest are entity handles —
  // `Cse4`, `ENSMUSG00000060262`, `FLJ10903` — and the card was offering them as examples of a PTM.
  // "Two or more capitals ⇒ a residue" had the same defect on a smaller scale (`CENPA`, `SHPRH`).
  //
  // The vocabulary knows exactly which token is which, and the generated catalogue now carries those
  // sets. So a token is a PTM if the registry says so, a family or a variant likewise (every accepted
  // SPELLING, since `caH3`, `ca H3` and `canonical_H3` arrive as three separate alternatives), and
  // the residual — alphanumeric, in none of the sets — is the gene/accession handle the grammar
  // enumerates 577 of. `other` is now a genuine "should not happen" rather than the biggest bucket.
  const TOK = (MSG && MSG.tokens) || {};
  const PTM_TOKENS     = new Set(TOK.ptm || []);
  const FAMILY_TOKENS  = new Set(TOK.family || []);
  const VARIANT_TOKENS = new Set(TOK.variant || []);

  // Classes arrive from `describeExpectation` as their concatenated contents, so a class is matched
  // on what is IN it: `ACDEFGHIKLMNOPQRSTUVWY` and `BJXZ` are the residue alphabets, `aα`/`oω` the
  // terminal marks, `₀-₉` the subscript digits.
  function expectCategory(raw) {
    // `end` HAS NO LABEL, deliberately (BB, 2026-08-06). "Nothing more" listed under "one of these
    // would fit here" is a contradiction, and it names no edit — a reader told their stray `-` could
    // be followed by the end of the query has learned nothing they can act on. Where it is the ONLY
    // thing on offer that is still the diagnosis, and `syntaxError` says so in a sentence of its own
    // (`nothingFits` → the catalogue's `nothing_fits`) rather than as a bullet.
    if (raw === 'end of input') return null;
    if (raw === 'any character') return null;
    if (/^[ \t\n\r]+$/.test(raw)) return null;          // see above: never the missing piece
    if (raw === '_') return null;                       // …ditto

    // The registry's own answer comes first — a variant spelled `H2A.1` must not be read as a
    // family name by a prefix rule, and `me` must not be read as a handle.
    if (PTM_TOKENS.has(raw)) return 'mod';
    if (FAMILY_TOKENS.has(raw)) return 'family';
    if (VARIANT_TOKENS.has(raw)) return 'variant';

    if (raw === '0-9' || raw === '₀-₉' || raw === '0') return 'number';
    if (raw === 'A-Z0-9') return 'name';
    if (raw === 'Nle' || raw === 'ACDEFGHIKLMNOPQRSTUVWY' || raw === 'BJXZ') return 'residue';
    if (/^[aα]+$/.test(raw) || /^[oω]+$/.test(raw)) return 'terminus';
    if (/^[@·]+$/.test(raw)) return 'at';
    if (raw === '!') return 'not';
    if (raw === '|') return 'or';
    if (raw === ':') return 'colon';
    if (raw === ',') return 'comma';
    if (raw === '(') return 'paren';
    if (raw === '[' || raw === '{') return 'open';
    if (raw === ')' || raw === ']' || raw === '}') return 'close';
    // `RangeSep` is `–`/`-` and `Polarity` is `^`?("+"/"-") — two different jobs that share a
    // character, so `-` alone is reported as the range (the reading a reader is far likelier to have
    // meant) and the linker forms are named separately.
    if (raw === '-' || raw === '–' || raw === '-–') return 'range';
    if (raw === '^' || raw === '+' || raw === '+-') return 'polarity';
    // The residual. `A-Z` is `RawId`'s first character, so it belongs here rather than with residues.
    if (raw === 'A-Z' || /^[A-Za-z][A-Za-z0-9._ -]*$/.test(raw)) return 'entity';
    return 'other';
  }

  // → an ordered array of MARKUP strings, one per category present. The modification line carries a
  // few real tokens as examples, because "a modification" alone does not tell a reader whether the
  // thing they tried to write counts as one.
  const escExpect = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function groupExpected(expected) {
    const seen = new Map();
    for (const e of (expected || [])) {
      const raw = describeExpectation(e);
      const cat = expectCategory(raw);
      if (!cat) continue;
      if (!seen.has(cat)) seen.set(cat, new Set());
      // A SET, not a list. Peggy reaches the same token through more than one alternative and
      // reports it once per path, so the examples read `(ac, ac, me3, me3, …)` — which looks like a
      // bug in the vocabulary rather than in the reporting.
      seen.get(cat).add(raw);
    }
    const out = [];
    for (const [key, label] of EXPECT_GROUPS) {
      if (!seen.has(key)) continue;
      // `name` and `colon` are ONE choice wherever both are on offer: mid-token the parser will take
      // either more name characters or the colon that ends the descriptor, and as two bullets a line
      // apart that reads as two unrelated options. The `name` LABEL says both — measured over ~10k
      // malformed inputs, `name` never appears without `colon`, so there is no second wording to
      // pick between and no second key in the catalogue. `colon` alone stays reachable (`(H2A.Z`).
      if (key === 'colon' && seen.has('name')) continue;
      const members = Array.from(seen.get(key));
      if (WITH_EXAMPLES.has(key)) {
        // Grammar order is longest-token-first (the shadowing rule in registry/vocabulary.yaml), so
        // taking the first four handed the reader `GlcNAc, me2a, me2s, me3` — four of the rarest
        // tokens in the vocabulary, as the illustration of what a modification looks like. Show the
        // preferred ones when they are on offer, and fall back to grammar order when they are not.
        const prefer = (EXAMPLE_PREFS[key] || []);
        const ranked = members.slice().sort((a, b) => {
          const ia = prefer.indexOf(a), ib = prefer.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        const shown = ranked.slice(0, 4).map((t) => '<b>' + escExpect(t) + '</b>').join(', ');
        out.push(label + ' (' + shown + (members.length > 4 ? ', …' : '') + ')');
      } else {
        out.push(label);
      }
    }
    return out;
  }

  function syntaxError(err, raw) {
    err = err || {};
    const offset = (err.location && err.location.start && err.location.start.offset) || 0;
    const found = err.found ?? null;
    const groups = groupExpected(err.expected);
    return {
      offset, found,
      expected: humanizeExpected(err.expected),
      groups,
      // Nothing would fit, and the parser would have accepted the END here — so the query was already
      // complete and what follows is a stray. That is an actionable sentence; it is NOT a kind, and
      // the card prints it in place of the lead and the list. Distinguished from a merely empty list
      // (a throw with no expectations at all), which gets no sentence because there is nothing true
      // to say about it.
      nothingFits: groups.length === 0
                && (err.expected || []).some((e) => e && e.type === 'end'),
      // `X` IN THE WILD-TYPE SLOT, WHICH IS A RULING AND NOT A TYPO. `H3:X27M` is refused because X
      // is a wildcard for the SUBSTITUTED residue only — omission already says "whatever is there"
      // (`tests/reviewed/rulings/40-parse-value-sets.json`; 10-parse-slot-spine carries the `H2AX5K`
      // ambiguity that retiring the second job buys). The card could say that and instead offered
      // "an amino acid would fit here": true, unhelpful, and silent about the one thing the reader
      // got wrong.
      //
      // The condition is exact rather than a guess at intent — the character IS `X`, and a residue
      // is among the things that would have fitted, which is to say the parser stood at a wild-type
      // slot. Both repairs the sentence names are verified to parse: `H3:27M` and `H3:K27X`.
      xInWildType: found === 'X'
                && (err.expected || []).some((e) => expectCategory(describeExpectation(e)) === 'residue'),
      // WHERE, not just WHAT. The headline names the character the parser choked on and, until
      // 2026-08-07, nothing else — so on `(H3K27M) H4K16ac)` the reader was told `H` and had four
      // of them to choose from [BB]. `offset` was computed here the whole time and no one rendered
      // it. Naming the text BEFORE the failure locates it without asking the reader to count
      // characters, and it rescues the EOF case, which said nothing about position at all.
      //
      // `raw` MUST be the string the parser actually saw. The call site parses `raw.trim()`, so an
      // offset taken against the untrimmed input is shifted by whatever leading whitespace was
      // typed — the context would then quote the wrong characters, which is worse than none.
      // Optional: called without it the headline is exactly what it was.
      message: headline(found, raw, offset),
    };
  }

  // The tail of what parsed, not the whole of it: a long query would push the actual character off
  // the line, and the useful part is the immediate neighbourhood of the break.
  const CONTEXT_CHARS = 18;
  // THE CHARACTER THE DIAGNOSIS IS ABOUT WAS THE ONE IT COULD NOT SHOW [BB 2026-08-11]. 43 of the 47
  // inputs that reach `nothing_fits` fail AT A SPACE, and the headline quoted it — `after "H3 "` —
  // where a space against a closing quote is barely a mark on the page. The body then said "close up
  // the whitespace" about something the reader had never been shown. Rendered visibly, the two halves
  // are about the same thing: `Unexpected "H" after "H3␣"`.
  //
  // Applied to `found` too, because the unexpected character can itself be whitespace, and
  // `unexpected " "` is that sentence with nothing in it.
  const showWs = (t) => String(t).replace(/[ \t]/g, '␣').replace(/[\n\r]/g, '⏎');
  function headline(found, raw, offset) {
    const what = found == null ? 'unexpected end of input' : 'unexpected "' + showWs(found) + '"';
    if (typeof raw !== 'string' || !offset) return what;
    const before = raw.slice(0, offset);
    if (!before.trim()) return what;
    const cut = before.length > CONTEXT_CHARS;
    return what + ' after "' + (cut ? '…' : '') + showWs(before.slice(-CONTEXT_CHARS)) + '"';
  }

  // ── The glyphs a sentence tells the reader to type come from the LABELS ───────────────────────
  // `nothing_fits` named `@` in prose while `groups.at` said `· or • or @` — one fact, written
  // twice, and the sentence was already the stale copy: two of the three spellings were missing.
  // So the catalogue writes `{at}` and this expands it from that group's own label [BB 2026-08-07].
  //
  // EXTRACTION IS OFF THE MARKUP, NOT THE PROSE. Splitting a label on its dash is the same
  // shape-reading mistake `expectCategory` already made once, and it breaks on the labels that have
  // no dash (`colon`) or a `<b>` mid-sentence (`name`). The catalogue's header defines `<b>` as
  // "around a character the reader can literally type", so the LEADING RUN of `<b>` spans is the
  // typeable part by construction — `<b>·</b> or <b>•</b> or <b>@</b>`, stopping at the gloss.
  //
  // An unknown key, or a label with no leading run, expands to nothing and leaves the marker
  // visible rather than silently dropping half a sentence — a card reading `join with {at}` is a
  // bug report, and `expandGlyphs.test` in soft-failure fails on it before a reader ever sees one.
  function glyphsOf(key) {
    const label = (SYNTAX_MSG.groups || {})[key];
    if (typeof label !== 'string') return null;
    const run = label.match(/^(?:<b>[^<]*<\/b>(?:\s+or\s+|\s+)?)+/);
    return run ? run[0].replace(/(?:\s+or\s+|\s+)$/, '') : null;
  }
  function expandGlyphs(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\{([a-z_]+)\}/g, (m, key) => glyphsOf(key) || m);
  }
  // The card's sentence, glyphs filled in. A function and not a constant because the catalogue is
  // resolved at module load and the page may re-render after it.
  const nothingFitsText = () => expandGlyphs(SYNTAX_MSG.nothing_fits || '');

  // EXPORTS ARE THE PAGE'S SCOPE, so each one is a name every other module can see and a promise
  // this module keeps. `isFillMember` and `extentBounds` left on 2026-08-06: both are used HERE and
  // nowhere else — not by another module, not by a suite, not by the R bridge (checked repo-wide,
  // because the last "no consumer" claim in this codebase was wrong: `glyph-universe`'s helpers look
  // unused and are loaded into V8 by init/create_measurements_v2.R).
  //
  // Un-exporting is not tidiness. An exported name is one a future caller can reach for instead of
  // asking whether it means what they need, which is how `materialsModel` came to have five suites
  // and no page.
  // ── THE PHYSICS / CHEMISTRY CARD ────────────────────────────────────────────────────────────────
  // `refusalReason`'s verdict → the three strings the units pane shows. Pure, so the wording is
  // testable without a DOM; the copy lives in copy/messages.yaml, keyed by the verdict's `kind`.
  //
  // WHAT THIS REPLACES. shell.js held two HTML literals and a ternary: `sub-complex` got its own
  // card and EVERYTHING ELSE got "Not a stable assembly — the parts are individually fine". For an
  // impossible mark both halves are false, and that is what the page said for `H3:K27Mme3` until
  // `refusalReason` learned to surface the chemistry verdict (2026-08-08).
  //
  // A PLACEHOLDER WITH NO VALUE TAKES ITS SENTENCE WITH IT. `allowed` is absent on some verdicts and
  // an empty carriable set is meaningful ("nothing can carry it"), so a sentence naming {allowed}
  // must not render as "Only  can." Any sentence still holding an unfilled placeholder after
  // substitution is dropped; if that empties the body, the head still stands on its own.
  function physicsError(why) {
    const G = (MSG && MSG.physics_error) || {};
    const kind = (why && why.kind) || 'fallback';
    const copy = G[kind] || G.fallback || {};
    const vals = Object.assign({}, why || {});
    if (Array.isArray(vals.allowed)) vals.allowed = vals.allowed.join(', ');
    if (Array.isArray(vals.modification)) vals.modification = vals.modification.join(' or ');
    if (Array.isArray(vals.residue)) vals.residue = vals.residue.join(' or ');
    if (vals.position === '-inf') vals.position = '\u03b1';
    if (vals.position === '+inf') vals.position = '\u03c9';

    return Object.assign({ kind }, fillCopy(copy, vals));
  }

  // Sentence-wise substitution, shared by both refusal cards. One missing value must cost its own
  // sentence and no more, so the split is on the period and a sentence still holding a placeholder
  // after substitution is dropped whole. NUL is the marker because no copy can contain one.
  function fillCopy(copy, vals) {
    const fill = (text) => {
      if (!text) return '';
      return String(text).trim().split(/(?<=\.)\s+/)
        .map((sent) => sent.replace(/\{(\w+)\}/g, (m, k) =>
          (vals[k] === undefined || vals[k] === null || vals[k] === '') ? '\u0000' : escExpect(vals[k])))
        .filter((sent) => sent.indexOf('\u0000') < 0)
        .join(' ');
    };
    return { head: fill(copy.head), body: fill(copy.body), hint: fill(copy.hint) };
  }

  // ── THE RESOLUTION CARD ──────────────────────────────────────────────────────────────────────────────
  // `resolve2`'s error node → the three strings the units pane shows, from `resolve_error` in
  // copy/messages.yaml. Same shape as physicsError and rendered into the same card, which is why it
  // is here rather than six HTML literals inside the branch that catches the error — where it lived
  // until 2026-08-11, two thousand lines into shell.js.
  //
  // ONE REASON, TWO KEYS. `position-variant-only` means opposite things depending on whether a frame
  // came with it: framed, a VARIANT token was written and its own numbering stops short; unframed,
  // the family reaches the position and this species does not. Telling a reader the second when the
  // first is true sends them changing species over a token problem.
  function resolveError(r, raw) {
    const G = (MSG && MSG.resolve_error) || {};
    const reason = (r && r.reason) || '';
    const key = reason === 'position-variant-only'
      ? (r.frame == null ? 'position-variant-only-species' : 'position-variant-only-variant')
      : (G[reason] ? reason : 'fallback');
    const copy = G[key] || G.fallback || {};
    const list = (r && r.variants) || [];
    const vals = Object.assign({}, r || {}, {
      // The raw query is the last resort, as it was in the branch this replaced: with neither an
      // accession nor a handle on the error there is still a string the reader typed, and naming it
      // beats dropping the sentence that names it.
      what: (r && (r.accession || r.handle)) || raw || '',
      // A FRAME KEY IS NOT ALWAYS NOTATION. It can name an EQUIVALENCE — `caH2A|H2A.1` — which the
      // reader never wrote and cannot type back; the old copy printed it raw as a headline.
      variant: r && r.frame ? String(r.frame).split('|').join(' or ') : '',
      // The mark carries its own position (`130ac`), so a sentence naming both stutters. This is the
      // mark with the leading residue-and-number stripped: `130ac` → `ac`, `K139M` → `M`.
      modification: r && r.mark ? String(r.mark).replace(/^[A-Za-z]?\d+/, '') : '',
      // `A` · `A and B` · `A, B and C`. Empty stays empty, so the sentence naming it drops.
      variants: list.length <= 1 ? (list[0] || '')
              : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1],
    });
    return Object.assign({ key }, fillCopy(copy, vals));
  }


  // ── BEAD CLOCKS ────────────────────────────────────────────────────────────────────────────────
  // Which position each bead's SMIL timeline should hold, and which one should be running.
  //
  // Every bead carries the whole animation; only playback differs. The selected bead runs, the rest
  // are PAUSED WHERE THEY STOOD, and one never selected sits at its `phase` — a hash of its identity
  // scaled across the cycle, so an array reads as an ensemble at rest.
  //
  // THE RULE THAT WAS GOT WRONG ONCE: what a bead resumes from is keyed on its SLOT, not on its
  // identity. The first version keyed on both, to stop a new query's slot 0 inheriting the previous
  // particle's position — but a bead's identity includes its MARKS, so switching world on one
  // assembly changed the key, missed, and restarted the bead at its new phase. That is the case the
  // mechanism exists for. A world switch is the same particle in the same slot; the caller drops the
  // saved clocks when the ANSWER changes, which is where that hazard actually lives.
  //
  // `saved` is slot → seconds. `phase` may be null (an atlas with no frames), which yields 0.
  function beadClockPlan(beads, saved, selected) {
    const at = (saved && typeof saved.get === 'function') ? saved : new Map();
    return (beads || []).map((b) => {
      const carried = at.get(String(b.slot));
      const phase = Number(b.phase);
      return {
        slot: String(b.slot),
        time: (carried != null && isFinite(carried)) ? carried : (isFinite(phase) ? phase : 0),
        running: String(b.slot) === String(selected),
      };
    });
  }

  const api = { beadClockPlan, meetBench, materialsFromCanon, humanizeExpected, groupExpected, syntaxError, modSub,
                extentExcludes, expandGlyphs, nothingFitsText, physicsError, resolveError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/world-view-model.js
// Pure, DOM-free view-model for a concrete world IR (finish-line rebuild step 2,
// specs/2026-07-24-measurements-middle-layer.md). worldView(worldIR) turns ONE meet-derived world IR
// (interpret3().worlds[i] — native-completed, faithful, positions ARE columns) into the grouped materials the shell renders,
// so the world model comes straight from the IR and is never re-derived from the lossy arrangement
// string. Node-require-able and browser-global, same convention as the other *-model.js files.
(function (root) {
  'use strict';

  var FAMS = ['H3', 'H4', 'H2A', 'H2B'];   // canonical display order

  // A concrete variant, or null for a genuine disjunction. NOT "singleton = concrete": since the
  // variant axis became a tree (2026-07-28) a clade token lifts to its whole subtree, so `caH3` is a
  // four-element set that nonetheless names one thing. variantToken2 contracts it; it still returns
  // null for `H3.1|H3.3` and for a complement, which are the cases a single label would misstate.
  function normVariant(v, family) {
    if (!Array.isArray(v)) return v || null;
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (P && P.variantToken2) return P.variantToken2(family, v);
    return v.length === 1 ? v[0] : null;
  }

  // The positive marks of a proteoform, normalised + sorted (position, then token) so identical copies
  // hash the same regardless of stated order.
  function normMods(pf) {
    return (pf.modifications || [])
      .filter(function (m) { return !m.negated && (m.substitution || m.modification); })
      .map(function (m) {
        return { position: m.position, residue: m.residue || null,
                 substitution: m.substitution || null, modification: m.modification || null };
      })
      .sort(function (a, b) {
        return (a.position - b.position) ||
          String(a.substitution || a.modification).localeCompare(String(b.substitution || b.modification));
      });
  }

  // Identity of a copy for grouping. ASK THE IR: `pfCanonKey` is the engine's own identity for a
  // proteoform and carries every axis, including SEGMENTS — and it is count-blind, which is exactly
  // what a grouping key must be here, since identical copies collapse to count > 1.
  //
  // The hand-built key below omitted segments, so `([H3[1-30]]@[H3[40-60]])` — two peptides —
  // grouped into ONE card of two copies, and `H3[1-10]` carried no extent onto the card at all.
  // That is the same defect that was fixed in shell-model.js's `materialsFromCanon`, one layer over;
  // fixing only that one was fixing the model the default view does not use.
  //
  // The fallback keeps this module working with no engine loaded, and includes a segment signature
  // so it is wrong in fewer ways than what it replaces.
    // ⊤ IS NOT "NO ANSWER" [BB 2026-08-24].
  //
  // `accession` is null when the surviving set equals the family universe, because a set equal to
  // the universe IS ⊤ and a copy publishing it as an explicit set had its worlds rejected by their
  // own gate. That rule is right and stays. But ⊤ on the IDENTITY axis does not mean the walk said
  // nothing: `H3:K27M` in human context leaves all nine H3s standing — CENP-A only conditionally,
  // on a soft wild-type mismatch — so the identity is unconstrained while eight molecules SATISFY
  // the mark and one does not.
  //
  // A display reading `accession` alone sees null and names nothing, so it reads the verdicts, which
  // travel with the copy for exactly this reason. This is a DISPLAY-side derivation and it never
  // replaces `accession`: the engine keeps saying ⊤. Null when there is nothing to add — no
  // verdicts, or every molecule satisfies, which is the genuinely unconstrained case.
  //
  // EXPORTED because the port card needs the same answer, and two derivations of "which molecules"
  // is the second opinion this pipeline exists to abolish.
  //
  // `materialize-card.js` IS NOT THAT SECOND OPINION, though it looks like one. It derives its own
  // set as NOT-ELIMINATED — satisfies plus conditional, 9 against this function's 8 for `H3:K27M` —
  // and the divergence is intended [BB 2026-08-24]. This function answers "which molecules DO carry
  // it"; the card answers "which molecules could this query be about", because a card exists so a
  // reader can see their query is possible, and dropping the conditional ones would quietly turn a
  // misspecified query into a plausible one. Two derivations of two questions.
  //
  // Visible since 2026-08-24, when re-running the H3 alignment with Cse4 and X. laevis CENP-A moved
  // human CENP-A from ELIMINATED at H3's K27 column to CONDITIONAL. Nothing in the engine changed;
  // a hole in the data had been doing this check's work.
  // NOTHING SATISFIES IS AN ANSWER, AND IT SAYS SO [BB 2026-08-24]. The guard read
  // `s.length && s.length < keys.length`, which is falsy at BOTH ends — so a proteoform where
  // every candidate is merely CONDITIONAL returned exactly what a genuinely unconstrained one
  // returns, and the card fell back to `accession`, which is null there. The one case with the
  // most to say was the one that said nothing.
  //
  // So the return has three shapes and they are three different facts:
  //   null  — nothing to add: no verdicts at all, or every molecule satisfies (⊤ is already right)
  //   []    — nothing satisfies: every survivor is conditional, and that is worth printing
  //   [...] — these and not the others
  // A consumer must therefore test for null, not for emptiness: `satisfiers || accession` reaches
  // `[]` correctly because an empty array is truthy, and `satisfiers.length ? … : …` would silently
  // put the two ends back together again.
  function satisfiersOf(pf) {
    if (!pf || !pf.verdicts) return null;
    var keys = Object.keys(pf.verdicts);
    if (!keys.length) return null;
    var s = keys.filter(function (a) { return pf.verdicts[a] === 'satisfies'; });
    if (s.length === keys.length) return null;
    return s.slice().sort();
  }

  function identity(pf) {
    var variant = normVariant(pf.variant, pf.family);
    // The card is labelled with the TOKEN, so the number must be in the token's numbering — a token
    // covers molecules that need not agree on a site's number (see the H2A column 132 note below).
    // One implementation, in the engine (emit2).
    //
    // A pinned `H2B1A:K121ub` prints as `H2B.1:121ub` and that is the rule working, not escaping it:
    // since 2026-08-24 H2B.1 holds only the two TSH2B, which number that site 121. It printed 120
    // while two bulk H2B sat in the token and supplied its print reference.
    var P0 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    var mods = (P0 && P0.renumberForToken)
      ? P0.renumberForToken(pf, variant || pf.family, normMods(pf))
      : normMods(pf);
    // NOT FILTERED to "stated extent only". A whole-chain segment carries no extent information, but
    // it does carry the query's CERTAINTY, and the grid band is the one place that is worth drawing:
    // a dotted rule across the full length says "full-length, native", which is true and is what a
    // reader expects to see. Everything that must react only to a STATED extent — the head badge, the
    // extent-restricted mass, the dimming — already tests for a whole chain itself and ignores it.
    var segs = (pf.segments || []).slice();
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    var key = (P && typeof P.pfCanonKey === 'function')
      ? P.pfCanonKey(pf)
      : pf.family + '|' + (variant || '') + '|' +
        mods.map(function (m) { return m.position + (m.substitution || m.modification || ''); }).join(',') +
        '|' + segs.map(function (x) { return x.start + '-' + x.end + ':' + x.certainty; }).join(',');
    // THE ACCESSION SET TRAVELS WITH THE MATERIAL. `pfCanonKey` already distinguishes two members
    // that name different molecules, so the GROUPING was right — but the group dropped the set, so a
    // consumer could see two H3 rows and not know which molecules each stood for.
    //
    // Under `interpret2` this is always null, so carrying it changes nothing today. Under
    // `interpret3` it is the material's own answer to "which molecules", and it is what the sequence
    // grid needs: a mark's own-numbering is `ownAtCol(accession, column)` and is only well-defined
    // PER MOLECULE. Measured 2026-08-04: at column 132 the seventeen H2A that survive `K119ub` number
    // it 117, 119 or 121 — there is no single "the" material position for a member to carry.
    return { family: pf.family, variant: variant, mods: mods, key: key,
             accession: Array.isArray(pf.accession) && pf.accession.length ? pf.accession.slice() : null,
             satisfiers: satisfiersOf(pf),
             anchor: pf.anchor || null,        // whose numbering this material's numbers are in
             // THE WALK'S ANSWER TRAVELS WITH THE COPY. Same reason as `anchor` and `accession`
             // above: a consumer that receives only the accession list has to re-derive why the
             // others are missing, and re-deriving it is what the material card was doing when it
             // ran a second materialization on numbers it had already corrupted. `displayAnchor` is
             // the frame the copy's numbers are PRINTED in (null = no counterpart, so no number).
             displayAnchor: pf.displayAnchor || null,
             verdicts: pf.verdicts || null,
             reasons: pf.reasons || null,
             warnings: pf.warnings || null,
             segments: segs.length ? segs.map(function (x) { return Object.assign({}, x); }) : null,
             certainty: segs.length ? (segs.every(function (x) { return x.certainty === 'defined'; }) ? 'defined' : 'native') : null };
  }

  // All proteoform copies of a node, descending into pin sub-assemblies (co-brackets) so a pinned
  // family still contributes its copies.
  //
  // A node that IS a proteoform is its own single copy. That case only arises away from the world
  // path — a world is always an assembly — but it is what lets this same function serve a bare
  // query: `[H3@H4]` and `{H2A@H2B}` already worked (an assembly is an assembly, DNA or not),
  // while a lone `H3:K27M` returned nothing at all. One line, and the DNA-free particles stop
  // needing a path of their own.
  // A WORLD IS EXPLICIT, so this is a plain walk — one entry per copy, no arithmetic. It briefly
  // carried a `copyMultiplier` to decompress a compressed world, because `singleWorld` used to return
  // the AUTHORED node and an authored node writes `{H3@H4}2` for four molecules. `interpret2`
  // expands it now, so every world's copies are members and every count is 1, and the multiplier
  // this walk needed is gone with the thing it compensated for [BB 2026-08-05: "I wonder why
  // worldViewModel is not a simple walk along the IR emitted from materialize3 by array-slot?"].
  //
  // A node that IS a proteoform is its own single copy. That case only arises away from the world
  // path — a world is always an assembly — but it is what lets this same function serve a bare
  // query: `[H3@H4]` and `{H2A@H2B}` already worked (an assembly is an assembly, DNA or not),
  // while a lone `H3:K27M` returned nothing at all.
  //
  // `count` on a copy is still READ rather than assumed to be 1: this function also serves query
  // nodes, which do compress, and one there means what it has always meant.
  // Each proteoform WITH THE COPIES IT STANDS FOR (BB, 2026-08-06). The walk descended into nested
  // assemblies and dropped their counts, so `{H3@H4}2` — the tetramer — listed one H3 and one H4.
  // The header above already records that this file "also serves query nodes"; a world has explicit
  // copies and every count 1, so the loss only showed on the query path, which is exactly why it
  // survived. `copyMultiplier` is the engine's rule, root exemption included.
  function proteoforms(node, carried, root) {
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    var mult = function (n, isRoot) {
      return (P && typeof P.copyMultiplier === 'function') ? P.copyMultiplier(n, isRoot)
           : (isRoot && n && n.dna != null ? 1 : (n && n.count == null ? 1 : n.count));
    };
    carried = carried == null ? 1 : carried;
    if (node && node.node === 'proteoform') return [{ pf: node, copies: carried }];
    var here = carried * ((root === false) ? 1 : mult(node, true));
    var out = [];
    (node && node.members || []).forEach(function (m) {
      if (m.node === 'proteoform') out.push({ pf: m, copies: here });
      else if (m.node === 'assembly') out = out.concat(proteoforms(m, here * mult(m, false), false));
    });
    return out;
  }

  // worldView(worldIR) → { materials: [{ family, variant, mods, count, key }] }, one entry per DISTINCT
  // copy identity with its copy count (identical copies collapse to count>1; distinct variants/marks stay
  // separate). Ordered by canonical family, then variant, then mark count — a stable, readable layout.
  function worldView(worldIR) {
    var byKey = new Map();
    proteoforms(worldIR).forEach(function (entry) {
      var pf = entry.pf;
      var id = identity(pf);
      if (!byKey.has(id.key)) byKey.set(id.key, { family: id.family, variant: id.variant, mods: id.mods,
                                                  segments: id.segments, certainty: id.certainty,
                                                  accession: id.accession, satisfiers: id.satisfiers,
                                                  anchor: id.anchor,
                                                  displayAnchor: id.displayAnchor,
                                                  verdicts: id.verdicts, reasons: id.reasons,
                                                  warnings: id.warnings,
                                                  count: 0, key: id.key });
      byKey.get(id.key).count += (pf.count == null ? 1 : pf.count) * entry.copies;
    });
    var groups = Array.from(byKey.values());
    groups.sort(function (a, b) {
      var fa = FAMS.indexOf(a.family), fb = FAMS.indexOf(b.family);
      if (fa !== fb) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb);
      var va = a.variant || '', vb = b.variant || '';
      if (va !== vb) return va < vb ? -1 : 1;
      return a.mods.length - b.mods.length;   // wild-type (0 marks) before marked
    });
    return { materials: groups };
  }

  var api = { worldView, normVariant, satisfiersOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/glyph-universe.js
// The FIXED glyph universe G — the "configuration" tier of the finish-line rebuild
// (specs/2026-07-24-measurements-middle-layer.md). A glyph is an ARRANGEMENT abstraction of a
// nucleosomal particle: each of the 8 core copies is `plain | special | absent`, where **special**
// collapses decorated-or-variant (one symbol, per BB — revisable by splitting the state later). The
// content axis (which specific mark / which variant) is NOT here — it is the SQL mark-coordinate
// pre-filter. G is the shared universe that both a query Q and a datum D abstract into; relevance is
// glyph-set overlap: `C = mask(Q)`, and D attaches to `C ∩ mask(D)`. Because G is fixed, mask(D) is
// precomputable at ingestion (a bitmask) and query time is a set/bitwise intersection.
//
// Structure + symmetry:
//   - H3, H4 are the always-present tetramer core (never `absent`).
//   - H2A, H2B come in per-face dimers: on each face both are present or both absent (0/1/2 dimers =
//     tetrasome / hexasome / octamer).
//   - Folded by the dyad flip (swap the two faces), which is why `glyphKey` takes the smaller of the
//     two face orders and why `specUpSet` counts across faces instead of assigning them.
//
// ABSTRACTION READS THE IR, NOT A STRING — and the header said the opposite until 2026-08-05.
//
// It used to describe the input as an enumerator's octamer key string (`H3seg|H4seg|H2Aseg|H2Bseg`,
// each copy `∅` absent / `''` plain / anything-else special) and to name `interpret2`'s canonical
// collapse as the authority for the dyad fold. Both are gone: `interpret2` was deleted on 2026-08-05,
// and the string reading was abandoned before that. `isContentful` reads `variant` and
// `modifications` as FIELDS, and the comment on it records what the string cost — an extent read as
// a mark, an accession read as a mark, and a repair that then desynchronised the query side from the
// world side, three bugs in one day. `stateSig` packs metadata behind control prefixes (\x1f variant,
// \x1e extent, \x1d accession, \x1c identity), so every string consumer had to know that convention.
// The IR does not need decoding. A header describing the abandoned interface is worse than no header:
// it teaches the convention the code stopped depending on.
//
// TWO SHAPES ARRIVE, and `facesOfWorld` handles both: a face-stamped WORLD from the enumerator, and a
// DATUM's own IR, which is not face-structured. See its comment for the fill-order fallback and its
// limit.
(function (root) {
  'use strict';

  var FAMS = ['H3', 'H4', 'H2A', 'H2B'];
  // (H2A,H2B) per face: both absent (no dimer) or both present (each plain/special).
  var DIMER = [['A', 'A'], ['P', 'P'], ['P', 'S'], ['S', 'P'], ['S', 'S']];
  var CORE = ['P', 'S'];   // H3 / H4 per copy — always present

  function faceKey(f) { return f.H3 + f.H4 + f.H2A + f.H2B; }               // 4-char face code
  // Canonical glyph key = the two face codes joined, ordered by the dyad flip (min of the two orders).
  function glyphKey(fa, fb) { var a = faceKey(fa) + '|' + faceKey(fb), b = faceKey(fb) + '|' + faceKey(fa); return a < b ? a : b; }

  // Enumerate every valid face-state (H3,H4 ∈ {P,S}; the H2A/H2B dimer ∈ DIMER) → 2·2·5 = 20.
  function faces() {
    var out = [];
    CORE.forEach(function (h3) { CORE.forEach(function (h4) { DIMER.forEach(function (d) {
      out.push({ H3: h3, H4: h4, H2A: d[0], H2B: d[1] });
    }); }); });
    return out;
  }

  // G: all face×face pairs, dyad-folded + deduped, stably indexed (index = bit position).
  function enumerateGlyphs() {
    var fs = faces(), seen = {}, list = [];
    fs.forEach(function (fa) { fs.forEach(function (fb) { var k = glyphKey(fa, fb); if (!seen[k]) { seen[k] = 1; list.push(k); } }); });
    list.sort();
    var index = {}; list.forEach(function (k, i) { index[k] = i; });
    return { glyphs: list, index: index };
  }

  // A COPY IS 'S' BECAUSE IT CARRIES CONTENT, read off the IR (2026-08-04).
  //
  // `stateSig` puts METADATA in the same comma-joined string as the marks, each behind a control
  // prefix: \x1f a variant, \x1e an extent, \x1d an accession, \x1c an identity. Testing the whole
  // string for emptiness read every one of those as a mark. `(H3.1)` — an unmarked query that merely
  // NAMES a variant — abstracted to S on both copies and attached to measurements as though the
  // histones were modified. Same class as the point-glyph failure that dropped 83 measurements: a
  // claim the query never made.
  //
  // Mark keys are built from residue/position/modification and never begin with a control character,
  // so the test is on the first byte and needs no coordination with stateSig beyond that.
  // ── ONE PREDICATE FOR "DOES THIS COPY CARRY CONTENT" ────────────────────────────────────────
  // Read off the IR, where `variant` and `modifications` are FIELDS. This replaces three separate
  // reconstructions of the same question from the arrangement STRING — `absState`, the inline `st()`
  // in `constraintFromArrangement`, and `specFromIR`'s own copy — which produced three bugs in one
  // day (2026-08-04): an extent read as a mark, an accession read as a mark, and a repair that then
  // made a variant-only copy plain and desynchronised the query side from the world side.
  //
  // A string built by `stateSig` was never a stable interface: it carries metadata behind control
  // prefixes (\x1f variant, \x1e extent, \x1d accession, \x1c identity), and every consumer had to
  // know that convention. The IR does not need decoding.
  //
  // CONTENT = a variant, or a non-negated substantive mark. A variant counts because
  // variant-specificity IS content — the frozen-ish claim in the suite says so, and relevance
  // compares a query's spec against a datum's glyph, so the two sides must not differ on it.
  function isContentful(pf) {
    if (!pf) return false;
    if (pf.variant != null) return true;
    return (pf.modifications || []).some(function (m) {
      return m && !m.negated && (m.substitution || m.modification);
    });
  }

  // The two half-octamers of a world, as {H3,H4,H2A,H2B} → 'A' | 'P' | 'S'.
  // Each member carries its own `face` (the enumerator's `worldIR` stamps it). Splitting the member list
  // down the middle instead is WRONG for any sub-octamer: a hexasome presents 2 copies on one face
  // and 4 on the other.
  // TWO SHAPES ARRIVE HERE and both are legitimate:
  //   a WORLD from `interpret3` — face-structured, every member stamped with its `face`;
  //   a DATUM's own IR — not face-structured, and `count` may be 2 for a homotypic pair.
  // A datum cannot be run through the enumerator to face-structure it: full world enumeration OOMs on
  // combinatorial screens (5 acetyls × 2 copies × 4 families), which is why ingestion computes the
  // mask directly. So the fill order is the fallback: first copy of a family → face 0, second →
  // face 1. For a homotypic or single-heterotypic particle that is exact, and screens are homotypic.
  // THE ENCLOSING COUNT IS A COPY COUNT (BB, 2026-08-06). Both walks below read a proteoform's OWN
  // `count` and recursed into `members` with nothing threaded through, so every enclosing repetition
  // was dropped: `([H3:K27M@H4]2@H2A@H2B)` — an octamer written with an explicit tetramer, which is
  // the example `grammar/stoichiometry.js` exists for — came out with one H3 and one H4 and
  // therefore read as a HEXASOME on the glyph axis, while `classify2` called it a nucleosome and
  // `compositionCounts` said 2/2/2/2. One object, two compositions, on the axis relevance is decided.
  //
  // `copyMultiplier` is the engine's own rule and is what `familyCounts`, `interpret2.explicit` and
  // `meet2` all use — including the part that is not obvious: a PARTICLE's own count is repetition
  // along DNA, not extra copies, so a nucleosome written `(…)3` still has exactly two faces.
  function mult(n, isRoot) {
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.copyMultiplier !== 'function')
      throw new Error('glyph-universe: copyMultiplier unavailable — load build/parser2.js first');
    return P.copyMultiplier(n, isRoot);
  }

  function facesOfWorld(node) {
    var f = [{ H3: 'A', H4: 'A', H2A: 'A', H2B: 'A' }, { H3: 'A', H4: 'A', H2A: 'A', H2B: 'A' }];
    var next = { H3: 0, H4: 0, H2A: 0, H2B: 0 };
    (function walk(n, carried, root) {
      if (!n || typeof n !== 'object') return;
      var k = mult(n, root);
      if (n.node === 'proteoform') {
        if (!(n.family in next)) return;
        var st = isContentful(n) ? 'S' : 'P';
        var count = k * carried;
        if (count <= 0) return;
        for (var i = 0; i < count; i++) {
          // A world stamps `face` as the COPY NUMBER, 1 or 2 (grammar/interpret2.js worldIR), and
          // everything below this line is a 0-based index into `f` — so it is converted here rather
          // than letting one number try to be both, which is the bug the stamp change was fixing.
          var face = (n.face === 1 || n.face === 2) ? n.face - 1 : next[n.family];
          if (face > 1) break;
          f[face][n.family] = st;
          next[n.family] = face + 1;
        }
        return;
      }
      (n.members || []).forEach(function (m) { walk(m, carried * k, false); });
    })(node, 1, true);
    return f;
  }

  // world IR → canonical glyph key, re-folded by the dyad.
  function glyphOf(world) { var f = facesOfWorld(world); return glyphKey(f[0], f[1]); }

  // A set of WORLD IRs (`interpret3(X).worlds`) → the sorted, unique glyph indices they occupy in G.
  // This is the glyph mask of X (as an index list; trivially packable to bits over |G|).
  // NO PRODUCTION CALLER: ingestion computes a datum's mask in R (`glyphMaskFor`, which walks the
  // datum's own IR because enumerating its worlds OOMs) and the page intersects the stored masks.
  // Kept as the browser-side statement of the same operation, and exercised by the suite as the
  // vocabulary its relevance claims are written in. `worlds` is complete
  // whenever the draw is: the accepted-world limit (200) is below WORLD_IR_CAP (256), so the IR list
  // never truncates relative to `octamers`.
  function glyphMask(worlds, index) {
    var seen = {}, out = [];
    (worlds || []).forEach(function (k) {
      var gi = index[glyphOf(k)];
      if (gi != null && !seen[gi]) { seen[gi] = 1; out.push(gi); }
    });
    return out.sort(function (a, b) { return a - b; });
  }

  // ── UP-SETS: what a description actually constrains ─────────────────────────────────────────────
  // A description is NOT a point in G. `glyphOf` maps an unmarked copy to `P`, and `P` is a CLAIM —
  // "this copy carries no mark". A query that never mentions H3 makes no such claim, so pinning it to
  // P made `(H4:K16ac)` unable to reach an H4K16ac datum that also carried H3K27me3 (the Phase-3
  // oracle's 83 dropped measurements — specs/2026-07-24-glyph-relevance-oracle.md).
  //
  // A description therefore abstracts to a CONSTRAINT — per copy, one of:
  //     'S'  the copy carries a mark or variant   (stated)
  //     'A'  the copy is absent                   (stated)
  //     '*'  nothing is claimed                   (free over {P,S} — present, but unconstrained)
  // and its glyph mask is the UP-SET: every glyph in G that satisfies the constraint. Relevance stays
  // `mask(Q) ∩ mask(D) ≠ ∅` — one set intersection over a 210-element universe — but it is now the
  // meet on the shape axis rather than an accidental approximation of it.
  //
  // Note there is no 'P' in a constraint. "Carries no mark" is not something either side asserts under
  // the compatible/discovery reading (v1's `foreground()` opens every datum for exactly this reason);
  // it is a property of a concrete world, which is what G's members are.
  var FREE = { P: 1, S: 1 };                              // what '*' admits — presence, either state

  // A concrete glyph index → the constraint it imposes when read as a DESCRIPTION under the compatible
  // reading: its S/A slots are claims, its P slots are not. This is how a datum's stored point mask
  // (init/create_measurements_v2.R) opens up at query time, with no re-ingestion: the parquet keeps
  // the precise shape and the mode decides how much of it binds.
  function constraintFromGlyph(glyphKeyStr) {
    return String(glyphKeyStr).split('|').map(function (fk) {
      return fk.split('').map(function (c) { return c === 'P' ? '*' : c; }).join('');
    });
  }

  // A DATUM'S CONSTRAINT, from its world IR. An unmarked present copy is '*', NOT 'P': P is a CLAIM
  // ("carries no mark") that a datum silent about a family has not made. Absent stays 'A'.
  // Its inline `st()` used to call any non-empty signature 'S', so an extent or an accession made a
  // copy special — the same defect absState had, in a second copy of the same question.
  function constraintFromWorld(world) {
    var f = facesOfWorld(world);
    var code = function (x) {
      return FAMS.map(function (fam) { return x[fam] === 'A' ? 'A' : (x[fam] === 'S' ? 'S' : '*'); }).join('');
    };
    return [code(f[0]), code(f[1])];
  }

  // Does a concrete glyph satisfy a constraint? Both are dyad-folded, so try either face pairing.
  function satisfies(glyphKeyStr, constraint) {
    var g = String(glyphKeyStr).split('|');
    var fit = function (face, con) {
      for (var i = 0; i < 4; i++) {
        if (con[i] === '*') { if (!FREE[face[i]]) return false; }
        else if (con[i] !== face[i]) return false;
      }
      return true;
    };
    return (fit(g[0], constraint[0]) && fit(g[1], constraint[1]))
        || (fit(g[0], constraint[1]) && fit(g[1], constraint[0]));
  }

  // The up-set of a constraint: every glyph in G that satisfies it, as sorted indices. G has 210
  // members, so the honest linear scan costs nothing and needs no clever set algebra to get right.
  function upSet(constraint, universe) {
    var u = universe || enumerateGlyphs();
    var out = [];
    u.glyphs.forEach(function (k, i) { if (satisfies(k, constraint)) out.push(i); });
    return out;
  }

  // The query's constraint read STRAIGHT OFF ITS IR, with no world enumeration in between.
  //
  // WHY: taking the query's glyph set as the union over its enumerated worlds ties RELEVANCE to
  // ENUMERATION, and enumeration must be capped — it is exponential in the mark count (a ten-mark query
  // is ~2,000 worlds and ~55s of `entails2`). A cap on that union would silently narrow the relevance
  // set, which is exactly the display-cap bug that once cost real measurements. Read off the IR this is
  // O(families) and independent of how many worlds we choose to draw.
  //
  // The spec is PER FAMILY and COUNT-BASED, not a positional face pattern:
  //     { H3: {s, a}, … }   s = how many copies definitely carry something, a = how many are absent
  // A positional pattern cannot express this. `(H3:K27M@H4:K16ac)` marks one H3 copy and one H4 copy,
  // but they need not be on the SAME face — and `satisfies` only tries a global face swap, so writing
  // both marks into face 0 silently lost the 16 mixed-face glyphs. Counting per family is exactly the
  // dyad-invariance the glyph universe already has.
  //
  // `s` is a LOWER bound (a fill copy may independently carry a mark), `a` is EXACT (a query stating one
  // absent dimer denotes a hexasome — neither an octamer nor a tetrasome). A copy is pinned to 'S' only
  // where the query STATES a mark, never to 'P', so the result still over-approximates.
  //
  // ABSENCE IS A SHORTFALL, not a `count: 0` node. lift2/resolve2 complete a particle to its full
  // complement and express a `0` subscript by REMOVING the copy, so a family with one present copy in a
  // completed particle is a family with one absent copy. Reading absence off `count === 0` finds
  // nothing and silently makes every sub-octamer query look like an octamer.
  function specFromIR(node) {
    var present = { H3: 0, H4: 0, H2A: 0, H2B: 0 };
    var spec = { H3: { s: 0, a: 0 }, H4: { s: 0, a: 0 }, H2A: { s: 0, a: 0 }, H2B: { s: 0, a: 0 } };
    (function walk(n, carried, root) {
      if (!n || typeof n !== 'object') return;
      var k = mult(n, root);
      if (n.node === 'proteoform') {
        var e = spec[n.family];
        if (!e) return;
        var count = k * carried;                // …and the SAME multiplier the world side uses
        if (count <= 0) return;
        present[n.family] += count;
        if (isContentful(n)) e.s += count;      // the SAME predicate the world side uses
        return;
      }
      (n.members || []).forEach(function (m) { walk(m, carried * k, false); });
    })(node, 1, true);
    FAMS.forEach(function (f) {
      spec[f].a = Math.max(0, 2 - present[f]);
      if (spec[f].s > 2) spec[f].s = 2;
    });
    return spec;
  }

  // Every glyph satisfying a per-family spec. Counts S and A across the two faces, so it is dyad-
  // invariant by construction rather than by trying face orders.
  function specUpSet(spec, universe) {
    var u = universe || enumerateGlyphs();
    var out = [];
    u.glyphs.forEach(function (k, gi) {
      var faces = k.split('|');
      for (var i = 0; i < FAMS.length; i++) {
        var want = spec[FAMS[i]] || { s: 0, a: 0 }, nS = 0, nA = 0;
        for (var f = 0; f < 2; f++) {
          if (faces[f][i] === 'S') nS++;
          else if (faces[f][i] === 'A') nA++;
        }
        if (nS < want.s || nA !== want.a) return;
      }
      out.push(gi);
    });
    return out;
  }

  function irUpSet(node, universe) { return specUpSet(specFromIR(node), universe); }

  // The two callers' shorthands. `worldUpSet` is the QUERY side (per enumerated world);
  // `glyphUpSet` is the DATUM side (opening its stored point mask).
  function worldUpSet(world, universe) { return upSet(constraintFromWorld(world), universe); }
  function glyphUpSet(glyphIndices, universe) {
    var u = universe || enumerateGlyphs(), seen = {}, out = [];
    (glyphIndices || []).forEach(function (gi) {
      if (u.glyphs[gi] == null) return;
      upSet(constraintFromGlyph(u.glyphs[gi]), u).forEach(function (j) { if (!seen[j]) { seen[j] = 1; out.push(j); } });
    });
    return out.sort(function (a, b) { return a - b; });
  }

  // Composition class of a glyph key: dimers present across the two faces → octamer/hexasome/tetrasome.
  function composition(glyphKeyStr) {
    var fp = String(glyphKeyStr).split('|');
    var dimers = fp.reduce(function (n, fk) { return n + (fk[2] !== 'A' ? 1 : 0); }, 0);   // H2A slot present?
    // the particle series is named for being on DNA; 'octamer' is the DNA-free eight (BB 2026-07-26)
    return dimers === 2 ? 'nucleosome' : dimers === 1 ? 'hexasome' : 'tetrasome';
  }

  // `isContentful` and `faceKey` are NOT exported (2026-08-05): both are used only inside this file —
  // `isContentful` by `facesOfWorld` and `specFromIR`, `faceKey` by `glyphKey` — and exporting them
  // advertised a contract nobody had signed. `facesOfWorld` and `glyphKey` stay exported because
  // `init/create_measurements_v2.R` loads this file into V8 and calls them: the ingester is a
  // consumer that lives outside both the page and the suites, and a sweep scoped to those two would
  // not see it.
  var api = { enumerateGlyphs, glyphOf, facesOfWorld, glyphMask, composition, glyphKey,
              constraintFromGlyph, constraintFromWorld, worldUpSet, specFromIR, specUpSet, satisfies, upSet,
               glyphUpSet, irUpSet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/measurements-model.js
// Pure: coords a tile's world asserts. A copy is modified iff its signature is
// non-empty (RC4: "" = wild-type, any signature string = a proteoform). A family
// with any modified copy asserts that family's query mods (the union present in
// the octamer). Feeds filterEntailedRows for per-tile measurement relevance.
(function (root) {
  'use strict';
  function tileMods(world, materials) {
    const byFam = {};
    (materials || []).forEach(m => { byFam[m.family] = m.mods || []; });
    const out = [];
    Object.keys(world || {}).forEach(fam => {
      if (!(world[fam] || []).some(c => c !== '')) return;    // no modified copy → asserts nothing
      (byFam[fam] || []).forEach(md => {
        out.push({ family: fam, position: md.position, mod_value: md.variant != null ? md.variant : (md.modification != null ? md.modification : null) });
      });
    });
    return out;
  }
  // Bucket measurement groups into assay-type SECTIONS, ordered by assay_type_order,
  // splitting each into native (⣿) vs exact (●). Empty sections dropped; an unmapped type
  // (order Infinity) sorts last, then alphabetically. Pure — the caller attaches
  // { certainty, assayType:{token,label,order} } to each group. (data/SCHEMA.md §1;
  // specs/2026-07-18-measurement-panel-assay-type-design.md.)
  function groupMeasurementsByType(groups) {
    var byToken = new Map();
    (groups || []).forEach(function (g) {
      var at = g.assayType || { token: 'other', label: 'Other', order: Infinity };
      if (!byToken.has(at.token))
        byToken.set(at.token, { token: at.token, label: at.label, order: at.order, native: [], exact: [] });
      var sec = byToken.get(at.token);
      (g.certainty === 'native' ? sec.native : sec.exact).push(g);
    });
    return Array.from(byToken.values())
      .filter(function (s) { return s.native.length || s.exact.length; })
      .sort(function (a, b) {
        return (a.order - b.order) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
      });
  }


  // ── THE COLUMN PREFILTER ────────────────────────────────────────────────────────────────────
  // A measurement and a query meet on the ALIGNMENT COLUMN, and both sides already speak it:
  // `materialize3` puts a mark's column on the member, and ingestion writes `aln_column` on the
  // lookup row by joining the same `alignment_columns` table `colAt` reads. Verified 2026-08-04:
  // H3 K27 is column 258 on both sides, H2A S139 is 177 on both. (258, not the 222 this said
  // until 2026-08-24: the H3 alignment was rebuilt when Cse4 and X. laevis CENP-A were admitted,
  // which moved the column. The tests were updated and the prose was not — the number is the
  // evidence for the claim above it, so a stale one is a stale claim.)
  //
  // So the mark axis is an INTEGER COMPARISON. Today it is reconstructed per row — the datum's
  // deposited notation is re-parsed, lifted, resolved, and both operands are columnized at
  // comparison time — which is the on-the-fly translation materialize-before-enumerate exists to
  // abolish, done 200,000 times.
  //
  // THE ACCESSION NEVER SUBTRACTS [BB 2026-08-04]. A query in one organism must reach data measured
  // in another: the match is idea-layer and the organism is DISPLAYED, not filtered on. It is
  // labelled instead — `sameMolecule` says whether this datum sits on one of the very molecules the
  // world names. Measured: of 1,614 single-particle rows carrying a column, 19 are non-human, and
  // those 19 are exactly the cross-species data the idea layer exists to reach. Gating on accession
  // would drop nothing statistically and everything argumentatively.
  //
  // AND IT IS A PREFILTER, SO IT MAY ONLY OVER-APPROXIMATE. It gates on POSITION alone; whether the
  // mark VALUE agrees, and everything a number cannot settle — negation, extents, certainty, counts
  // — stays with `entails2`, which remains the definition. The prefilter's one obligation is never
  // to drop what the meet would keep.
  //
  // ROWS OUTSIDE THE ALIGNMENT ARE RETURNED, NOT DROPPED. 42,503 of 208,714 lookup rows carry no
  // `aln_column` (materials, arrays, terminal marks) and this gate cannot speak about them. They
  // come back in `unplaceable` so a caller must decide explicitly. Silently dropping them would make
  // the prefilter a cap on relevance, which is the failure the glyph path already carries a warning
  // about.
  function queryColumns(node) {
    var cols = [];
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.node === 'proteoform') {
        (n.modifications || []).forEach(function (m) {
          if (m && !m.negated && typeof m.position === 'number' && cols.indexOf(m.position) < 0) cols.push(m.position);
        });
        return;
      }
      (n.members || []).forEach(walk);
    })(node);
    return cols.sort(function (a, b) { return a - b; });
  }

  // The query's variant SUBTREE — every token its AUTHORED variant covers, which is what a datum's
  // token must fall inside. `null` (no variant anywhere) means ⊤: the query names none and every
  // datum passes.
  //
  // THE AUTHORED VARIANT, NOT materialize3's COVER. The cover is computed against the CONTEXT
  // TAXON's accessions, so a variant with no member in that taxon can never be covered — and the
  // meet this precedes is deliberately organism-blind (`materializeNode`, variant left ⊤). Measured
  // 2026-08-05: for `(H2B:K120ub)` under taxon 9606 the cover is ["H2B.1","caH2B"] and a mouse
  // `subH2B` row at the right column was DROPPED, though `entails2` keeps it. That breaks this
  // module's one contract — a prefilter may never drop what the meet keeps — and the "organism does
  // not gate relevance, it is displayed" ruling, in the very rows the idea layer exists to reach.
  //
  // THE ORPHANS BELONG IN IT TOO. `materialize3`'s cover is MINIMAL, so a surviving accession that no
  // token names without over-claiming is carried separately on `variantOrphans` — and reading only
  // `n.variant` made the gate drop rows for molecules materialize3 itself says survive. Found by
  // review 2026-08-04: `(H2A:S139ph)` with no taxon in context survives on nine accessions, covers
  // three of them only as orphans, and a row for one of those was rejected. That is a violation of
  // this module's one contract — a prefilter may never drop what the meet keeps.
  //
  // It went unnoticed because the soundness test built its synthetic rows' `variant` from `n.variant`
  // — the same field the gate reads — so the two could not disagree. A test whose input and its
  // subject share a source proves nothing.
  function queryVariants(node, reg) {
    var out = [];
    function add(t) { if (t && out.indexOf(t) < 0) out.push(t); }
    function addToken(v) {
      add(v);
      var sub = (reg && reg.subtreeOf) ? reg.subtreeOf(v) : null;
      if (sub) sub.forEach(add);
    }
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.node === 'proteoform') {
        (n.variant || []).forEach(addToken);
        // an orphan's OWN token, asked of the registry — the accession is what materialize3 kept, so
        // whatever variant names it must be admitted or the molecule becomes unreachable.
        (n.variantOrphans || []).forEach(function (a) {
          var info = (reg && reg.classify) ? reg.classify(a, null) : null;
          var v = info && info.variant;
          if (Array.isArray(v)) v.forEach(addToken); else if (v) addToken(v);
        });
        return;
      }
      (n.members || []).forEach(walk);
    })(node);
    return out.sort();
  }

  // ── VARIANT: A SECOND GATE, AND A WEAK ONE ──────────────────────────────────────────────────
  // Sound, because relevance is `entails2(datum, query)` and a datum on H3.3 does not entail a query
  // on H3.1 — dropping it is correct, not a loss. Subtree-aware, because a datum on H3.1 DOES entail
  // a query on `caH3`: the token must fall inside the query's subtree, not equal its label. The
  // stored value is a delimited SET (`H2A.Z|H2A.Z.1|H2A.Z.2`), so the test is token intersection
  // within `|` boundaries [BB].
  //
  // MEASURED BEFORE BUILDING, and it earns little: across eight realistic queries and 1,614
  // single-particle rows it removes 15 rows, all in `H3.1:K27M`, and `entails2` rejects those anyway.
  // The datum's variant is NULL in 65 of 80, 58 of 58, 16 of 16 rows — screens deposit at FAMILY
  // level, and NULL is ⊤ and must be kept. Built because it is three lines and correct, not because
  // it is fast; if depositions start stating variants it will begin to pay.
  //
  // NULL ON EITHER SIDE IS ⊤. A datum that names no variant passes every query, and a query that
  // names none admits every datum. Reading NULL as "no variant" instead would silently invert both.
  function columnGate(rows, columns, accessions, variants) {
    var cols = {}, i;
    var list = (columns && typeof columns.forEach === 'function' && !Array.isArray(columns))
      ? Array.from(columns) : (columns || []);
    for (i = 0; i < list.length; i++) cols[Number(list[i])] = 1;
    var accs = null;
    if (accessions) {
      accs = {};
      var al = Array.isArray(accessions) ? accessions : Array.from(accessions);
      for (i = 0; i < al.length; i++) accs[al[i]] = 1;
    }
    var vset = null;
    if (variants && variants.length) {
      vset = {};
      var vl = Array.isArray(variants) ? variants : Array.from(variants);
      for (i = 0; i < vl.length; i++) vset[vl[i]] = 1;
    }
    var kept = [], unplaceable = [];
    (rows || []).forEach(function (r) {
      if (!r) return;
      if (r.aln_column == null) { unplaceable.push(r); return; }
      if (!cols[Number(r.aln_column)]) return;                       // rejection 1: another column
      if (vset && r.variant != null && r.variant !== '') {           // rejection 2: outside the subtree
        var toks = String(r.variant).split('|');
        var hit = false;
        for (i = 0; i < toks.length; i++) if (vset[toks[i]]) { hit = true; break; }
        if (!hit) return;
      }
      kept.push({ row: r, sameMolecule: accs ? !!accs[r.uniprot_id] : null });
    });
    return { kept: kept, unplaceable: unplaceable };
  }


  // ── THE MEASUREMENT PANEL'S MODEL HALF (U8, moved from shell.js 2026-08-15) ────────────────────
  //
  // The panel cuts across this boundary rather than sitting on one side of it, which the seam map
  // said and the code agrees with: what follows decides WHAT a measurement is — its conditions, its
  // marks, whether its sign can be trusted, how it sorts — and the markup that shows a reader those
  // answers stays in shell.js. Nothing here touches the DOM.
  //
  // `effectBar` returns HTML and belongs here anyway: it is a string builder with no element in it,
  // and it encodes a JUDGEMENT — bar length normalised to the section's max |estimate|, opacity from
  // the local false sign rate, so a sign-uncertain measurement reads faint. That is a claim about the
  // data, and it now sits with the other one (`measConfident`) that also decides what to trust.
  // Signature element: the diverging effect bar. The estimate is a signed log2
  // fold-change — direction (loss vs gain) and magnitude are the payload. Sibling of
  // the AM .score-bar (same height/pill/mono-num vocabulary) but center-anchored:
  // loss grows LEFT in --bad, gain grows RIGHT in --good. Length is normalized to the
  // SECTION's max |estimate| (maxAbs) — bars are only comparable within one assay
  // type, and the section IS that axis. lfsr (local false sign rate) sets bar opacity,
  // so a sign-uncertain measurement reads faint; std_error + lfsr live on hover.
  function effectBar(v, maxAbs, opts) {
    opts = opts || {};
    const pos = v >= 0;
    const halfPct = Math.min(50, Math.abs(v) / (maxAbs || Math.abs(v) || 1) * 50);
    const conf = (opts.lfsr != null && isFinite(+opts.lfsr))
      ? Math.max(0.4, 1 - +opts.lfsr) : 1;      // low lfsr = confident sign = opaque
    const sign = v > 0 ? '+' : '';
    const numUnit = (!opts.unitHoisted && opts.unit) ? ` <span class="munit">${opts.unit}</span>` : '';
    // THE ESTIMATE AND ITS ERROR ARE ONE READING (BB, 2026-07-30). Std. error used to be a column of
    // its own, a full cell-width from the number it qualifies — so a reader had to carry ±0.31 across
    // the row to know whether −1.42 meant anything. Written together it is a single quantity, and the
    // column it used to occupy goes back to Mark and Effect.
    const se = (opts.se != null && isFinite(+opts.se)) ? ` ± ${(+opts.se).toFixed(2)}` : '';
    // ONLY WHAT THE LABEL CANNOT SAY [BB 2026-08-11]. This read `lfsr 0.031 · s.e. 0.120` against a
    // label already reading `−6.10 ± 0.12` — the same quantity, one decimal further out, in an
    // abbreviation used nowhere else on the page. The lfsr half stays because it appears nowhere else
    // at all; the s.e. half went with the column that used to hold it.
    const tip = opts.lfsr != null ? `lfsr ${(+opts.lfsr).toFixed(3)}` : '';
    return `<div class="fc-wrap"${tip ? ` title="${tip}"` : ''}>`
      + `<div class="fc-track">`
      + `<div class="fc-fill ${pos ? 'fc-pos' : 'fc-neg'}" style="width:${halfPct.toFixed(2)}%;opacity:${conf.toFixed(2)}"></div>`
      + `</div>`
      + `<span class="fc-num">${sign}${v.toFixed(2)}<span class="fc-se">${se}</span>${numUnit}</span></div>`;
  }

  // A measurement's conditions as one string (e.g. "ATP+ · 30 °C"), or '' when it states none. Read
  // in two places that must agree exactly — the row that prints it and the section that decides
  // whether every row says the same thing — so it is one function, not two joins that look alike.
  function condOf(meta) {
    return (meta && meta.conditions)
      ? Object.values(meta.conditions).filter(Boolean).join(' · ') : '';
  }

  // The glosses for the values `condOf` joined — same order, same separator, and only the ones the
  // catalogue knows. All unknown → '' → no tooltip at all, rather than a half-glossed string in which
  // the reader cannot tell which word was explained.
  function condGloss(meta) {
    const G = ((typeof MESSAGES !== 'undefined' && MESSAGES) || {}).conditions || {};
    const vals = (meta && meta.conditions) ? Object.values(meta.conditions).filter(Boolean) : [];
    if (!vals.length || !vals.some((v) => G[v])) return '';
    return vals.map((v) => G[v] || v).join(' · ');
  }

  // One measurement's lookup+measurement rows → a group object the renderer/grouper use.
  // certainty comes from the measurement's own notation ({} native vs [] exact); assayType
  // from the stamped metadata (data/SCHEMA.md §1).
  function makeGroup(mid, rows) {
    const meta = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : (rows[0].metadata ?? {});
    const certainty = (typeof notationCertainty === 'function' && meta.notation
                       && notationCertainty(meta.notation) === 'native') ? 'native' : 'exact';
    const assayType = meta.assay_type
      ? { token: meta.assay_type, label: meta.assay_type_label ?? meta.assay_type,
          order: Number(meta.assay_type_order) || Infinity }
      : { token: 'other', label: 'Other', order: Infinity };
    return { mid: String(mid), rows, meta, certainty, assayType };
  }

  // Compact mark tokens from the matched lookup rows (deduped). Plain text — used for
  // the row title/fallback. e.g. "H2A:R3A · H4:K5ac".
  function measMarks(g) {
    const seen = new Set(), out = [];
    for (const r of g.rows) {
      const fam = r.variant && r.variant !== 'NA' ? r.variant : r.family;
      const mv  = r.substitution || r.modification || '';
      const label = `${fam}:${r.residue ?? ''}${r.position}${mv}`;
      if (!seen.has(label)) { seen.add(label); out.push(label); }
    }
    return out.join(' · ');
  }

  // ── Ranking within a section ────────────────────────────────────────────────────────────────────
  // Biggest effects first, but only among measurements whose SIGN we can trust — a huge estimate with a
  // std. error to match is noise, and noise at the top of a capped list is worse than no list.
  //
  // The confidence test uses whatever the layer actually deposited, in decreasing order of directness:
  //   q-value → p-value → lfsr (local false sign rate; the screen layer's own measure) → the std.-error
  //   rule, |estimate| >= 2 * std_error.
  // A measurement carrying none of these is treated as confident: we cannot judge it, and silently
  // sinking data because its source was terse is not a judgement, it is a guess.
  //
  // NOTHING IS DROPPED. Low-confidence rows sort last, which under the render cap means they fall below
  // the fold and "Show more" reveals them — the ordering does the filtering, so the panel never claims
  // data does not exist because we doubted it. (BB asked to "ignore" them; ranking them last is the same
  // effect where it matters and stays honest where it counts.)
  const ALPHA = 0.05;
  function measConfident(g) {
    const m = g.meta || {};
    const num = (v) => (v == null || v === '' || !isFinite(+v)) ? null : +v;
    const q = num(m.qvalue), p = num(m.pvalue), lfsr = num(m.lfsr), se = num(m.std_error);
    if (q != null) return q <= ALPHA;
    if (p != null) return p <= ALPHA;
    if (lfsr != null) return lfsr <= ALPHA;
    const est = num(g.rows[0].estimate);
    if (se != null && est != null) return Math.abs(est) >= 2 * se;
    return true;                                   // nothing to judge on — do not sink it
  }
  function measRank(a, b) {
    const ca = measConfident(a), cb = measConfident(b);
    if (ca !== cb) return ca ? -1 : 1;             // trustworthy sign first
    const ea = Math.abs(+a.rows[0].estimate) || 0;
    const eb = Math.abs(+b.rows[0].estimate) || 0;
    return eb - ea;                                // then largest absolute effect
  }

  // ── end of the panel's model half ─────────────────────────────────────────────────────────────

  const api = { tileMods, groupMeasurementsByType, queryColumns, queryVariants, columnGate,
                effectBar, condOf, condGloss, makeGroup, measMarks, measConfident, measRank };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/port-model.js
// Pure, DOM-free port-drift helpers. See
// specs/2026-07-13-port-drift-design.md §5.1-§5.2.
(function (root) {
  'use strict';

  // Port is "active" iff the port lens differs from the context lens, or the Show-as context names
  // a target the Read-as context does not. Equality = off (no sentinel).
  function portDriftActive(qport, qcontext, portTargetsElsewhere) {
    return qport !== qcontext || !!portTargetsElsewhere;
  }

  // DOES THE SHOW-AS CONTEXT POINT SOMEWHERE ELSE? (BB, 2026-07-30: Hs/Hs and Mm/Mm still drew port
  // indicators.) The third argument used to be `isPortActive()`, which answers a DIFFERENT question
  // — "is a Show-as YAML set at all". Picking any target writes that YAML, so choosing Mm and then
  // Hs again left the port "active" forever, and the materials pane went on drawing drift against
  // the context it was already in. Nothing was comparing the two ends; now this is the only thing
  // that decides, and comparing them is all it does.
  //
  // BOTH ENDS ARE STATED (BB, 2026-08-07: "the single source of truth are the two contexts"). Each
  // lens is a context, initialised at startup from storage or the reference organism and never
  // unset, so neither argument has an absent case to mean anything by. The `portDefaultTaxon == null
  // → no port` leg that stood here was the last of the third state: it made "the Show as is
  // unstated" a way of saying "no port", which is the same thing as the two agreeing and was a
  // second way of saying it. Callers that genuinely have no lenses (a render suite's stub page) do
  // not ask — see portGoesElsewhere.
  //
  // Per-family blocks are treated as a real port without inspecting them: deciding otherwise means
  // re-running resolution per family here, and a Show-as YAML that names families is a statement
  // that something should be read elsewhere even when its default taxon agrees. That is also why
  // the Show-as species menu writes no family blocks — see portYamlForTaxon.
  function portTargetsElsewhere(portDefaultTaxon, portFamilies, ctxDefaultTaxon) {
    if (portFamilies && Object.keys(portFamilies).length) return true;
    return portDefaultTaxon !== ctxDefaultTaxon;
  }

  function REG() {
    const p = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    return (p && p.DEFAULT_REGISTRY) || null;
  }

  // The source↔target numbering map, derived from the registry's frame (spec 2026-07-25 D3.4).
  //   ideaToPort:  Map<ideaPos, portMaterialPos>   where the mark should be drawn
  //   portToIdea:  Map<portMaterialPos, ideaPos>
  //   driftByPort: Map<portMaterialPos, {from, to}> residues that differ between the two materials
  //   driftByIdea: Map<ideaPos, {from, to}>         the same drift, keyed in the anchor's numbering
  //   colToPort:   Map<column, portMaterialPos>     the same map, keyed with no anchor in it
  //   driftByCol:  Map<column, {from, to}>          the same drift, for consumers that hold columns
  //
  // Both keyings are needed and they are not interchangeable: the port SEQUENCE is drawn in the
  // target's own numbering, while the alignment GRID's columns are idea positions.
  //
  // This REPLACES `resolvePortAlignment` in port-editor.js, which built the same map as a DuckDB
  // JOIN on `family_position` — a third implementation of numbering, after the registry frame and
  // the (now deleted) grid filter. It was also keyed WRONG: its map went material→material
  // (`srcToPort[src.protein_position]`), but a notation mark carries an IDEA position, so porting
  // looked an idea position up in a material table. That is invisible while the source realization
  // IS the family reference (P62807 for H2B, identity numbering) — the same masking that hid the
  // grid bug — and moves the mark as soon as it is not: with a yeast source, idea 120 resolved to
  // yeast protein 120, whose family position is 117, landing the mark on human 117 instead of 120.
  //
  // Keying on the idea position removes the intermediate entirely: each side answers the same
  // question in its own numbering. Sync — no DuckDB, no cache to invalidate.
  //
  // `frame` is the QUERY'S frame (spec 2026-07-31) — the numbering the marks and the grid's columns
  // are in. Every one of the four questions below is asked in it, because they are the same question
  // asked of two molecules and an answer in two different numberings is not an alignment. Omitted →
  // the family frame, which is every caller that predates the rule and 22 of the 32 tokens.
  //
  // Missing it is not a rounding error. `driftByIdea` paints the grid, and under a translating token
  // the grid is keyed in the variant's own numbering: H2A.Z's own 1 is family 2 and its own 7 is
  // family 5, so a family-keyed drift map shades one to three columns off — and it has no key at all
  // for the residues a variant frame exists to reach (H2A.Z's K4/A5/G6 have no family position), so
  // a mark on one was dropped as unportable when it was only unnameable.
  // A PORT IS A WALK ACROSS ONE COLUMN (R5/R18, 2026-08-03). Source's own position → its column →
  // the target's own position at that column. No idea frame in the middle, which is what the `frame`
  // argument used to select: `ideaPositions(src, frame)` enumerated the source's positions in a
  // NUMBERING, and a residue that numbering could not name (H2A.Z's K4/A5/G6) was simply not
  // enumerated, so it could not be ported at all. A column has no such gap.
  //
  // WHOSE NUMBER IS THE KEY. Not the source's own — the marks being remapped were written under the
  // QUERY'S TOKEN, not against the source molecule, so `refAcc` is R12's anchor: the canonical member
  // of the token's own subtree, defaulting to the family's. Keying by the source's own number instead
  // maps a yeast-sourced `H2B:K120ub` onto human 117, because yeast's own 120 is a different residue
  // — which is exactly the confusion the port exists to avoid, arrived at from the other side.
  function portAlignment(srcAccession, portAccession, registry, ref) {
    const reg = registry || REG();
    const empty = { ideaToPort: new Map(), portToIdea: new Map(), colToPort: new Map(),
                    driftByPort: new Map(), driftByIdea: new Map(), driftByCol: new Map() };
    if (!reg || !reg.colAt || !reg.ownAtCol || !srcAccession || !portAccession) return empty;
    const ideaToPort = new Map(), portToIdea = new Map(), colToPort = new Map(),
          driftByPort = new Map(), driftByIdea = new Map(), driftByCol = new Map();
    // DEFAULTS TO THE IDEA ANCHOR, NOT TO THE SOURCE. With no token stated the numbers are idea
    // numbers, which are the family canonical member's own — so a yeast-sourced 120 is human's 120
    // and not yeast's own 120 (whose column human calls 117).
    // `ref` may be an ACCESSION or a variant TOKEN — callers hold the token, suites hold either,
    // and resolving here keeps one anchor rule rather than two spellings of it.
    if (ref && reg.hasColumns && !reg.hasColumns(ref)) {
      const rInfo = reg.classify ? reg.classify(srcAccession, null) : null;
      ref = (reg.printRefOf ? reg.printRefOf(ref, rInfo && rInfo.family) : null) || null;
    }
    if (!ref) {
      const info = reg.classify ? reg.classify(srcAccession, null) : null;
      ref = (info && info.family && reg.canonOf) ? reg.canonOf(info.family) : srcAccession;
    }
    for (let own = 1; own <= 1200; own++) {
      const col = reg.colAt(ref, own);
      if (col == null) continue;
      // BOTH ENDS MUST OCCUPY THE COLUMN. The anchor supplies the KEY, but a port can only carry a
      // residue the source actually has — a map over the anchor alone would offer keys for residues
      // the card never showed, and the drift shading would paint them.
      if (reg.ownAtCol(srcAccession, col) == null) continue;
      const portPos = reg.ownAtCol(portAccession, col);
      if (portPos == null) continue;                       // no counterpart in the target
      ideaToPort.set(own, portPos);
      portToIdea.set(portPos, own);
      // KEYED BY THE COLUMN AS WELL, AND THAT IS THE KEYING WITH NO ANCHOR IN IT. This loop already
      // walks columns; `own` is only the anchor's name for one. Every consumer downstream of
      // materialize3 holds columns, and the shell was converting back — column → anchor's own →
      // column — to look drift up here, a round trip that can only lose (the anchor has no name for
      // a column it does not occupy). Two keyings of one fact, neither derived from the other.
      colToPort.set(col, portPos);
      const from = reg.residueAtCol(srcAccession, col), to = reg.residueAtCol(portAccession, col);
      if (from != null && to != null && from !== to) {
        driftByPort.set(portPos, { from, to });
        driftByIdea.set(own, { from, to });
        driftByCol.set(col, { from, to });
      }
    }
    return { ideaToPort, portToIdea, colToPort, driftByPort, driftByIdea, driftByCol };
  }

  // Remap notation mods from the IDEA frame to the port material's own numbering, for rendering
  // on the port sequence. Returns NEW clones — never mutates input (the shell's mods are shared
  // card state, from materialsFromCanon).
  //   ideaToPort:     Map<ideaPos, portMaterialPos>   (from portAlignment)
  //   portSequence:   the target sequence being rendered (1-based material positions)
  //   srcAccession:   the source material, for the _sourceWt lookup (read on the IDEA position)
  //   frame:          the query's frame, for the same reason — `_sourceWt` is read at the IDEA
  //                   position, and which residue that is depends on whose numbering it is in
  function portMods(mods, ideaToPort, portSequence, srcAccession, registry, frame) {
    const reg = registry || REG();
    return (mods ?? []).map(m => {
      const clone = { ...m };
      const portPos = ideaToPort ? ideaToPort.get(m.position) : undefined;
      if (portPos == null) {
        clone._unmapped = true;               // position not alignable to port
        return clone;
      }
      clone._srcPosition = m.position;
      clone.position = portPos;
      const portAa = portSequence ? portSequence[portPos - 1] : undefined;
      if (portAa && clone.variant && clone.variant === portAa) {
        clone._neutralized = true;            // variant already native in target
        // The source wild type is read AT THE COLUMN, which is the site the mark is on. This passed
        // the card's `frame` as a fourth argument to `residueAt` — a parameter that no longer exists
        // and that returned null for every call while it did, so `_sourceWt` silently fell back to
        // the stated letter instead of the source molecule's actual residue.
        const srcCol = (reg && reg.colAt && srcAccession) ? reg.colAt(srcAccession, m.position) : null;
        const srcAa = (srcCol != null && reg.residueAtCol) ? reg.residueAtCol(srcAccession, srcCol)
                    : ((reg && reg.residueAt && srcAccession) ? reg.residueAt(srcAccession, m.position) : null);
        clone._sourceWt = srcAa ?? m.residue;
      }
      return clone;
    });
  }

  const api = { portDriftActive, portTargetsElsewhere, portMods, portAlignment };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/realization-model.js
// Pure, DOM-free realization-resolution helper. See
// specs/2026-07-14-realization-fluid-family-design.md (precedence chain) and
// specs/plans/2026-07-14-realization-resolution.md (Task 1).
//
// A realization slot names a *material* (UniProt accession, gene, protein
// name, synonym). Resolution derives its idea-layer family a posteriori and
// applies one precedence chain: a realization fixes exactly the dimensions its
// identifier determines; context fills the rest, never overwriting a fixed one.
(function (root) {
  'use strict';

  // resolveRealization(lookup, ctx) — apply the precedence chain.
  //   lookup: null (unresolvable) OR { family, variant?, uniprot_id?, taxon_id? }
  //           — as specific as the identifier determined. A UniProt accession
  //           pins family + species (taxon_id set); a family token pins family
  //           only (taxon_id absent).
  //   ctx:    { taxon_id? } the query context (species lens), or null.
  // Returns { resolved:false } (no family derivable) or
  //   { resolved:true, family, variant, uniprot_id, taxon_id, speciesPinned }.
  function resolveRealization(lookup, ctx) {
    if (!lookup || !lookup.family) return { resolved: false };
    const speciesPinned = lookup.taxon_id != null;      // did the token fix species?
    return {
      resolved: true,
      family: lookup.family,
      variant: lookup.variant ?? null,
      uniprot_id: lookup.uniprot_id ?? null,             // pinned material, if any
      taxon_id: speciesPinned ? lookup.taxon_id : ((ctx && ctx.taxon_id) ?? null),
      speciesPinned,
    };
  }

  const api = { resolveRealization };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/materialize-card.js
// The materials pane's ADAPTER onto the materialized node.
//
//   cardFromNode(node)
//     → { accessions, verdicts: { keep, removed, byAcc, candidates, frameSuspect, frameAmbiguous } }
//
// The pane makes NO call into the resolver any more (2026-08-07). It used to — `materializeCard`
// built a probe and ran a second materialization — and this file's whole history is of second
// implementations of physical possibility being removed one at a time: first `materialize-validity.js`
// (which passed the material's real residue into `residueStateError` as `residue:`, the field the
// idea layer defines as SOFT, so a bare impossible PTM could only ever warn), then the probe itself.
// The rule lives once, in the walk:
//
//   stated wild-type mismatch → WARN   (soft; a variant-level difference)
//   impossible modification   → REJECT (the accession's residue cannot carry the mark)
//
// The split that remains is deliberate: materialize3 decides MEMBERSHIP, the grid decides COLOUR.
// Nothing here recomputes possibility; it only reshapes verdicts for the renderer.
//
// Pure + DOM-free + Node-testable (reads the parser globals lazily).
(function (root) {
  'use strict';

  function P2() { return (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null; }

  // Parse-tree marks → IR marks. The one documented field rename in the project: a modification's
  // substituted residue is `mod.variant` in the parse tree and `substitution` in the IR and the
  // data layer (the slot-level `variant` is a different thing at a different nesting level).
  // Range marks are segments, not point marks, and carry no residue claim.
  function irMods(mods) {
    return (mods || [])
      .filter(function (m) { return m && m.rangeEnd == null && m.position != null; })
      .map(function (m) {
        return { position: m.position,
                 residue: m.residue == null ? null : m.residue,
                 substitution: m.variant == null ? null : m.variant,
                 modification: m.modification == null ? null : m.modification,
                 negated: !!m.negated };
      });
  }

  var DROP_REASONS = { 'accession-ruled-out': 1, 'no-frame': 1, 'position-gap': 1 };

  // ASKED OF walk2, which owns the three-valued chain. The literal spelling is the fallback for an
  // engine-free Node context and is deliberately the same two words, not a paraphrase.
  function eliminated(v) {
    var p = P2();
    if (p && p.walk2 && typeof p.walk2.isEliminated === 'function') return p.walk2.isEliminated(v);
    return v === 'unoccupied' || v === 'forbidden';
  }

  // ── THE CARD READS materialize3's NODE ─────────────────────────────────────────────────────────
  // An ADAPTER, not a second opinion. `materializeCard` built a fresh probe and ran a SECOND
  // materialization, ignoring the accession set, verdicts, reasons and warnings `materialize3` has
  // already put on the node — and it was handed own-numbers the shell had corrupted, so the second
  // pass searched for a residue at a number no molecule uses and came back empty. `H2AS139ph`
  // rendered as "H2A S177ph — no sequences resolved": 177 is the alignment COLUMN, printed as if it
  // were a residue number, because the shell anchored the card to the family's print reference —
  // P0C0S8, which the walk had ELIMINATED — and fell back to the raw column when that molecule
  // turned out to have no counterpart there.
  //
  // Every field here is COPIED or COUNTED. Nothing is recomputed, because the node is the answer:
  // `accession` is the surviving set, `verdicts` is total over the candidates, and `reasons` carries
  // the cause per accession with the column and that molecule's own number already resolved.
  //
  // The shapes are the ones the pane's consumers already read (`emptySetMessage`, `frameNotice`,
  // `resolvedAlignment`, the grid's `byAcc` shading), so this is a change of SOURCE, not of contract.
  //
  // `frameSuspect` is EMPTY and stays a key. walk2 no longer emits `frame-suspect`; its successor is
  // `identified-outside-context`, which states the fact rather than the suspicion. Nothing on the
  // page reads `frameSuspect` (checked repo-wide, 2026-08-07) — the key survives only so a consumer
  // that spreads this object does not acquire an `undefined` where it had an array.
  function cardFromNode(node) {
    // No node, or a node the walk never judged → say nothing rather than guess. A null verdict
    // leaves the grid UNFILTERED, which is the honest degradation: we did not decide. Same contract
    // as the no-engine branch below.
    if (!node || !node.verdicts) return { accessions: null, verdicts: null };

    // ⊤ IS `null`, AND ⊤ IS NOT THE EMPTY SET. A copy that constrains nothing — the completion H4 of
    // `(H3:K27M)`, or a bare `H2A` — carries `accession: null`, which the engine writes wherever a
    // set equals its universe. Reading that as `[]` emptied the grid for every unmarked card on the
    // page. The universe is the verdict map's own key set, which is total over the candidates by
    // invariant, so ⊤ is spelled out here and nowhere else.
    // NOT-ELIMINATED, NOT SATISFIES, AND THAT IS AN INTENDED DIVERGENCE [BB 2026-08-24]. This keeps
    // its own derivation, and it deliberately disagrees with `satisfiersOf` in world-view-model.js:
    // for `H3:K27M` this gives 9 molecules and `satisfiers` gives 8, the difference being the one
    // that is CONDITIONAL. The two answer different questions and the page wants both.
    //
    //   satisfiers        which molecules DO carry this. The narrow, confident answer.
    //   not-eliminated    which molecules the query COULD be about. The card's answer, because a
    //                     card exists so a reader can see that their query is possible here — and
    //                     a molecule that is merely conditional is still a reading of what they
    //                     typed. Hiding it would silently narrow a misspecified query into a
    //                     plausible one, and the reader would never learn they had mis-said it.
    //
    // So do not "reconcile" these two. Two derivations of one question is the second opinion this
    // pipeline exists to abolish; two derivations of two questions is the pipeline working.
    var accessions = Array.isArray(node.accession) ? node.accession.slice()
      : Object.keys(node.verdicts).filter(function (a) { return !eliminated(node.verdicts[a]); }).sort();
    var keep = new Set(accessions);
    var removed = [], byAcc = {}, frameAmbiguous = [];

    var reasons = node.reasons || [];
    for (var i = 0; i < reasons.length; i++) {
      var r = reasons[i];
      if (DROP_REASONS[r.reason]) { removed.push(r); continue; }
      // KEYED BY COLUMN, like the branch below and for the same reason: the grid is drawn on
      // columns, so a map keyed by the authored number is read with a coordinate it is not in and
      // the wild-type shading silently stops firing for every token that renumbers. walk2's record
      // carries `column` for exactly this.
      if (r.reason === 'wt-mismatch' && keep.has(r.accession)) {
        var v = byAcc[r.accession] || (byAcc[r.accession] = { state: 'warn', byCol: {} });
        if (r.aln_column != null) v.byCol[r.aln_column] = 'warn';
      }
    }

    var warnings = node.warnings || [];
    for (var j = 0; j < warnings.length; j++)
      if (warnings[j].reason === 'number-belongs-to-the-token') frameAmbiguous.push(warnings[j]);

    return { accessions: accessions,
             verdicts: { keep: keep, removed: removed, byAcc: byAcc,
                         // THE DENOMINATOR IS WHAT THE WALK JUDGED, which is every key in its
                         // verdict map — the map is total over the candidates by invariant. Counting
                         // `realize()` again here would be a second answer to a settled question.
                         candidates: Object.keys(node.verdicts).length,
                         frameSuspect: [], frameAmbiguous: frameAmbiguous } };
  }

  // ── `materializeCard` WAS DELETED HERE (2026-08-07) ────────────────────────────────────────────
  // It built a FRESH probe from (family, variant, mods, ctx, portCtx, pin, segments) and ran a
  // SECOND materialization through `materialize2` / `port2`, ignoring the accession set, verdicts,
  // reasons and warnings `materialize3` had already put on the node — and the probe was fed
  // own-numbers the shell had corrupted, so the second pass searched for a residue at a number no
  // molecule uses and came back empty.
  //
  // Everything it did is above, in `cardFromNode`, as a copy rather than a computation. The port
  // was its last distinct job and is answered by materializing in the TARGET context: the column is
  // the species-independent coordinate `abstract2` was manufacturing, so nothing is lost.
  //
  // `materialize2` and `port2` are gone from `resolve2` in the same breath. Deleting the caller and
  // leaving the callee is how a second implementation survives to be picked up again.

  // D4.3 — the ONE thing the pane says about what it did not show. No "excluded N" count: that
  // conflates being narrowed by the query (your own statement) with being ruled out by chemistry
  // (a finding). But an empty pane is indistinguishable from a failure, so when the filter empties
  // the set entirely, say so WITH ITS CAUSE. Returns null when there is nothing to report.
  function emptySetMessage(family, verdicts, species, variant) {
    if (!verdicts || verdicts.keep.size) return null;
    var where = species ? ' in ' + species : '';
    // Nothing was ruled out and nothing was kept: the registry simply holds no such material here.
    // It is a gap in our coverage — NOT a claim that the organism lacks the histone.
    //
    // NAME THE VARIANT WHEN ONE WAS ASKED FOR. Saying "no H2A sequences are registered in
    // S. cerevisiae" while the registry holds three yeast H2As is a false statement about the
    // dataset in a message whose entire job is to be honest about the dataset. It only became
    // reachable when the yeast tetramer landed (2026-07-28) — before that the family-level gap was
    // real and the variant-level one was hidden behind it.
    var what = variant ? variant + ' sequences are registered as ' + family : family + ' sequences are registered';
    if (!verdicts.removed.length)
      return verdicts.candidates
        ? null
        : 'no ' + what + where + ' — a gap in this dataset, not in the organism';
    var byReason = {};
    verdicts.removed.forEach(function (r) { (byReason[r.reason] = byReason[r.reason] || []).push(r); });
    var n = verdicts.candidates || verdicts.removed.length;
    var noun = n === 1 ? 'sequence' : 'sequences';
    if (byReason['accession-ruled-out']) {
      // NAME EVERY RESIDUE THAT IS ACTUALLY THERE, most common first — because there is not
      // always only one, and this used to name whichever molecule the list happened to start with
      // [BB 2026-08-24]. `H3:S28me3` rules out nine sequences: six carry S at 28 and three carry
      // R, the cenH3s. The message said "S" for as long as P68431 sorted first, and said "R" the
      // day the registry records were written in accession order — same nine molecules, same
      // residues, different first element. A sentence whose job is to give the CAUSE cannot be
      // decided by arrival order.
      //
      // Sorted by count and then by letter, so the wording is a function of the data alone. This
      // is a display fix and stays on the display side; no verdict, coordinate or key moves.
      var ruled = byReason['accession-ruled-out'];
      var tally = {};
      ruled.forEach(function (r) { tally[r.residue] = (tally[r.residue] || 0) + 1; });
      var res = Object.keys(tally).sort(function (a, b) {
        return tally[b] - tally[a] || (a < b ? -1 : a > b ? 1 : 0);
      });
      var r0 = ruled[0];
      return 'no ' + family + ' ' + noun + where + ' can carry ' + r0.modification + ' at '
           + r0.position + ' — the residue there is '
           + (res.length === 1 ? res[0]
              : res.slice(0, -1).join(', ') + ' or ' + res[res.length - 1]);
    }
    if (byReason['no-frame'])
      return 'no ' + family + ' ' + noun + ' here aligns to the ' + family
           + ' reference, so position-specific marks cannot be placed on ' + (n === 1 ? 'it' : 'them');
    if (byReason['position-gap'])
      return 'position ' + byReason['position-gap'][0].position + ' has no counterpart residue in '
           + (n === 1 ? 'this ' + family + ' sequence' : 'any of these ' + family + ' sequences');
    return null;
  }

  // The frame the user probably meant, when the two readings of one number disagree and the stated
  // wild-type letter picks a side. Detect and say; never silently re-interpret (BB).
  function frameNotice(verdicts) {
    var a = verdicts && verdicts.frameAmbiguous && verdicts.frameAmbiguous[0];
    if (!a) return null;
    return a.stated + a.position + ' reads as ' + a.atMaterial + a.position + ' on ' + a.accession
         + ", which cannot carry it \u2014 that molecule numbers the " + a.stated + ' you mean '
         + (a.materialPositionOfStated != null ? a.stated + a.materialPositionOfStated : 'differently')
         + '. Positions after an accession are read in the numbering of that molecule.';
  }

  var api = { cardFromNode: cardFromNode,
              emptySetMessage: emptySetMessage, frameNotice: frameNotice, irMods: irMods };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/alignment-model.js
// The "possible sequences" alignment model for the materials pane
// (specs/2026-07-18-materials-alignment-grid-design.md). Resolves the accession set a
// query could mean, fetches their residues on the SHARED coordinate, and pivots into a
// grid model. The pivot (buildAlignmentModel) is pure + DOM-free + Node-testable; the
// DuckDB-backed resolvedAlignment runs only in the browser.
(function (root) {
  'use strict';

  // Cache of the agreement-with-consensus row order per slot (family|variant), so the
  // per-material layer tables (mass, AM) can sort their rows to match the grid.

  // ── AN INSERTION GETS A COLUMN, AND THE COLUMN IS `aln_column` (BB, 2026-07-31) ────────────────
  //
  // A residue with no `family_position` is an insertion relative to the family reference. It used to
  // get no column at all — there was nowhere to put it, because the grid was keyed on the idea
  // position and an insertion by definition has none. It was drawn instead as a 2px wedge on the
  // preceding cell plus the letters appended after the LAST block, which failed three ways: an
  // N-terminal insertion has no preceding cell, so it silently rendered ~120 columns to the RIGHT of
  // where it belongs (Xenopus H2B, yeast H2A.Z); a run of 4 got no count at all; and the reader was
  // left to infer the shape of the molecule from a row-label superscript.
  //
  // `aln_column` is the answer and it was already in the table. `init/build_alignments.R` runs one
  // DECIPHER MSA per family and emits a column index for every residue of every member;
  // `init/apply_alignment_numbering.R` then DEFINES `family_position` as "the family reference's
  // protein_position at the same aln_column". So `aln_column` is not a parallel coordinate that
  // could disagree — it is the one `family_position` is derived from, and it is a strict refinement:
  // verified over docs/data/proteins.parquet, `family_position` is a function of (family,
  // aln_column) and vice versa, 0 violations either way, and every mature residue of every framed
  // accession has one. Since 2026-08-15 that is EVERY residue in the table without exception: the
  // only ones that lacked a column were the 2,235 belonging to Q5SSJ5 and Q149N8, and `action:
  // exclude` now keeps those two out of proteins.parquet entirely rather than shipping them
  // unnumbered. `run_shipped_tables_tests.R` asserts the no-exception form.
  //
  // So `family_position` STAYS the idea coordinate. Nothing about matching, `entails2`, the identity
  // keys or `registry.materialPos` moves. `aln_column` is a DISPLAY key that orders the columns and
  // gives the insertions somewhere to be. It must never leak: not into notation, not into
  // `entails2`, not into a cache key that outlives a data build — `build_alignments.R` is explicit
  // that a column index may churn when a member is added to the MSA.
  //
  // NOT "a column exists if every displayed row shares it", which was the first shape of this idea.
  // That rule is non-monotone in the row set: macroH2A on its own would gain 244 columns and lose
  // all of them the moment it is shown inside the H2A card, so two cards of the same family stop
  // being superimposable — a weaker form of the very thing the coordinate comment below forbids.
  // The column set is a property of the FAMILY; only the LAYOUT below is query-dependent.

  // A contiguous run of insertion columns up to this long is drawn out in full. Longer runs collapse
  // to one gutter cell. A run is one biological event, so it is one decision: macroH2A's 213-column
  // macro domain collapses, H2A.Z's KAG collapses nothing. 8 keeps every core-family card within one
  // block of its current width; only cenH3 (a 97-run) and H1 (a 567-run) reach the collapse path,
  // which is where collapsing is the right answer anyway.
  var INS_EXPAND_MAX = 8;

  // ── LENGTH IS THE SECOND QUESTION. THE FIRST IS WHETHER THE ROWS DISAGREE (BB, 2026-07-31) ──────
  //
  // A column is an "insertion" because the FAMILY REFERENCE has no position for it. That is a fact
  // about the reference, not about the molecules on screen, and the length cap alone read it as
  // though it were about them: query one accession, or a pair of near-equal length, and a stretch
  // every displayed row carries in full was hidden behind a gutter — because a human canonical
  // histone happens not to have it. Nothing was being aligned there. There was no disagreement to
  // summarise, and the summary cost the reader the residues of the only molecules on the card.
  //
  // So the gate asks first whether the run is DISPUTED among the displayed rows: a column is mixed
  // when some rows carry a residue there and others do not. Strip the columns every row agrees on
  // (all carry) and see what is left.
  //
  //   no mixed column   → show the whole run, whatever its length. The rows agree; the grid is not
  //                       resolving anything, it is just longer than the reference.
  //   mixed columns     → this IS an alignment question, so the length cap applies as before.
  //
  // This is the "gate on variant numbering" answer without a second numbering frame: when the
  // accession set is a clade whose members all carry the insertion, agreement makes it visible, and
  // when the set spans the divergence the cap still keeps macroH2A's macro domain out of the way.
  // The cap is measured on the WHOLE run rather than on the mixed columns alone — a 213-column
  // domain with four disputed columns is still 213 columns of grid, and the reason to collapse it
  // was never that the reader would misread it.
  //
  // MEASURED over docs/data/proteins.parquet, columns drawn before → after. Every family card is
  // unchanged (H2A 144, H2B 139, H3 142, H4 103, H1 238), as is every card whose rows span the
  // divergence; what moves is the narrow sets, which is the case this is for:
  //
  //     macroH2A.1 alone   129 → 369      macroH2A.1 + .2   129 → 160
  //     H2A.B (2 rows)     105 → 115      H2B.W (2 rows)    139 → 147
  //
  // macroH2A alone is the extreme and it is the rule working: the protein is 372 residues, and 240
  // of them were behind a gutter because human canonical H2A stops at 129. Seven stacked blocks
  // instead of three is the honest shape of that molecule. H2A.Z is 127 either way — its KAG run is
  // three columns and was already under the cap, which is the case that started this and is
  // untouched by the gate.
  function runIsDisputed(columns, i, j, nRows) {
    if (!nRows) return true;                        // carrier counts unavailable — cap as before
    for (var k = i; k < j; k++) {
      var n = columns[k].n;
      if (n == null) return true;                   // ditto, per column
      if (n < nRows) return true;
    }
    return false;
  }

  function registry() {
    var p = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    return (p && p.DEFAULT_REGISTRY) || null;
  }

  var _seqOrder = {};
  function _orderKey(family, variant) { return family + '|' + (variant == null ? '' : variant); }
  function sequenceOrder(family, variant) { return _seqOrder[_orderKey(family, variant)] || null; }

  // The grid's coordinate follows the QUERY'S FRAME (spec 2026-07-31 §7.1).
  //
  // This used to auto-select with query BREADTH — `variant_position` for a pinned variant,
  // `family_position` for a bare family — and that was a real bug: it made a notation position mean
  // different residues depending on how the user phrased the query, so on a divergent pinned variant
  // a mark landed on the wrong residue. It was frozen to `family_position` behind the rule that
  // display may not decide what a position means.
  //
  // The freeze is lifted, and the rule it protected still stands, because the frame is no longer
  // INFERRED. Under the frame rule the query STATES it — a number after a variant token is read in
  // that variant's numbering — so drawing the grid in that frame is not display deciding a meaning,
  // it is display reporting one. Without this `H2A.Z:K4ac` resolves correctly and then cannot be
  // drawn at all: an insertion column carries no `data-pos`, so a mark is structurally unable to
  // land there.
  //
  // ONLY THE TEN TOKENS THAT ACTUALLY RENUMBER. For the other 22, `variant_position` and
  // `family_position` are the same number for every residue of every accession in the subtree
  // (measured against proteins.parquet: 0 mismatches), so switching would be churn that could only
  // introduce difference, never remove it. `frameTranslates` is the registry's answer to that
  // question and there is no second copy of it here. With no registry loaded — the isolated-Node
  // callers — the answer is the frozen one, which is the behaviour those tests were written against.
  // THE GRID'S GEOMETRY IS THE COLUMN; THE PRINTED NUMBER IS A VIEW OF IT (R5/R3, 2026-08-03).
  //
  // This used to choose between two idea coordinates — `variant_position` when the token's frame
  // TRANSLATED, `family_position` when it did not — so the number under a residue depended on which
  // token you had typed. There is one answer now: `family_position` IS the canonical member's own
  // number at each column (R3), so it is the column's name, printed. Nothing switches.
  //
  // The geometry never went through the frame in the first place: the grid has keyed its columns on
  // `aln_column` since the out-of-frame query was merged away. What is deleted here is only the
  // choice of LABEL, which is the last thing the frame decided.
  function alignmentCoord() { return 'family_position'; }

  // Pure pivot: rows [{uniprot_id, protein_name, pos, residue}] → grid model
  //   { coord, positions:[int…], rows:[{uniprot_id, name, cells:{pos:res}}],
  //     conserved:Set<pos>, counts:{pos:{res:n}}, present:{pos:n}, consensus:{pos:res} }
  //
  // These grids are NOT true gapped alignments (residues are keyed by a shared numeric
  // coordinate, not by an alignment column), so we "fake" the alignment two ways:
  //   1. counts/present drive MAJORITY colouring in the renderer: a residue that agrees
  //      with more than half of the present residues at its position is left uncoloured;
  //      a minority residue — or a tie — is coloured. This means a lone divergent variant
  //      (e.g. CENPA among the H3s) lights up while the agreeing majority stays quiet,
  //      instead of the whole column going gold.
  //   2. rows are ORDERED by agreement with the plurality consensus (descending), so the
  //      concordant sequences cluster at the top and outliers (CENPA) sink to the bottom.
  // conserved (every present row shares one residue) is retained for the meta summary.
  // `verdicts` (optional) is what materialize3 already decided, passed in — NOT recomputed here:
  //   { keep: Set<uniprot_id>, removed: [{accession, reason, position, column}], byAcc: {acc: {byCol}} }
  // `removed` entries are walk2's OWN reason records, passed through unchanged — so the molecule is
  // on `accession`, NOT `uniprot_id`. This line said `uniprot_id` until 2026-08-11 and render.js's
  // ruled-out hover was written against it, printing an empty name for every entry.
  // The pivot no longer runs a physical-possibility filter of its own. It had one
  // (`materializeRow`), it disagreed with the resolver, and it was the weaker of the two: it fed
  // the material's real residue into the idea layer's SOFT `residue` field, so a bare impossible
  // PTM could only ever warn. One implementation, in the layer that owns sequences.
  function buildAlignmentModel(rows, coord, verdicts) {
    var byAcc = new Map();
    var posSet = new Set();
    var colPos = new Map();          // aln_column → idea position, or null for an insertion column
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var pos = (r.pos == null) ? null : Number(r.pos);
      // NO `col` MEANS THE POSITION IS ITS OWN COLUMN. Two callers arrive that way and both are
      // correct: the frameless branch below (each row on its own numbering, where no column asserts
      // a correspondence and so no MSA column is wanted), and the pure-pivot tests, which state
      // rows as {pos, residue} because that is the shape the idea layer cares about.
      var col = (r.col == null) ? pos : Number(r.col);
      if (col == null) continue;     // no column and no position — nothing to place
      if (!byAcc.has(r.uniprot_id))
        byAcc.set(r.uniprot_id, { uniprot_id: r.uniprot_id, name: r.protein_name,
                                  uniprotName: r.uniprot_name, species: r.species,
                                  variant: r.variant, cells: {}, colCells: {}, ownAt: {} });
      var a = byAcc.get(r.uniprot_id);
      // `cells` stays keyed by IDEA position and gains nothing from this change — it is what
      // `markSite`, the mass loop and every mark lookup read, and an insertion has no idea position
      // to be found at. `colCells` is the display twin.
      if (pos != null) { a.cells[pos] = r.residue; posSet.add(pos); }
      a.colCells[col] = r.residue;
      a.ownAt[col] = (r.own == null ? pos : Number(r.own));
      if (!colPos.has(col)) colPos.set(col, pos);
    }
    var positions = Array.from(posSet).sort(function (a, b) { return a - b; });
    var columns = Array.from(colPos.keys())
      .sort(function (a, b) { return a - b; })
      .map(function (c) { return { col: c, pos: colPos.get(c) }; });
    var accs = Array.from(byAcc.values());

    // Apply the resolver's verdict. Rows it ruled out are dropped (so they do not vote in the
    // plurality tallies below); survivors carry their per-position verdict for colouring.
    var removed = (verdicts && verdicts.removed) || [];
    if (verdicts && verdicts.keep) {
      accs = accs.filter(function (a) { return verdicts.keep.has(a.uniprot_id); });
      accs.forEach(function (a) {
        var v = verdicts.byAcc && verdicts.byAcc[a.uniprot_id];
        if (v) a.verdict = v;
      });
    }

    // Per-position residue tallies (present cells only). counts[p][res] = how many rows
    // carry `res` at position p; present[p] = how many rows carry any residue there.
    var counts = {}, present = {}, consensus = {}, conserved = new Set();
    positions.forEach(function (p) {
      var c = {}, n = 0, best = null, bestN = 0;
      accs.forEach(function (a) {
        var res = a.cells[p];
        if (res == null) return;
        c[res] = (c[res] || 0) + 1; n++;
        if (c[res] > bestN) { bestN = c[res]; best = res; }
      });
      counts[p] = c; present[p] = n; consensus[p] = best;
      // Conserved = EVERY row present here AND all agree (a gap is a divergence).
      if (n === accs.length && bestN === n) conserved.add(p);
    });

    // Order rows by agreement with the plurality consensus (descending). Outliers sink.
    // Stable tie-break on uniprot_id keeps the order deterministic (no Math.random()).
    accs.forEach(function (a) {
      a._agree = positions.reduce(function (s, p) {
        return s + (a.cells[p] != null && a.cells[p] === consensus[p] ? 1 : 0);
      }, 0);
    });
    accs.sort(function (x, y) {
      return (y._agree - x._agree) || (x.uniprot_id < y.uniprot_id ? -1 : x.uniprot_id > y.uniprot_id ? 1 : 0);
    });
    accs.forEach(function (a) { delete a._agree; });

    // How many residues this row carries that the reference has no position for. Now derived from
    // the columns already in hand rather than from a second COUNT(*) query — the residues are here.
    accs.forEach(function (row) {
      var n = 0;
      for (var c in row.colCells) if (colPos.get(Number(c)) == null) n++;
      row.hidden = n;
    });

    // How many of the DISPLAYED rows carry a residue in each column. Counted here, after the
    // verdict filter, because the layout gate below asks whether the rows on screen disagree — and a
    // row the resolver ruled out is not on screen and must not cast a vote about what is disputed.
    columns.forEach(function (c) {
      var n = 0;
      for (var k = 0; k < accs.length; k++) if (accs[k].colCells[c.col] != null) n++;
      c.n = n;
    });

    return { coord: coord, positions: positions, columns: columns,
             display: layoutColumns(columns, accs.length), rows: accs, conserved: conserved,
             counts: counts, present: present, consensus: consensus, removed: removed };
  }

  // Columns → the list the grid actually draws, with long insertion runs collapsed. Pure, so the
  // layout rule is testable without a database.
  //
  // A gutter entry names the idea positions it sits BETWEEN (`after`/`before`, either of which is
  // null at a terminus) so the renderer can say where the residues went without inventing a number
  // for them. `cols` is kept so a hover can count what each row carries there.
  function layoutColumns(columns, nRows, maxExpand) {
    var cap = (maxExpand == null) ? INS_EXPAND_MAX : maxExpand;
    var out = [], i = 0;
    while (i < columns.length) {
      if (columns[i].pos != null) { out.push(columns[i]); i++; continue; }
      var j = i;
      while (j < columns.length && columns[j].pos == null) j++;
      if (j - i <= cap || !runIsDisputed(columns, i, j, nRows)) {
        out.push.apply(out, columns.slice(i, j));
      }
      else out.push({ gutter: true, pos: null,
                      cols: columns.slice(i, j).map(function (c) { return c.col; }),
                      after:  i > 0 ? columns[i - 1].pos : null,
                      before: j < columns.length ? columns[j].pos : null });
      i = j;
    }
    return out;
  }

  // Query residues on the coordinate → pivot. Browser (DuckDB).
  //
  // The accession SET is no longer resolved here. It is whatever `materialize3` returned for this
  // query in this context (spec D2.1) — there is one source, and this module is not it. The old
  // `alignmentAccessions()` ran its own `SELECT DISTINCT uniprot_id WHERE family = $1`, which was a
  // second, differently-derived candidate list that then had to be filtered by a second,
  // differently-implemented possibility check.
  // ── the extent's own mass ────────────────────────────────────────────────────────────────────
  // A SEGMENT IS AN EXTENT, so `H3[1-30]` is a thirty-residue peptide and `H3[1-30][40-60]` is an
  // internal-deletion construct whose mass is |1-30| + |40-60|. The pane showed the full-chain mass
  // from protein_masses in both cases — the mass of a molecule the notation had just said it is not,
  // with nothing on screen to say so.
  //
  // Summed in SQL from the residues rather than inferred from the rendered grid, because the grid
  // shows one chunk at a time and drops out-of-frame residues; a mass assembled from what happens to
  // be on screen would be a different number for the same molecule depending on scroll position.
  //
  // A SEGMENT IDENTIFIES ITS COLUMNS (R12, 2026-08-03), and that is what makes the arithmetic right.
  //
  // `H2A.Z[1-20]` means H2A.Z's own 1–20, and its K4/A5/G6 sit in the KAG insertion. Summed on
  // `family_position` those three fall out — they have none — so a 20-residue peptide weighed 19
  // residues' worth, and the 19 were not even a prefix of it, since `family_position BETWEEN 1 AND
  // 20` reaches H2A.Z's own 21 and 22. The frame rule fixed that by switching the COLUMN NAME to
  // `variant_position` whenever the token translated; R12 says the endpoints identify columns in
  // the canonical member of the TOKEN'S OWN subtree, so the bounds are resolved once, here, and
  // every row is filtered on `aln_column` — the one coordinate every molecule in the grid shares.
  //
  // An insertion column is inside the range by construction, which is the whole difference: it needs
  // no counterpart in anything to be between two columns. `H2A.Z[1-20]` is AGGKAGKDSGKAKTKAVSRS,
  // 1904.16 u average / 1903.06 u monoisotopic.
  //
  // Falls back to `coord` when the endpoints cannot be resolved to columns — the frameless branch,
  // where each row is in its own numbering and an extent must stay there.
  function segmentWhere(segments, coord, refAcc) {
    var reg = registry();
    var col = function (p) {
      if (refAcc == null || !reg || !reg.colAt || typeof p !== 'number') return null;
      return reg.colAt(refAcc, p);
    };
    var terms = [];
    var okAll = true;
    (segments || []).forEach(function (s) {
      var lo = s.start === '-inf' ? null : s.start, hi = s.end === '+inf' ? null : s.end;
      if (lo == null && hi == null) { terms.push('TRUE'); return; }
      var cl = lo == null ? null : col(lo), ch = hi == null ? null : col(hi);
      if ((lo != null && cl == null) || (hi != null && ch == null)) { okAll = false; return; }
      if (lo == null) terms.push('aln_column <= ' + Number(ch));
      else if (hi == null) terms.push('aln_column >= ' + Number(cl));
      else terms.push('(aln_column BETWEEN ' + Number(cl) + ' AND ' + Number(ch) + ')');
    });
    if (okAll && terms.length) return '(' + terms.join(' OR ') + ')';
    return segmentWhereOn(segments, coord);
  }
  // The pre-column form, kept for the frameless branch alone: each row in its own numbering, no
  // shared column to bound.
  function segmentWhereOn(segments, coord) {

    var terms = [];
    (segments || []).forEach(function (s) {
      var lo = s.start === '-inf' ? null : s.start, hi = s.end === '+inf' ? null : s.end;
      if (lo == null && hi == null) terms.push('TRUE');
      else if (lo == null) terms.push(coord + ' <= ' + Number(hi));
      else if (hi == null) terms.push(coord + ' >= ' + Number(lo));
      else terms.push('(' + coord + ' BETWEEN ' + Number(lo) + ' AND ' + Number(hi) + ')');
    });
    return terms.length ? '(' + terms.join(' OR ') + ')' : null;
  }

  // The engine's. This was a second copy, byte-identical but for the quote style, and shell.js used
  // THIS one while interpret2 used the other — so the page and the engine could have disagreed about
  // what "the whole chain" means without either noticing (census §2, 2026-08-05). Still exported: it
  // is the only pure part of this module and its own suite drives it.
  function isWholeChain(segments) {
    const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.isWholeChain !== 'function')
      throw new Error('isWholeChain unavailable — load build/parser2.js first');
    return P.isWholeChain(segments);
  }

  // ── where a mark sits, for the mass arithmetic ──────────────────────────────────────────────────
  // Pure: it does not know any masses. It answers the one question the per-material mass loop has to
  // get right before it can look anything up — WHICH residue this mark applies to in THIS material,
  // and whether the material has that place at all.
  //
  // A TERMINAL SITE IS NOT A RESIDUE POSITION. α/ω attach to the chain's α-amino / α-carboxyl group,
  // which every chain has whatever its sequence — which is exactly why the engine asks the terminal
  // SITE table instead of side-chain chemistry, and why `ptm_deltas` is keyed by the PTM token alone
  // with no residue column. The mass loop nonetheless looked the mark's position up in the row's
  // residue cells; for the sentinel `"-inf"` that is a miss, and a miss was filed as a GAP — the
  // delta silently dropped and a chip printed reading `-infac`. `H4[1-1]:aac` therefore showed the
  // mass of free serine, 105.09 u, for a molecule that is N-acetyl-serine at 147.13 u.
  //
  // A gap is a real answer for a SIDE-CHAIN mark (this material has nothing at that position, so the
  // mark cannot apply and no number should be invented). It is never the answer for a terminal one:
  // the only way to lack a terminus is to have no residues at all, which the empty-extent branch
  // already reports on its own.
  // `labelPos` is the number to PRINT, when it differs from the number to LOOK UP. Cells are keyed by
  // idea position — that is what makes the grid's columns comparable across materials — but a chip
  // sits next to a material handle, and a number after a material handle is read in that molecule's
  // own numbering. Siting and labelling are therefore two different coordinates for the same mark, and
  // conflating them is what printed `H2B2:K120ub` for a molecule carrying K123. Omitted → unchanged.
  // `sitePos` is the key to LOOK UP IN, when it differs from `mod.position` — a third coordinate,
  // and the reason there are three is that the caller may hold the mark's ALIGNMENT COLUMN while
  // `cells` is keyed by idea position. A column the family's canonical member does not occupy has
  // no idea position at all, so an idea-axis lookup there cannot hit and files a placeable mark as
  // a gap. `H2A:S139ph` walks to column 177, which H2A has no `family_position` for: every H2A.X
  // row lost its phospho Δ and its mark. The caller passes `colCells` with the column, exactly as
  // the grid renderer does for an insertion column. Omitted → `mod.position`, unchanged.
  function markSite(mod, cells, labelPos, sitePos) {
    var p = mod && mod.position;
    if (p === '-inf' || p === '+inf')
      return { terminal: true, residue: null, gap: false, label: p === '-inf' ? 'α' : 'ω' };
    var look = (sitePos === undefined) ? p : sitePos;
    var actual = (cells && look != null) ? cells[look] : null;
    if (actual === undefined) actual = null;
    return { terminal: false, residue: actual, gap: actual == null,
             label: String(labelPos == null ? p : labelPos) };
  }

  // WHICH MATERIAL'S NUMBERING DOES THE RULER PRINT? (BB, 2026-07-29)
  //
  // Not the canonical leader. `accessions` arrives ordered by `realize()` — n_gene_loci DESC — so the
  // leader is whichever protein the most gene copies encode. That is a good answer to "which material
  // stands for this idea" and the WRONG criterion for a ruler, because gene abundance says nothing
  // about numbering. Mouse H3 showed the cost: P84228 (H3.2) has 8 loci and leads, and it is also the
  // one mouse H3 whose UniProt record carries no initiator-Met-removed annotation, so its own
  // numbering runs +1. The ruler was drawn in that frame and H31, H33 and H3C — the three rows
  // numbered the way every H3 paper numbers them — were each tagged as deviating by -1. Four rows
  // marked wrong so the outlier could be right.
  //
  // So: group the displayed accessions by FRAME and label in the largest group's. The display rule is
  // unchanged (Result 4 — a ruler shows a real material's own numbering); it is now a material the
  // majority agrees with. Ties keep the canonical order, so on any card whose rows share a frame —
  // every same-species card — the pick is exactly what it was.
  function pickRulerFrame(accessions, positions, registry) {
    var accs = accessions || [];
    if (!accs.length) return null;
    if (!registry || !registry.materialPos) return accs[0];
    var frameKey = function (a) {
      var parts = [];
      for (var i = 0; i < (positions || []).length; i++) {
        var p = positions[i], own = registry.materialPos(a, p);
        if (own != null) parts.push(own - p);
      }
      return parts.join(',');
    };
    var groups = new Map();
    for (var j = 0; j < accs.length; j++) {
      var k = frameKey(accs[j]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(accs[j]);
    }
    var best = null;
    groups.forEach(function (members) {
      // `accs` is in canonical order, so members[0] is the canonical pick within its group, and a
      // strict `>` leaves the first-seen (highest-ranked) group winning a tie.
      if (!best || members.length > best.length) best = members;
    });
    return (best && best[0]) || accs[0];
  }

  // ── the grid is cached on everything that shapes it ─────────────────────────────────────────────
  // `resolvedAlignment` runs three to four DuckDB queries, and `renderMaterials` calls it once per
  // CARD — so a tile click re-ran all of them for every material, every time, with nothing keyed.
  // The parquet does not change at runtime, so the same inputs give the same grid forever.
  //
  // The key has to be everything the model depends on, and `verdicts` is the one that is easy to
  // miss: it is not merely displayed, it FILTERS the rows (`buildAlignmentModel` drops accessions
  // outside `keep` and stamps per-position warn state). A cache keyed on the accession list alone
  // would serve a grid built under a different set of physical-possibility verdicts — the same class
  // of bug as a card key that omits its extent, one layer down.
  //
  // `taxon` is deliberately absent: it is an unused parameter of this function (the accession set
  // already carries the species), so keying on it would only fragment the cache.
  var _alnCache = (typeof Map === "function") ? new Map() : null;
  var ALN_CACHE_CAP = 80;

  function segCacheKey(segments) {
    return (segments || []).map(function (x) { return x.start + "-" + x.end + ":" + x.certainty; }).join(",");
  }
  function verdictCacheKey(v) {
    if (!v) return "";
    var keep = v.keep ? Array.from(v.keep).sort().join(",") : "";
    var byAcc = v.byAcc ? Object.keys(v.byAcc).sort().map(function (a) {
      var e = v.byAcc[a] || {};
      return a + ":" + (e.state || "") + ":" + Object.keys(e.byCol || {}).sort().join(".");
    }).join(";") : "";
    var removed = (v.removed || []).map(function (r) {
      return (r.accession || "") + ":" + (r.reason || "") + ":" + (r.position == null ? "" : r.position);
    }).sort().join(";");
    return keep + "|" + byAcc + "|" + removed;
  }

  // `frame` is the QUERY'S frame — `frameOf` of the card's proteoform, the only sanctioned way to
  // learn what numbering its positions are stated in. It is a separate argument from `variant`
  // because the two answer different questions: `variant` is the token to DISPLAY (and it can be a
  // compound spelling of a set), `frame` is the tree head whose numbering the marks and the extent
  // are written in. Omitted → the family frame, which is every caller that predates the frame rule.
  async function resolvedAlignment(family, variant, taxon, accessions, verdicts, segments, frame) {
    var coord = alignmentCoord();
    if (!accessions || accessions.length === 0)
      return { coord: coord, positions: [], rows: [], conserved: new Set(), removed: [], unframed: [],
               frame: frame };

    var cacheKey = null;
    if (_alnCache) {
      cacheKey = [family, variant == null ? "" : variant, coord,
                  accessions.slice().sort().join(","), segCacheKey(segments),
                  verdictCacheKey(verdicts)].join("\u001f");
      if (_alnCache.has(cacheKey)) {
        var cached = _alnCache.get(cacheKey);
        // `sequenceOrder` is a side effect of building the grid, read later by the per-material mass
        // and AM tables so their rows match the grid's order. A cache hit must re-assert it: the
        // stored value is keyed by family|variant only, so an intervening card of the same family
        // with a different accession set would otherwise leave it pointing at that one.
        _seqOrder[_orderKey(family, variant)] = cached.rows.map(function (r) { return r.uniprot_id; });
        return cached;
      }
    }

    // THE PANE MUST SHOW WHAT THE RESOLVER KEPT. Some accessions have no alignment to their family
    // reference at all — NONE today. This list used to read "H2B.W, H2A.L, H2A.P, non-human
    // CENP-A, and every H1"; H1 gained a family reference (P10412) on 2026-07-28 and the family MSA
    // placed the divergent variants. The last two members were Q5SSJ5 and Q149N8, the curated
    // non-histones, and on 2026-08-15 `action: exclude` widened to withhold their classification, so
    // they are no longer in the artifact to be partitioned. The branch is dead but still correct —
    // it describes a property of the DATA, and one unalignable sequence repopulates it. `family_position` is
    // NULL for every residue, so a grid query filtered on it returned nothing and the card rendered
    // empty, contradicting a walk that had ruled out nothing. An empty card reads as "no
    // such sequence", which is a different and false claim.
    //
    // These sequences exist and can be shown; what is unavailable is the CORRESPONDENCE between
    // them and the reference. So they are partitioned out (synchronously, via the same `hasFrame`
    // the resolver uses — no extra query), and either shown on their own numbering when nothing in
    // the set has a frame, or listed alongside the grid when only some lack one. Mixing the two
    // coordinates in one grid is not an option: the columns would not mean anything.
    var reg = registry();
    var canFrame = function (a) { return !reg || !reg.hasColumns || reg.hasColumns(a); };
    var framed = accessions.filter(canFrame);
    var unframed = accessions.filter(function (a) { return !canFrame(a); });
    var frameless = framed.length === 0;                 // nothing in the set shares a frame
    if (frameless) coord = 'protein_position';
    accessions = frameless ? unframed : framed;

    var conn = await dbConnect();
    try {
      var ph = accessions.map(function (_, i) { return '$' + (i + 1); }).join(', ');
      // ONE query for the whole grid. Out-of-frame residues used to need a second (`hsql`) because
      // the first filtered them away with `coord IS NOT NULL`; keying on `aln_column` admits them,
      // so the counts, the residues and their material positions all arrive together and cannot
      // disagree. `own` is the material position, needed for the ruler over an insertion column and
      // for the per-residue readout.
      //
      // The frameless branch has no MSA column to key on (that is what frameless MEANS here), so it
      // asks for the coordinate alone and every position is its own column.
      var sql =
        "SELECT uniprot_id, protein_name, uniprot_name, species, variant, " +
        (frameless ? "NULL AS col, " : "aln_column AS col, ") +
        coord + " AS pos, protein_position AS own, residue " +
        "FROM read_parquet('" + PROTEINS_URL + "') " +
        "WHERE uniprot_id IN (" + ph + ") AND protein_position >= 1 AND " +
        (frameless ? coord + " IS NOT NULL" : "aln_column IS NOT NULL") + " " +
        "ORDER BY uniprot_id, protein_position";
      var stmt = await conn.prepare(sql);
      var rows = (await stmt.query.apply(stmt, accessions)).toArray().map(function (r) { return r.toJSON(); });
      await stmt.close();
      var model = buildAlignmentModel(rows, coord, verdicts);
      // The frame travels WITH the grid, because a column number means nothing without it. The
      // renderer stamps it on the grid so a datum row from a differently-framed source cannot
      // silently address a column by a number that means something else there.
      model.frame = frame;

      // (The second query that used to live here — a COUNT/string_agg over `coord IS NULL` — is
      // gone. It existed only because the main query could not see out-of-frame residues; now that
      // the grid is keyed on `aln_column` they arrive with everything else, and `row.hidden` is
      // counted from them in the pivot. One fewer round trip per card, and the count can no longer
      // disagree with the residues it counts.)

      // Base MW per accession (protein_masses.parquet) for the per-material mass table.
      // Query-dependent deltas are computed downstream against each row's OWN residue.
      var bsql =
        "SELECT uniprot_id, average_mass, monoisotopic_mass, complete " +
        "FROM read_parquet('" + PROTEIN_MASSES_URL + "') WHERE uniprot_id IN (" + ph + ")";
      var bstmt = await conn.prepare(bsql);
      var base = {};
      (await bstmt.query.apply(bstmt, accessions)).toArray().forEach(function (r) {
        var o = r.toJSON(); base[o.uniprot_id] = o;
      });
      await bstmt.close();
      model.rows.forEach(function (row) {
        var b = base[row.uniprot_id];
        row.baseAvg  = b ? b.average_mass : null;
        row.baseMono = b ? b.monoisotopic_mass : null;
        row.massComplete = b ? !!b.complete : false;
        // NO ROW is a different fact from an incomplete one, and only this line can still tell them
        // apart: protein_masses stores NA for both. `complete = FALSE` is the deliberate refusal for a
        // non-standard residue; a missing row means protein_masses is STALE with respect to
        // proteins.parquet. That is a build fault, and it read as chemistry for the four S. cerevisiae
        // accessions added after the table was last regenerated (BB, 2026-07-28).
        row.massKnown = !!b;
      });

      // The stated extent's mass, when the query states one. Residue sum + one water (the same
      // arithmetic protein_masses uses for a whole chain), so a truncated construct and a full one
      // are computed the same way and are directly comparable.
      model.extent = null;
      if (!isWholeChain(segments)) {
        // R12: the endpoints are read in the canonical member of the TOKEN'S OWN subtree, so
        // `H2A.X[130-140]` resolves in canonical human H2A.X where canonical H2A has no residue at
        // all. `printRefOf` is that member, and it falls back to the family's canonical one.
        var refAcc = (reg && reg.printRefOf) ? reg.printRefOf(frame || variant || family, family) : null;
        var where = segmentWhere(segments, coord, frameless ? null : refAcc);
        if (where) {
          // ONE statement, not two. The water mass is a single constant row, and fetching it with a
          // second prepare/query/close per CARD doubled the round trips this path adds — measurable
          // as a sluggish world selection on any query that states an extent, since every card
          // re-runs this. CROSS JOIN folds it into the sum where it belongs.
          var esql =
            "SELECT p.uniprot_id, SUM(r.average) + ANY_VALUE(w.average) AS avg_sum, " +
            "SUM(r.monoisotopic) + ANY_VALUE(w.monoisotopic) AS mono_sum, COUNT(*) AS n " +
            "FROM read_parquet('" + PROTEINS_URL + "') p " +
            "JOIN read_parquet('" + MASSES_URL + "') r ON r.residue = p.residue " +
            "CROSS JOIN read_parquet('" + WATER_URL + "') w " +
            "WHERE p.uniprot_id IN (" + ph + ") AND p.protein_position >= 1 AND " + where + " " +
            "GROUP BY p.uniprot_id";
          var estmt = await conn.prepare(esql);
          var ext = {};
          (await estmt.query.apply(estmt, accessions)).toArray().forEach(function (r) {
            var o = r.toJSON(); ext[o.uniprot_id] = o;
          });
          await estmt.close();
          model.rows.forEach(function (row) {
            var e = ext[row.uniprot_id];
            // No residues in the extent is not zero mass — it is "this material has nothing there",
            // which the caller must be able to tell apart from a small peptide.
            row.extentAvg  = e && Number(e.n) ? Number(e.avg_sum) : null;
            row.extentMono = e && Number(e.n) ? Number(e.mono_sum) : null;
            row.extentN    = e ? Number(e.n) : 0;
          });
          model.extent = { segments: segments.map(function (x) { return Object.assign({}, x); }), coord: coord };
        }
      }
      // DISPLAY NUMBERING (Result 4). Columns are idea positions because that is what makes the
      // rows comparable — but a NUMBER is context-relative, and this pane is showing a particular
      // organism's material. Ruling a yeast H2B on the human reference prints "120" over its K123:
      // correct as a class name, wrong as a fact about the molecule on screen. So the ruler is
      // labelled in the REPRESENTATIVE material's own numbering (the canonical pick, which leads
      // `accessions`), and the meta line says whose numbering it is whenever that differs from the
      // reference. Cells, marks and drift stay keyed by idea position — only the LABELS change.
      //
      // THE RULER FOLLOWS THE NUMBERING MOST ROWS SHARE, not the most abundant gene (BB, 2026-07-29).
      // `accessions` is ordered by `realize()` — n_gene_loci DESC — so the leader is whichever protein
      // the most gene copies encode. That is a fine canonical pick for "which material stands for this
      // idea", and the WRONG criterion for a ruler, because gene abundance says nothing about
      // numbering. Mouse H3 showed the cost: P84228 (H3.2) has 8 loci and leads, and it is also the
      // one mouse H3 whose UniProt record lacks the initiator-Met-removed annotation, so its own
      // numbering runs +1. The ruler was drawn in that frame and H31, H33 and H3C — the three rows
      // numbered the way every H3 paper numbers them — were each tagged as deviating by −1. Four rows
      // marked wrong so the outlier could be right.
      //
      // Grouping by FRAME and taking the largest group fixes it without changing the display rule: the
      // ruler still shows a real material's own numbering (Result 4 stands), it is just a material the
      // majority agrees with. Ties keep the canonical order, so where every row shares a frame — which
      // is every same-species card — the pick is exactly what it was.
      var present = accessions.filter(function (a) {
        return model.rows.some(function (r) { return r.uniprot_id === a; });
      });
      if (!present.length && model.rows[0]) present = [model.rows[0].uniprot_id];
      var rep = pickRulerFrame(present, model.positions, reg)
             || (model.rows[0] && model.rows[0].uniprot_id);
      model.numbering = null;
      var repRow = model.rows.find(function (r) { return r.uniprot_id === rep; });
      if (rep && reg && reg.materialPos) {
        var map = new Map(), shifted = false;
        model.positions.forEach(function (p) {
          var own = reg.materialPos(rep, p);
          if (own != null) { map.set(p, own); if (own !== p) shifted = true; }
        });
        // THE RULER OVER AN INSERTION COLUMN comes from the rep's own residue there, not from
        // `materialPos` — which is built from `family_position` and so, correctly, knows nothing
        // about a column that has none. Where the rep carries the insertion the printed numbers run
        // contiguously across it, which is how that molecule's own paper draws them; where it does
        // not, `colMap` has no entry and `alignmentRuler` already prints a blank. A fractional label
        // would be the alternative and it would be an invented number.
        var colMap = new Map();
        if (repRow) model.columns.forEach(function (c) {
          var own = repRow.ownAt[c.col];
          if (own != null) colMap.set(c.col, own);
        });
        model.numbering = { uniprot_id: rep, map: map, colMap: colMap, shifted: shifted,
                            name: repRow && (repRow.name || repRow.uniprotName),
                            species: repRow && repRow.species };
      }

      // WHICH ROWS ARE NUMBERED DIFFERENTLY — AS A BOOLEAN, BECAUSE THE NUMBER WAS A LIE
      // (BB, 2026-07-31).
      //
      // Alignment deliberately HIDES a numbering shift — that is what aligning is for — so a row
      // whose own numbering runs +1 sits in the same columns as everything else and is unfindable by
      // eye. That fact is worth surfacing; the SUPERSCRIPT that surfaced it was not, because it took
      // the offset at the FIRST position where the two frames part and printed it as though it were
      // constant. It is not constant. Human H2A.Z.1 runs −1 over three residues, then +2 over 64,
      // then +3 over 56 — the tag said "−1", true of 3 residues out of 123. Across the H2A.Z clade
      // every one of 9 rows has three or more distinct offsets; across H1, 37 of 39 rows do, one of
      // them with thirteen. A single number cannot state a piecewise fact, and the reader has no way
      // to tell a row where it happens to be constant from one where it is not.
      //
      // So the row carries a BOOLEAN — exactly as informative as it can honestly be at a glance —
      // and the per-residue number moves to the readout, where it varies per residue as the fact
      // does. `frames` is how many distinct offsets there are, which is what the marker's hover says
      // instead of pretending to name one of them.
      if (model.numbering && model.numbering.colMap.size) {
        var ruler = model.numbering.colMap;
        model.rows.forEach(function (row) {
          var offs = {}, n = 0;
          model.columns.forEach(function (c) {
            var own = row.ownAt[c.col], shown = ruler.get(c.col);
            if (own == null || shown == null) return;
            if (!offs[own - shown]) { offs[own - shown] = true; n++; }
          });
          row.ownFrames = n;
          row.ownShifted = !(n === 1 && offs[0]);
          if (n === 0) row.ownShifted = false;   // shares no column with the ruler: nothing to say
        });
      }

      // Sequences the reference cannot speak for. `frameless` says the WHOLE grid is on each
      // material's own numbering, so no column means a correspondence.
      model.unframed = frameless ? [] : unframed.slice();
      model.frameless = frameless;
      // Record the row order for this slot so the layer tables can follow the sequences.
      _seqOrder[_orderKey(family, variant)] = model.rows.map(function (r) { return r.uniprot_id; });
      if (_alnCache && cacheKey != null) {
        // Cleared wholesale rather than evicted one at a time — a grid is large, the working set is
        // one query's worth of cards, and an LRU here would be bookkeeping for no benefit.
        if (_alnCache.size >= ALN_CACHE_CAP) _alnCache.clear();
        _alnCache.set(cacheKey, model);
      }
      return model;
    } finally { await conn.close(); }
  }

  // ── THE PER-RESIDUE READOUT ─────────────────────────────────────────────────────────────────────
  //
  // What a cell says when you point at it. Pure, so the WORDING is testable in Node rather than
  // living inside a DOM handler — the prose is the product here, not the plumbing.
  //
  // It always leads with a MATERIAL handle and that molecule's OWN number, never a bare integer:
  // §8's "a datum keeps its own numbering" and "handle and numbering are ONE decision". So the lead
  // token is valid notation for this molecule — selectable, pasteable, and landing back on exactly
  // this material, the same promise `materialCell` makes. The aligned position follows as context,
  // because it is the thing that is shared and therefore the thing that is NOT about this molecule.
  //
  // `handle` should come from `emitMaterial` where the caller can get one; this function does not
  // reach for the registry itself, because it must also answer for an insertion column, which
  // `emitMaterial` refuses by contract (no idea position → no mark to renumber). That refusal is
  // right and it is why the handle is a parameter.
  //
  // ── ONE INSTRUMENT PER QUESTION (BB, 2026-07-31) ────────────────────────────────────────────────
  //
  // The readout and the per-cell `title` had grown into two answers to the same question, delivered
  // by the same gesture: point at an insertion and the status line said "an insertion — no aligned
  // position" while, half a second later, a native popup said the same thing at greater length and
  // over the top of the columns being compared. Two instruments, one job, and the slower of them
  // occluding the grid.
  //
  // The split is by SUBJECT, not by wording:
  //
  //   the readout   answers everything about the CELL under the pointer — which residue this is, in
  //                 whose numbering, at which aligned position, and every reason it is shaded the way
  //                 it is. Immediate, one reserved line below the grid, never covering anything.
  //   a `title`     is left only where the subject is NOT a cell and the readout therefore cannot
  //                 speak: the row label (full protein name, species, accession), the `°` marker
  //                 (a property of the whole row), and the meta-line chips (properties of the grid).
  //
  // So every per-cell `title` is gone — the identity ones as duplicates, the state ones because
  // state is a fact about the cell and belongs where the cell's facts are. That also retires the
  // DOM-weight worry those titles were rationed against: a four-family card is ~6,600 cells, and
  // none of them now carries prose.
  //
  //   s = { handle, residue, own, pos, insertion, gap, outside, extentLabel, carriedBy, ofRows,
  //         state: 'mod' | 'warn', drift: {from, to}, run: {n, after, before} }
  function readoutFor(s) {
    if (!s || !s.handle) return '';

    // A COLLAPSED RUN is not a residue, so it does not get the identity lead — the honest answer to
    // "which residue is this" is "several, and they are not drawn". It says how many and where.
    if (s.run) {
      var where = (s.run.after != null && s.run.before != null)
        ? 'between aligned positions ' + s.run.after + ' and ' + s.run.before
        : (s.run.after == null ? 'before aligned position ' + s.run.before
                               : 'after aligned position ' + s.run.after);
      if (!s.run.n)
        return s.handle + ' does not carry the insertion ' + where;
      return s.handle + ' · ' + s.run.n + ' inserted residue' + (s.run.n !== 1 ? 's' : '') + ' '
           + where + ', not drawn out';
    }

    var at = (s.own == null) ? '' : (s.residue ? s.residue + s.own : String(s.own));
    var head;
    if (s.gap) {
      head = s.insertion
        ? s.handle + ' has no residue here — this column is an insertion carried by '
          + s.carriedBy + ' of ' + s.ofRows + ' sequences'
        : s.handle + ' has no residue at aligned position ' + s.pos;
      // A gap has no residue, so no residue-level state can apply to it. Return before the clauses.
      return head;
    }
    if (s.insertion) {
      head = s.handle + ':' + at + ' · an insertion — no aligned position';
      // A stated extent is written in the idea frame, so it can neither include nor exclude a
      // residue that has no idea position. Saying so beats dimming the cell (which would assert the
      // residue is not part of the molecule) and beats silence (which would assert the opposite).
      if (s.extentLabel) head += ' — the stated extent does not reach it';
    } else {
      head = s.handle + ':' + at + ' · aligned position ' + s.pos;
      if (s.outside)
        head += ' · outside the stated extent' + (s.extentLabel ? ' ' + s.extentLabel : '');
    }

    // The shading, explained on the instrument that reports the cell. "Modified residue", not "your
    // mark": on a ported grid the position was not put there by this reader, and what the cell names
    // is a property of the molecule rather than of the query.
    var parts = [];
    if (s.state === 'warn')
      parts.push('modified residue — but this material has a different wild-type here, '
               + 'so the residue the query stated disagrees with it');
    else if (s.state === 'mod') parts.push('modified residue');
    if (s.drift && s.drift.from && s.drift.to)
      parts.push('baseline drift — ' + s.drift.from + ' in the source material, '
               + s.drift.to + ' in the target');
    return parts.length ? head + ' · ' + parts.join(' · ') : head;
  }

  // segmentWhere / isWholeChain are exported for their own tests: they are the only pure part of
  // the extent path, and the SQL around them cannot run in Node.
  var api = { alignmentCoord: alignmentCoord, buildAlignmentModel: buildAlignmentModel,
              resolvedAlignment: resolvedAlignment, sequenceOrder: sequenceOrder,
              segmentWhere: segmentWhere, isWholeChain: isWholeChain, markSite: markSite,
              pickRulerFrame: pickRulerFrame, layoutColumns: layoutColumns, readoutFor: readoutFor,
              // Exported for tests and for anything that invalidates on a data reload.
              clearAlignmentCache: function () { if (_alnCache) _alnCache.clear(); },
              alignmentCacheSize: function () { return _alnCache ? _alnCache.size : 0; },
              verdictCacheKey: verdictCacheKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/further-reading-model.js
// The "Further reading" box: which papers a query should point at, and in what order.
//
// RELEVANCE IS COMPUTED, NOT ENUMERATED [BB 2026-08-16]. A query `({H3:K27M})` reaches a datum
// `({H3.1:K27M})` through the meet, so the index records what was investigated as precisely as
// known and never guesses which questions a paper might answer. Measured:
//
//   entails2( ({H3.1:K27M}) , ({H3:K27M}) ) = true    a specific datum answers a general query
//   entails2( ({H3:K27M})   , ({H3})      ) = true
//   entails2( ({H3:K27M})   , H3:K27M     ) = false   asking about the free histone is a DIFFERENT
//                                                     question, and a nucleosome does not answer it
//
// THAT LAST LINE IS STILL TRUE OF THE MEET, AND NO LONGER DESCRIBES THIS BOX [BB 2026-08-30].
// Relevance here is `reach2`, which is the meet applied at every rung of the containment ladder and
// unioned. `entails2` keeps its refusal — the member axis is a type boundary and a nucleosome really
// is not a free histone — but reach asks a different question: not "are these the same thing" but
// "is this datum worth showing". So `({H3:K27M})` now reaches an `H3:K27M` query at RUNG 1, by
// decomposing the DATUM, and `H3:K27M` reaches an `({H3:K27M})` query at rung 1 by decomposing the
// QUERY. Rung 0 is still exactly the `entails2` above, so nothing this box used to show can vanish.
//
// THE MEET RUNS OVER DISTINCT DESCRIPTORS, NOT OVER MENTIONS. There are 38,713 mentions and 445
// distinct descriptors, so relevance costs 445 `entails2` calls and then one SQL `IN`. Folding the
// meet into the row scan would be ~87x the work for the same answer.
//
// Pure in the sense that matters: no DOM reference, and the engine arrives through `host`. A name
// DECLARED in shell.js is not a global (docs/CLAUDE.md) — everything here comes from `host` first
// and the global scope second, and the global fallback is for `Object.assign` modules only.
(function (root) {
  'use strict';

  // Sorted weakest to strongest, matching papers/index/scripts/substrate.js. A reader can drop to the rung
  // they trust; `rule` is deliberately the weakest because its precision is 0-errors-in-33, which is
  // an upper bound of ~9% error, not a guarantee.
  const CERTAINTY_ORDER = ['rule', 'agent', 'agent-verified', 'human'];

  // SELECTIVITY IS WILDLY UNEVEN, AND THE THRESHOLD IS MEASURED, NOT CHOSEN. Over the 540
  // descriptors the two tables actually hold: p50 = 2 papers, p75 = 5, p90 = 37, p95 = 223,
  // p99 = 1,414. The head is enormous — H2A.X 7,416, H3:K27me3 6,350, H3:K4me3 4,528.
  //
  // At 50 papers, 91.1% of queries render COMPLETELY; the gains flatten after (100 -> 93.1%,
  // 200 -> 94.6%), so 50 is the knee and not a round number. Past it a table is the wrong answer
  // and the box must SAY SO rather than quietly showing the first screenful — a truncation the
  // reader cannot see reads as "this is the literature".
  const FIT_MAX = 50;
  const TRUNCATED_ROWS = 20;

  // The data-availability filter [BB 2026-08-16]. Four states, and the SQL for each lives here so
  // the count and the rows can never disagree about what a state means.
  //
  //   all         no filter
  //   systematic  the paper has bulk data somewhere — YES (in the paper) or CONTACT (deposited)
  //   imported    we have already ingested it: container_id is set. Real, and currently EMPTY —
  //               data/ containers carry `citation: source:` free text and no PMID, so nothing joins
  //               yet. The count is shown so an empty state reads as "none yet" and not as a bug.
  //   unassessed  nobody has read the paper. NOT the same as NO, which is a judgement that there is
  //               no systematic data.
  const FILTERS = [
    { key: 'all',        label: 'All',             where: null },
    { key: 'systematic', label: 'Systematic data',  where: "p.import_verdict IN ('YES','CONTACT')" },
    { key: 'imported',   label: 'Imported',         where: 'p.container_id IS NOT NULL' },
    { key: 'unassessed', label: 'Not assessed',     where: "p.import_verdict = 'not-assessed'" },
  ];
  const filterWhere = (key) => (FILTERS.find(f => f.key === key) || FILTERS[0]).where;

  function createFurtherReading(host) {
    host = host || {};
    const dep = (name) => (host[name] !== undefined ? host[name] : root[name]);
    const engine = () => dep('nucleosomeParser2');

    // `performance.now` where it exists (the page, and node ≥16), `Date.now` otherwise. Only ever
    // read as a difference, so the epoch does not matter.
    const now = () => ((root.performance && typeof root.performance.now === 'function')
                       ? root.performance.now() : Date.now());

    // Memoised per instance, not per module: two instances start clean, which is what lets a suite
    // assert a memo key matters without reaching into a private Map.
    const relevanceMemo = new Map();

    // ONE IR PER DESCRIPTOR, FOR THE LIFE OF THE INSTANCE — and the saving is not the parse.
    //
    // A descriptor is an immutable string from a shipped table, so re-deriving its IR can only
    // produce the same node; every query was re-parsing all ~470 survivors from scratch. Measured on
    // `({H3:K27M})` over the shipped universe: 703ms of the 3,002ms total was parse+resolve.
    //
    // THE NODE IDENTITY IS THE BIGGER HALF. `reach2` memoises on the NODE (`compMemo` is a WeakMap,
    // and so are the walk and marks memos underneath it), so freshly-parsed nodes could never hit
    // across queries — the same measurement, run twice against the same IR objects, costs 2,299ms
    // then 1,746ms. `relevance2.js` records exactly this failure on the QUERY side ("each one is a
    // FRESH OBJECT, so walkMemo, marksMemo and this map — all keyed on node identity — could never
    // hit"); the datum side had it too, once per query rather than once per datum.
    //
    // Bounded by the universe (3,686), and a parse FAILURE is cached as null, which is the answer.
    const irMemo = new Map();
    function irOf(descriptor) {
      const P = engine();
      if (!P) return null;
      if (irMemo.has(descriptor)) return irMemo.get(descriptor);
      let n = null;
      try { n = P.resolve2(P.lift2(P.parse(descriptor))); } catch { n = null; }
      irMemo.set(descriptor, n);
      return n;
    }

    // ── THE FAST PREFILTER ───────────────────────────────────────────────────────────────────────
    // Measured before building it: 540 meets per query cost 274ms for `H3:K4me3` and 3,432ms for
    // `({H3:K27M})`. The measurement layer already solved this shape — glyph_mask is precomputed at
    // ingestion so query time is a set intersection — and this is that pattern for descriptors.
    //
    // The key is `family:column`, never a bare column: H3's 222 and H4's 222 are different places.
    //
    // SOUND, not merely fast. It keeps d when d's keys ⊇ q's keys, which cannot drop a true match:
    // `entails2(d, q)` means d is at least as SPECIFIC as q, so a datum carrying q's marks carries
    // q's columns too. A datum with fewer marks cannot entail a query with more.
    //
    // WHEN THE QUERY HAS NO COLUMNS the prefilter STANDS DOWN and everything is evaluated — a bare
    // variant (`H2A.Z`) or a family-only particle (`({H3})`) has nothing to intersect on, and
    // filtering against an empty key set would return nothing and read as "no literature".
    let keyIndex = null;                       // descriptor -> key array, from the shipped table
    let spanIndex = null;                      // descriptor -> Map family -> BigInt bucket mask
    function loadKeyIndex(rows) {
      keyIndex = new Map();
      spanIndex = new Map();
      for (const r of rows || []) {
        keyIndex.set(r.descriptor, r.col_keys ? String(r.col_keys).split(',').filter(Boolean) : []);
        const sm = parseSpanMask(r.span_mask);
        if (sm) spanIndex.set(r.descriptor, sm);
      }
      return keyIndex;
    }

    // ── the EXTENT axis's key — see build_descriptor_index.js for the encoding ────────────────────
    // Buckets of 8 positions, 64 buckets, hex per family. THE TWO SIDES MUST AGREE, so the constants
    // are repeated rather than derived: this file computes the QUERY's mask live and the generator
    // computes the DATUM's ahead of time, exactly as `col_keys` is split today.
    const SPAN_BUCKET = 8, SPAN_BUCKETS = 64;
    function bucketOf(p) {
      const i = Math.floor((p - 1) / SPAN_BUCKET);
      return i < 0 ? 0 : (i >= SPAN_BUCKETS ? SPAN_BUCKETS - 1 : i);
    }
    function bitsForRange(lo, hi) {
      let m = 0n;
      const a = bucketOf(Math.max(lo, 1)), b = bucketOf(Math.min(hi, SPAN_BUCKET * SPAN_BUCKETS));
      for (let i = a; i <= b; i++) m |= (1n << BigInt(i));
      return m;
    }
    function parseSpanMask(s) {
      if (!s) return null;
      const m = new Map();
      for (const part of String(s).split(',')) {
        const i = part.lastIndexOf(':');
        if (i < 0) continue;
        const fam = part.slice(0, i), hex = part.slice(i + 1);
        // `*` = this family carries information the generator could not place: a terminal mark, a
        // position no molecule of the family holds that residue at, or a POSITIONLESS mark, whose
        // window is decided by chemistry at query time and cannot be predicted here. It is NOT the
        // same as an absent family, which means the descriptor carries nothing there at all.
        if (hex === '*') { m.set(fam, null); continue; }
        try { m.set(fam, BigInt('0x' + hex)); } catch { /* skip */ }
      }
      return m.size ? m : null;
    }

    // The WINDOW a node asks about, per family, IN ALIGNMENT COLUMNS. Null when it states no window
    // — then this axis has no opinion and the caller falls back to the column test or stands down.
    //
    // The endpoints are WALKED, by the same `universeOf` → `inContext` → `walkPosition` path the
    // predicate takes, with `ALL20` because a window endpoint names no residue. Written positions
    // would put this index in a different frame from `extentRung` and from `col_keys` alike.
    function spanMaskOfNode(n) {
      const P = engine();
      const W = P && P.walk2, R = P && P.DEFAULT_REGISTRY;
      if (!n || typeof n !== 'object' || !W || !R) return null;
      const colOf = (pf, p) => {
        try {
          const r = W.walkPosition(p, W.ALL20, W.inContext(W.universeOf(pf, {}, R), pf, {}, R), pf.family, R);
          return (r && r.status === 'ok' && r.col != null) ? r.col : null;
        } catch { return null; }
      };
      const per = new Map();
      let refused = false;
      (function descend(x) {
        if (!x || typeof x !== 'object') return;
        if (x.node === 'proteoform') {
          const fam = x.family;
          if (!fam) return;
          for (const s of (x.segments || [])) {
            if (!s) continue;
            const a = (s.start === '-inf' || typeof s.start !== 'number') ? null : s.start;
            const b = (s.end === '+inf' || typeof s.end !== 'number') ? null : s.end;
            if (a === null && b === null) continue;                 // ⊤ extent — no window stated
            const ca = a === null ? 1 : colOf(x, a);
            const cb = b === null ? SPAN_BUCKET * SPAN_BUCKETS : colOf(x, b);
            // AN ENDPOINT THAT WILL NOT WALK MEANS THIS AXIS CANNOT JUDGE THE QUERY AT ALL. Emitting
            // a partial mask would filter on half a window and drop datums the predicate keeps.
            // An INVERTED pair counts as the same thing: the endpoints are walked independently, so
            // a vote that lands the end before the start is possible in principle, and
            // `bitsForRange` would then return 0n — a mask matching NOTHING, which for a peptide
            // query (no keys test to save it) empties the box and reports "no literature". That is
            // the one outcome this prefilter must never produce. The generator guards the same case
            // with `if (m === 0n) continue`; not mirroring it here was the asymmetry.
            if (ca === null || cb === null || cb < ca) { refused = true; return; }
            per.set(fam, (per.get(fam) || 0n) | bitsForRange(ca, cb));
          }
          return;
        }
        for (const c of x.members || []) descend(c);
      })(n);
      // A family that accumulated no bits says nothing, and a mask of 0n matches nothing — the two
      // read identically to `passes` and only one of them is true. Drop them; if that leaves the
      // node with no family at all, this axis has no opinion and the rung stands down.
      for (const [fam, m] of [...per]) if (m === 0n) per.delete(fam);
      return (!refused && per.size) ? per : null;
    }

    // The key set of ONE node: `family:column` for every mark it carries. Pooled across the node's
    // proteoforms, because a datum entailing this node has to satisfy all of them.
    function keysOfNode(n, P) {
      if (!P || !n || !P.walk2 || !P.DEFAULT_REGISTRY) return [];
      const pfs = [];
      (function descend(x) {
        if (!x || typeof x !== 'object') return;
        if (x.node === 'proteoform') { pfs.push(x); return; }
        for (const m of x.members || []) descend(m);
      })(n);
      const keys = new Set();
      for (const pf of pfs) {
        let out; try { out = P.walk2.walkNode(pf, {}, P.DEFAULT_REGISTRY); } catch { continue; }
        // EVERY mark, not the first: a node naming two marks must intersect on both, and taking
        // one would keep descriptors that carry only the other.
        for (const mk of (out.marks || [])) if (mk && mk.col != null) keys.add(`${pf.family}:${mk.col}`);
      }
      return [...keys];
    }

    // ── THE QUERY IS A LIST OF OPERANDS, AND THEY ARE NOT ASKED THE SAME QUESTION [BB 2026-08-31] ─
    //
    // An array query and the array member the reader has SELECTED are two different questions, and
    // the box answers both — but NOT both at full depth. The rule [BB]:
    //
    //   the ARRAY      protects the literature that matches the array AS A WHOLE, through the
    //                  relation. A paper that measured `(K27M)(K120ub)` — or something that entails
    //                  it — is about the thing on screen and must survive whichever bead is lit.
    //   the SELECTED   is the only thing decomposed. Its components are the reader's current
    //   PARTICLE      question, and nobody else's.
    //
    // So clicking bead 1 does NOT surface bead 2's K120ub papers. It surfaces the array's own
    // literature and bead 1's. Getting this wrong is not a widening — the other member's component
    // hits are ABOUT A DIFFERENT PARTICLE, and mixing them in is the same failure as showing the
    // first bead's papers for the second, with the operands swapped.
    //
    // `componentsOf` decomposes an array one element at a time, index 0 by default, and its own
    // comment reserves the trigger for the caller: "the capability is here; the trigger is not —
    // what makes a caller ask for element N is a UI contract". This is that contract, discharged by
    // handing the selected particle in as an operand rather than by teaching the engine to iterate.
    // Measured on `({H3:K27M})-50-({H4:K16ac})`:
    //
    //   against the array      H3:K27M rung 1 · H4:K16ac NONE · both `({…})` substrates NONE
    //   against unit 0         H3:K27M rung 1 · ({H3:K27M}) rung 0
    //   against unit 1         H4:K16ac rung 1 · ({H4:K16ac}) rung 0
    //
    // The array row is the defect twice over: the second member unreachable, and — because a
    // particle does not entail an array containing it — no substrate descriptor reachable at all.
    // It is also why the array operand must be asked ONLY for whole-array matches: those 15 hits
    // are member 0's components, and they are precisely what a reader looking at bead 1 has not
    // asked about.
    //
    // ── the operand shape ────────────────────────────────────────────────────────────────────────
    // A string is a FULL operand (the whole reach ladder) — every existing caller and every suite
    // means that. `{ descriptor, exact: true }` asks for rung 0 only: the relation against this node
    // itself, no decomposition, no extent rung. Dedup keeps the MORE PERMISSIVE reading, which is
    // what makes a lone particle safe: the page hands in the query as `exact` and the unit as full,
    // and for `({H3:K27M})` the two spellings coincide, so the pair collapses to the full one. Were
    // it the other way round, a single-particle query would silently lose rung 1 — every bare
    // proteoform in the mentions table — which is most of what the box shows.
    function queryList(q) {
      const raw = Array.isArray(q) ? q : [q];
      const out = [];
      for (const x of raw) {
        const d = (typeof x === 'string') ? x : (x && typeof x.descriptor === 'string' ? x.descriptor : null);
        if (!d) continue;
        const exact = !!(x && typeof x === 'object' && x.exact);
        const seen = out.find(o => o.descriptor === d);
        if (seen) { if (!exact) seen.exact = false; continue; }
        out.push({ descriptor: d, exact });
      }
      return out;
    }

    function keysForQuery(queryDescriptor) {
      // The query's own keys are computed, not looked up: a reader may type a descriptor that
      // appears in no paper, and it still has columns.
      return keysOfNode(irOf(queryDescriptor), engine());
    }

    // ── THE PREDICATE IS "ALL OF SOME RUNG" [BB 2026-08-30] ──────────────────────────────────────
    //
    // `d ⊇ q` is the TIGHTEST SOUND filter for whole-query entailment, and that is why it was
    // written: `entails2(d, q)` means d is at least as specific as q, so a datum carrying q's marks
    // carries q's columns too. It becomes UNSOUND the moment the query is DECOMPOSED, because a
    // rung-1 component carries only a SUBSET of the query's marks — the datum has to match the
    // COMPONENT's columns, not the query's. Measured before this changed:
    //
    //   query (H3:K27M@H4:K16ac)   keys {H3:258, H4:17}
    //     H3:K27M      dk {H3:258}   DROPPED — and it is exactly the rung-1 hit
    //     H4:K16ac     dk {H4:17}    DROPPED
    //     ({H3:K27M})  dk {H3:258}   DROPPED
    //
    // So the query contributes ONE KEY SET PER RUNG and a datum survives if it satisfies ANY of
    // them. Rung 0's set is the old predicate unchanged, which is what keeps this a widening.
    //
    // RUNG 2 IS NOT LISTED, and does not need to be: a ⊤ component carries no marks, so its key set
    // is empty, so it would match everything and stand the whole filter down. That is the same
    // empty-key-set rule this file already had — and a second, independent reason rung 2 is opt-in,
    // since it is the one rung no index can accelerate.
    // ONE TEST PER RUNG, and each rung picks the axis it can actually speak on:
    //
    //   keys   the rung names marks          → datum must carry ALL of that rung's columns
    //   span   the rung states a window      → datum's information buckets must INTERSECT it
    //   all    it does neither               → matches everything, so the whole filter stands down
    //
    // The two axes are not alternatives to each other: `col_keys` accelerates the mark rungs and
    // `span_mask` the extent rung, which had no index at all — a peptide query has no columns, so
    // the filter used to stand down and evaluate all 3,262 descriptors.
    // EVERY OPERAND CONTRIBUTES ITS OWN RUNGS. The prefilter has to widen exactly as far as the
    // relation does, or it drops the new hits before `reach2` is ever asked about them — a filter
    // narrower than the predicate it accelerates is not an optimisation, it is the answer.
    function rungTests(queryDescriptor) {
      const P = engine();
      const ops = queryList(queryDescriptor)
        .map(o => ({ n: irOf(o.descriptor), exact: o.exact }))
        .filter(o => o.n);
      if (!P || !ops.length) return [{ type: 'all' }];
      const nodes = ops.map(o => o.n);
      // AN EXACT OPERAND CONTRIBUTES NO COMPONENT RUNGS, because the relation will not be asked
      // about its components either. Adding them would keep descriptors nothing can match and cost
      // the whole `IN` list its selectivity — the prefilter must track the predicate in BOTH
      // directions, or it is either unsound or useless.
      let comps = [];
      for (const o of ops) {
        if (o.exact) continue;
        let c = [];
        try { c = (typeof P.componentsOf === 'function' ? P.componentsOf(o.n) : []) || []; } catch { c = []; }
        comps = comps.concat(c);
      }
      for (const c of comps) {
        let tier = 1;
        try { tier = (typeof P.reachTier === 'function') ? P.reachTier(c) : 1; } catch { tier = 1; }
        if (tier === 1) nodes.push(c);
      }
      // A RUNG IS THE UNION OF THE AXES IT CAN SPEAK ON, NOT THE FIRST THAT ANSWERS. A node stating
      // both marks and a window is reached two ways — `rel` on the marks, and `extentRung` on
      // anything the datum carries inside the window — so answering it on the mark axis alone drops
      // real hits. Measured: `reach2(H3[1-20]:K9ac, H3[1-20]:K4me3)` reaches at rung 1, while the
      // keys test demands H3:187 and the datum carries H3:192.
      return nodes.map(n => {
        const tests = [];
        const keys = keysOfNode(n, P);
        if (keys.length) tests.push({ type: 'keys', keys });
        const sm = spanIndex ? spanMaskOfNode(n) : null;
        if (sm) tests.push({ type: 'span', sm });
        return tests.length ? { type: 'any', tests } : { type: 'all' };
      });
    }

    function prefilter(queryDescriptor, allDescriptors) {
      if (!keyIndex) return allDescriptors;                 // no index shipped — evaluate everything
      const tests = rungTests(queryDescriptor);
      // A rung that can say nothing matches everything, so the filter as a whole stands down —
      // deliberately. Filtering on an empty key set would return nothing and look like a query with
      // no literature, which is the failure this artifact exists to avoid. It is also why rung 2 is
      // opt-in: a ⊤ component states neither marks nor a window, so no index can accelerate it.
      if (!tests.length || tests.some(t => t.type === 'all')) return allDescriptors;
      return allDescriptors.filter(d => {
        const dk = keyIndex.get(d);
        const ds = spanIndex ? spanIndex.get(d) : null;
        // A descriptor this pipeline never saw: keep it. "We cannot reason about this" must mean
        // evaluate, never discard — dropping it here would silently lose a match the relation would
        // have made.
        if (!keyIndex.has(d)) return true;
        // EACH AXIS ANSWERS FOR ITSELF. A datum with no computable columns (`H3:E3,K27M` — the walk
        // cannot place it) is unjudgeable on the MARK axis and is kept there, even if it has a span
        // mask: having placed a datum's regions says nothing about which columns it carries, and
        // letting one axis license a drop on the other is how a sound filter stops being one.
        const passes = (t) => {
          if (t.type === 'keys') {
            // `*` IS "CANNOT SAY", AND EMPTY IS "CARRIES NO MARK" — two answers that used to be
            // spelled the same way [BB 2026-08-31]. A datum whose marks the index could not PLACE
            // (`H3:αac`, a positionless `H3:ph`) is unjudgeable here and must be kept; a datum
            // carrying no mark AT ALL is judgeable and fails, because `entails2(d, q)` requires d to
            // be at least as specific as q — a datum with fewer marks cannot entail a query with
            // more. That is the same argument the ⊇ rule is built on, applied to the empty set.
            //
            // NOT A LOSS ON THE EXTENT AXIS. A markless datum can still reach a query that states a
            // WINDOW, through `extentRung`'s overlap branch — and that is the `span` test in this
            // same `any` group, which is consulted independently. `extentRung` returns EX_NONE
            // unless the QUERY states a window, so a mark-only rung has nothing to lose here.
            //
            // Measured: 353 of ~470 survivors of a particle query were markless, costing 55–69% of
            // its running time to reach nothing.
            //
            // THE REFUSAL IS FAMILY-SCOPED, like the key it excuses. `H4:*` says "this datum carries
            // an H4 mark the index could not place", which can excuse an H4 column and cannot excuse
            // an H3 one — an alignment column is only meaningful within a family, which is why
            // `col_keys` is namespaced in the first place. Bare `*` is the parse failure: no family
            // to name, so it excuses everything. Measured, the scoping is worth having: with a bare
            // `*`, 3,318 of the 3,686 descriptors used as queries kept candidates they could never
            // match, `H1:S44A` carrying 134 to reach 1.
            if (!dk) return true;
            if (dk.includes('*')) return true;                    // unparseable — cannot say at all
            return t.keys.every(k => dk.includes(k)
              || dk.includes(k.slice(0, k.indexOf(':') + 1) + '*'));
          }
          if (t.type === 'span') {
            if (!ds) return true;                            // no mask at all — cannot say
            for (const [fam, m] of t.sm) {
              const dm = ds.get(fam);
              if (dm === undefined) continue;                // ABSENT: carries nothing here — no overlap
              if (dm === null) return true;                  // `*`: unplaceable — cannot say, so keep
              if ((dm & m) !== 0n) return true;
            }
            return false;
          }
          return true;
        };
        return tests.some(rung => rung.type === 'any' ? rung.tests.some(passes) : true);
      });
    }

    // datum ⊑ query. Returns the descriptors whose papers this query should point at.
    // A descriptor that does not parse is SKIPPED rather than treated as matching: an unreadable
    // datum is not evidence, and silently including it would put arbitrary papers in the box.
    // ONE BODY, TWO DRIVERS [BB 2026-08-31]. The loop below is a GENERATOR that yields its cursor
    // after each descriptor; `relevantDescriptors` drives it to completion synchronously — the
    // signature every caller and every suite already has — and `relevantDescriptorsAsync` drives it
    // in slices, handing the page back between them. Two implementations of relevance is the one
    // thing this file must not grow, so the split is in the DRIVING and not in the answer: both
    // return the identical array, and a suite asserts it.
    function* relevanceSteps(queryDescriptor, allDescriptors) {
      // '\0' AS AN ESCAPE, NEVER A RAW NUL. A literal NUL byte here made `file` report this
      // module as binary data, and grep SILENTLY SKIPS binary files — so a repo-wide path
      // sweep reported zero matches in it and the stale parquet defaults below survived one.
      // The separator itself is right: it cannot occur in a descriptor, so the memo key is
      // unambiguous.
      // The operands join the key with the same separator, so `['a','b']` and `['b','a']` are two
      // entries for one answer — cheap, and the alternative is sorting a list whose ORDER is the
      // caller's statement of which operand is the query proper.
      // The operands join the key with the same separator, and the DEPTH is part of it: the same
      // spelling asked exactly and asked in full are two different questions with two answers.
      const ops0 = queryList(queryDescriptor);
      const key = ops0.map(o => (o.exact ? '=' : '+') + o.descriptor).join('\0')
                + '\0' + allDescriptors.length;
      if (relevanceMemo.has(key)) return relevanceMemo.get(key);
      const P = engine();
      const qs = ops0.map(o => ({ n: irOf(o.descriptor), exact: o.exact })).filter(o => o.n);
      const out = [];
      // The rung each descriptor was reached at, carried ON the returned array so every call site
      // keeps its existing signature. `reached` is already passed to `materialOf` precisely so the
      // display cannot form a second opinion about relevance; the rung rides along the same way.
      const rungs = new Map();
      // RANK is the SORT key and RUNG is what the row displays; they are different questions and
      // both ride back on the array. `H3[1-20]` reaches 15,171 papers all at rung 1, so ordering by
      // rung alone leaves the 50 rows a reader sees arbitrary — rank records HOW each datum arrived,
      // which is exactly what the rung abstracts away.
      const ranks = new Map();
      Object.defineProperty(out, 'rungs', { value: rungs, enumerable: false });
      Object.defineProperty(out, 'ranks', { value: ranks, enumerable: false });
      if (P && qs.length) {
        const survivors = prefilter(queryDescriptor, allDescriptors);
        for (let si = 0; si < survivors.length; si++) {
          // THE YIELD IS BEFORE THE WORK, so a driver that stops here has not half-judged a datum.
          // The value is the cursor: an async driver reports progress with it and an aborting one
          // simply never asks for the next.
          yield si;
          const d = survivors[si];
          const dIR = irOf(d);
          if (!dIR) continue;
          // REACH, NOT THE BARE MEET. `reach2` is the dial's own relation applied at every rung of
          // the decomposition and unioned — rung 0 is `entails2(dIR, q)` exactly as before, so this
          // is a widening and nothing the box showed can disappear. What it adds is rung 1: the
          // material the entity is made of, which the layer wall used to hide. Measured, a
          // `(H3:K27M)` query reached 5 particle descriptors and now also reaches 6 bare
          // proteoforms, which is the population the mentions table holds.
          //
          // THE BEST OPERAND WINS, and it is the RANK that decides. A datum reaching the array at
          // rank 4 (chemistry says only that it is not impossible) and the selected particle at
          // rank 0 is an exact hit on the thing the reader is looking at; reporting the first
          // operand to answer would sort it below rows it outranks, and reporting the worst would
          // be a claim nothing measured. `rank` is the sort key and `rung` the displayed one, so
          // they must come from the SAME operand or the row displays one arrival and sorts by
          // another.
          let hit = false, rung = null, rank = null;
          for (const { n: q, exact } of qs) {
            let r = null;
            try {
              // EXACT IS RUNG 0 AND NOTHING ELSE — the relation applied to this node itself. It is
              // what `reach2` checks first and returns on, so this is that branch called directly
              // rather than a fourth notion of relevance. The extent rung is excluded with the
              // components: it answers "the datum lies inside a window this node states", which is
              // a claim about a PART, and a whole-array operand is asking about the whole.
              r = exact
                ? { reaches: P.entails2(dIR, q) === true, rung: 0, rank: 0 }
                : ((typeof P.reach2 === 'function')
                    ? P.reach2(dIR, q)
                    : { reaches: P.entails2(dIR, q) === true, rung: 0, rank: 0 });
            } catch { r = null; }
            if (!r || !r.reaches) continue;
            // A MISSING RANK LOSES, IT DOES NOT WIN. The fallback chain reads rank, then rung — and
            // if both are null it produced `null`, which compares as 0 and so beat every real rank
            // that followed: the first operand to answer would keep the row, an exact hit behind it
            // could never replace it, and `rung`/`rank` shipped null to the sort and the badge.
            // `reach2` returns numbers today, so this is the fallback being written as though a null
            // were possible while treating it as the best possible answer.
            const rk = (r.rank != null) ? r.rank : (r.rung != null ? r.rung : Infinity);
            if (!hit || rk < rank) { hit = true; rung = r.rung; rank = rk; }
            if (rank === 0) break;                        // nothing can beat an exact hit
          }
          if (hit) { out.push(d); rungs.set(d, rung); ranks.set(d, rank); }
        }
      }
      relevanceMemo.set(key, out);
      return out;
    }

    // The synchronous face, unchanged for every existing caller: drive the generator to the end and
    // take what it returns.
    function relevantDescriptors(queryDescriptor, allDescriptors) {
      const it = relevanceSteps(queryDescriptor, allDescriptors);
      let r = it.next();
      while (!r.done) r = it.next();
      return r.value;
    }

    // ── THE SAME ANSWER, WITHOUT HOLDING THE PAGE [BB 2026-08-31] ────────────────────────────────
    //
    // Relevance is UNINTERRUPTIBLE main-thread work — 2.3–3.1s for any particle-level query over the
    // shipped 3,686-descriptor universe, warm instance or cold — and no amount of `async` around a
    // blocking loop gives a keystroke back: the box is not slow because it waits for I/O, it is slow
    // because it computes. So the loop hands the page back every `sliceMs`.
    //
    // AND THE SLICE CANNOT PREEMPT ONE DATUM, which is worth knowing before trusting this. Measured
    // on `({H3:K27M})`: 469 survivors cost 3,332ms, of which the top FIVE are 54% and only EIGHT
    // exceed 50ms — all of them 12-mer chromatin arrays, ~350ms each in `reach2` alone (parse is
    // 3–17ms of that). So the page still blocks for ~400ms at a time on those; what it no longer
    // does is block for three seconds. Making those eight cheap is a separate lever, and it is the
    // prefilter's `!dk.length -> keep` rule: a markless datum and a datum whose marks could not be
    // PLACED are both spelled as an empty key list, and only the second is genuinely unjudgeable.
    //
    // ABORT IS THE OTHER HALF, and it is a saving rather than a courtesy: today a superseded query
    // burns its full 3 seconds before the stale-guard throws the answer away. `shouldAbort` is
    // consulted once per slice — never mid-datum, since the generator yields BEFORE the work — and
    // returns null, which is distinguishable from an empty answer. A caller that passes no
    // `shouldAbort` cannot be aborted.
    //
    // THE YIELD MUST BE A MACROTASK. `await null` is a microtask: it drains without ever letting the
    // browser paint, so the loop would still freeze the page while looking asynchronous. Preference
    // order is `scheduler.yield()` (which returns to the event loop at the right priority),
    // MessageChannel (a macrotask with no timer clamp), then `setTimeout` — whose 4ms nested clamp
    // would add ~0.8s over 190 slices, which is why it is last and not first.
    const yieldToPage = () => new Promise((resolve) => {
      const sch = root.scheduler;
      if (sch && typeof sch.yield === 'function') { sch.yield().then(resolve, resolve); return; }
      if (typeof root.MessageChannel === 'function') {
        const ch = new root.MessageChannel();
        ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
        ch.port2.postMessage(0);
        return;
      }
      setTimeout(resolve, 0);
    });

    async function relevantDescriptorsAsync(queryDescriptor, allDescriptors, opts) {
      opts = opts || {};
      const sliceMs = opts.sliceMs != null ? opts.sliceMs : 12;
      const abort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
      const yieldFn = typeof opts.yieldFn === 'function' ? opts.yieldFn : yieldToPage;
      const it = relevanceSteps(queryDescriptor, allDescriptors);
      let r = it.next();
      let t0 = now();
      while (!r.done) {
        if (now() - t0 >= sliceMs) {
          if (abort && abort()) { it.return(); return null; }
          await yieldFn();
          if (abort && abort()) { it.return(); return null; }
          t0 = now();
        }
        r = it.next();
      }
      return r.value;
    }

    // A DESCRIPTOR LIVES IN TWO PLACES, AND MATCHING ONLY ONE LOSES A WHOLE LAYER. The mentions
    // table holds what a paper NAMES (bare proteoforms, `H3:K27M`); the papers table holds what it
    // was measured ON (`({H3:K27M})`, 95 distinct values over 4,038 papers). Because a particle does
    // not entail a bare proteoform, a nucleosome-level query matches ONLY the substrate column —
    // measured against the shipped tables, `({H3:K27M})` reached 0 mention descriptors and would
    // have rendered an empty box for the query the substrate work exists to serve.
    //
    // So the universe handed to relevantDescriptors must be BOTH, and the SQL must match either.

    // SQL is BUILT here and RUN by the caller, so the shape is testable without DuckDB in the loop.
    // Descriptors are the only interpolated values and they are quoted defensively — they come from
    // our own tables, but a descriptor legitimately contains `|` and `:` and one day may contain
    // something worse.
    // The page passes VERSIONED urls (`…/data/x.parquet?v=<build>`), because these are large
    // versionless assets the browser holds onto hard. Defaulting to the bare path keeps the suites
    // readable; shipping the default would query an unbusted URL and serve yesterday's table.
    // The names are literature_*, and were tier1_* until the tables were renamed on 2026-08-23.
    // The default is only ever reached by a caller that passes no URL — docs/index.html always
    // passes both — so this named two files that do not exist for a while without anything
    // failing. A default that cannot be reached in production is still the wrong default: it is
    // what every test and every future caller gets.
    const MENTIONS = (o) => (o && o.mentionsUrl) || 'data/literature_mentions.parquet';
    const PAPERS   = (o) => (o && o.papersUrl)   || 'data/literature_papers.parquet';

    // THE RUNG ORDERS THE LIST [BB 2026-08-31].
    //
    // Ordering was `rcr DESC, citations DESC` with no rung term, so the rows shown were simply the
    // most-cited papers in the reached set. Measured, `H3[1-20]` reaches 15,171 papers — the extent
    // rung is broad and CORRECT — so a rung-1 paper about K4me3 outranked a rung-0 exact match on
    // citations alone, and the 50-row cut did the rest. Marking the rung on each row made that
    // visible without fixing it.
    //
    // The rung is known per DESCRIPTOR in JS, so it enters SQL as a CASE over the rung-0 list.
    // Impact ordering is kept INSIDE each rung: `rcr` still decides among equals, which is what it
    // was always for. A caller with no rung information gets the constant 0 and the old ordering.
    // ORDERS ON RANK, NOT RUNG [BB 2026-08-31]. Ordering by rung did nothing for the case that
    // needed it most: `H3[1-20]` reaches 15,171 papers through 375 descriptors, ALL rung 1, so the
    // CASE degenerated to a constant and the 50-row cut stayed arbitrary. Rank sub-divides the rung
    // by SORTING rather than by splitting it — the row still displays 1 — and separates a mark
    // inside the queried window from a datum merely ABOUT a region including it, and both from
    // chemistry saying only that it is not impossible.
    //
    // One WHEN per rank present, in order, so a rank with no descriptors emits no branch and never
    // an `IN ()`. All-one-rank still returns the constant: there is genuinely nothing to order.
    function rungCase(descriptors, lit) {
      const ranks = (descriptors && descriptors.ranks instanceof Map) ? descriptors.ranks
                  : ((descriptors && descriptors.rungs instanceof Map) ? descriptors.rungs : null);
      if (!ranks) return '0';
      const byRank = new Map();
      descriptors.forEach(function (d) {
        const r = ranks.get(d);
        if (r == null) return;
        if (!byRank.has(r)) byRank.set(r, []);
        byRank.get(r).push(d);
      });
      const present = [...byRank.keys()].sort(function (a, b) { return a - b; });
      if (present.length < 2) return '0';                     // nothing to order
      const whens = present.slice(0, -1).map(function (r, i) {
        const list = byRank.get(r).map(lit).join(', ');
        return 'WHEN m.descriptor IN (' + list + ') OR p.substrate IN (' + list + ') THEN ' + i;
      });
      return 'CASE ' + whens.join(' ') + ' ELSE ' + (present.length - 1) + ' END';
    }

    function furtherReadingSQL(descriptors, opts) {
      opts = opts || {};
      const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const inList = descriptors.length ? descriptors.map(lit).join(', ') : "''";
      const rung = rungCase(descriptors, lit);
      const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.floor(opts.limit)) : 50;
      return [
        'SELECT p.pmid, p.title, p.authors, p.author_n, p.year, p.journal, p.rcr, p.citations,',
        '       p.is_review, p.is_retracted, p.is_preprint, p.is_editorial,',
        '       p.substrate, p.substrate_certainty, p.entity_scope, p.import_verdict,',
        '       p.pmcid, m.descriptor,',
        '       ' + rung + ' AS reach_rank',
        `FROM read_parquet('${MENTIONS(opts)}') m`,
        `JOIN read_parquet('${PAPERS(opts)}') p USING (pmid)`,
        `WHERE (m.descriptor IN (${inList}) OR p.substrate IN (${inList}))`,
        filterWhere(opts.filter) ? `  AND ${filterWhere(opts.filter)}` : '',
        // ONE ROW PER PAPER, AND IT MUST BE THE BEST-RUNG ONE. This ordered by `m.descriptor`
        // alphabetically, so a paper matching at BOTH rungs could be ranked at rung 0 and then
        // display its rung-1 descriptor — two places deciding and free to disagree, which is the
        // shape `materialOf` is handed `reached` to prevent one layer up. The tiebreak stays
        // alphabetical, so the pick is deterministic among equals.
        'QUALIFY row_number() OVER (PARTITION BY p.pmid ORDER BY ' + rung + ', m.descriptor) = 1',
        // THE RUNG LEADS. NULLS LAST on the rest, because a missing RCR is unknown and not zero —
        // ranking the unknown alongside the genuinely uncited is the mistake this ordering exists
        // to avoid, and it still decides within a rung.
        'ORDER BY reach_rank, p.rcr DESC NULLS LAST, p.citations DESC NULLS LAST',
        `LIMIT ${limit}`,
      ].join('\n');
    }

    // Count first, render second. Selectivity is measured and wildly uneven — the median descriptor
    // returns 2 papers while H2A.X returns 7,416 — so the caller needs the size BEFORE deciding
    // whether a table is the right answer at all.
    function countSQL(descriptors, opts) {
      opts = opts || {};
      const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const inList = descriptors.length ? descriptors.map(lit).join(', ') : "''";
      // Counts over the SAME two columns the row query matches on, or the size shown would not be
      // the size rendered.
      return [
        'SELECT count(DISTINCT p.pmid) AS n',
        `FROM read_parquet('${PAPERS(opts)}') p`,
        `LEFT JOIN read_parquet('${MENTIONS(opts)}') m USING (pmid)`,
        `WHERE (m.descriptor IN (${inList}) OR p.substrate IN (${inList}))`,
        filterWhere(opts.filter) ? `  AND ${filterWhere(opts.filter)}` : '',
      ].filter(Boolean).join('\n');
    }

    // One query for every bucket's size, so the toggle can show counts without four round trips —
    // and so a state that is legitimately empty (Imported, today) reads as "none yet" rather than
    // as a broken button.
    function bucketCountSQL(descriptors, opts) {
      opts = opts || {};
      const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const inList = descriptors.length ? descriptors.map(lit).join(', ') : "''";
      // Aliases are PREFIXED because `all` is a reserved word in DuckDB and `SELECT ... AS all`
      // is a syntax error — caught by running the query rather than by reading it.
      const cols = FILTERS.map(f => f.where
        ? `count(DISTINCT CASE WHEN ${f.where} THEN p.pmid END) AS n_${f.key}`
        : `count(DISTINCT p.pmid) AS n_${f.key}`).join(',\n       ');
      return [
        `SELECT ${cols}`,
        `FROM read_parquet('${PAPERS(opts)}') p`,
        `LEFT JOIN read_parquet('${MENTIONS(opts)}') m USING (pmid)`,
        `WHERE (m.descriptor IN (${inList}) OR p.substrate IN (${inList}))`,
      ].join('\n');
    }

    // Three groups, not two [BB]: Review, Original research, and the EXCLUDED — comments, letters,
    // errata. They are neither research nor review, and putting them in either table would misfile
    // them. Retracted papers are NOT a group: they stay in their group, flagged, because hiding a
    // retraction is how a reader ends up citing one.
    function splitByType(rows) {
      const out = { review: [], original: [], excluded: [] };
      for (const r of rows || []) {
        if (Number(r.is_editorial) === 1) out.excluded.push(r);
        else if (Number(r.is_review) === 1) out.review.push(r);
        else out.original.push(r);
      }
      return out;
    }

    // What the row shows in the Material column: WHAT MADE THIS PAPER RELEVANT.
    //
    // That is a function of the row AND the query, and taking it from the row alone is a defect with
    // a measured symptom [BB 2026-08-17]. A paper matched on its MENTION `H3:K27me3` also carries the
    // substrate `({H3:K27me3})`, and showing the substrate put a PARTICLE in front of a reader whose
    // query was for a bare histone — under entailment, which is precisely the relation that forbids
    // it:
    //
    //   entails2( ({H3:K27me3}) , H3:K27me ) = false
    //
    // The relevance layer was right and never returned the particle; only the display reached past
    // it. So the rule is one sentence: show the substrate when the SUBSTRATE is what the query
    // reached, and the mention otherwise. `reached` is the very list the SQL was built from, so
    // there is no second notion of relevance anywhere — the alternative, re-deciding here with a
    // fresh meet, is how a display path starts disagreeing with the query that produced its rows.
    //
    // Returns BOTH answers from one computation, because the certainty badge asks the second: it
    // describes how the SUBSTRATE was assigned, so it may only appear when the substrate is what is
    // shown. Two functions could disagree; two fields of one result cannot.
    //
    // `reached` is REQUIRED. Defaulting it would restore the old behaviour for every caller that
    // forgot it, which is the bug wearing a fallback.
    // Returns THREE answers from one computation, for the same reason it returned two: the rung a
    // row was reached at is a property of the descriptor that WON the column, so deciding it
    // anywhere else would be a second opinion about which descriptor that was. `null` when neither
    // side was reached — the caller shows nothing rather than a guessed rung.
    function materialOf(row, reached) {
      if (!row) return { text: '', isSubstrate: false, rung: null };
      const has = reached instanceof Set ? (d) => reached.has(d)
                : Array.isArray(reached) ? (d) => reached.indexOf(d) >= 0
                : () => false;
      // ONCE REACH RUNS BOTH WAYS, BOTH COLUMNS CAN MATCH AT ONCE, and the rule above stops being
      // decidable on membership alone [BB 2026-08-30]. `H3:K27me` reaches the mention `H3:K27me3`
      // at RUNG 0 — it is the same molecule, more specific — and the substrate `({H3:K27me3})` at
      // RUNG 1, by decomposing the datum. The better rung wins: the reader is shown the thing their
      // question actually named, and the nucleosome only when that is the closest match there is.
      // Still one notion of relevance — this reads the rung the query layer already computed rather
      // than deciding anything itself.
      // TIES BREAK ON THE KEY THE ORDERING USES, which is RANK. Breaking on `rungs` while
      // `rungCase` and the `QUALIFY` select on `ranks` is two keys for one decision: on a row whose
      // mention has the better RANK but the same RUNG — a mark inside the window against a
      // nucleosome substrate, exactly what rank was introduced for — the row is RANKED on the
      // mention and DISPLAYED as the substrate, badge and all. Rank refines rung and never
      // contradicts it, so using it here cannot change any case the rung already decided.
      const rungs = (reached && reached.ranks instanceof Map) ? reached.ranks
                  : ((reached && reached.rungs instanceof Map) ? reached.rungs : null);
      const rungMap = (reached && reached.rungs instanceof Map) ? reached.rungs : null;
      const sub = !!(row.substrate && has(row.substrate));
      const men = !!(row.descriptor && has(row.descriptor));
      // The RUNG is what the row displays; the map above is the RANK it sorts on. Two questions.
      const rungOf = (d) => (rungMap && rungMap.has(d)) ? rungMap.get(d) : null;
      if (sub && men && rungs) {
        const rs = rungs.has(row.substrate) ? rungs.get(row.substrate) : Infinity;
        const rm = rungs.has(row.descriptor) ? rungs.get(row.descriptor) : Infinity;
        // `<=`, NOT `<`. The rule that predates the rung is "show the substrate when the SUBSTRATE is
        // what the query reached", and the tie-break was added to let a BETTER mention win — not to
        // reverse the equal case, which `<` did silently, taking the "Assigned by" badge with it.
        return (rs <= rm) ? { text: row.substrate, isSubstrate: true, rung: rungOf(row.substrate) }
                          : { text: row.descriptor, isSubstrate: false, rung: rungOf(row.descriptor) };
      }
      if (sub) return { text: row.substrate, isSubstrate: true, rung: rungOf(row.substrate) };
      // The row query's WHERE is `m.descriptor IN (reached) OR p.substrate IN (reached)`, so once the
      // substrate is ruled out the mention is guaranteed to be one the query reached.
      return { text: row.descriptor || '', isSubstrate: false, rung: rungOf(row.descriptor) };
    }

    // The triage icon. `not-assessed` is NOT the same as NO — nobody looked — and the two must not
    // render alike, or an unread paper reads as one judged to have no data.
    function verdictGlyph(row) {
      switch (row && row.import_verdict) {
        case 'YES': return { glyph: '▣', label: 'data in the paper' };
        case 'CONTACT': return { glyph: '✉', label: 'systematic data, not in the paper' };
        case 'NO': return { glyph: '—', label: 'no systematic data' };
        default: return { glyph: '·', label: 'not assessed' };
      }
    }

    const certaintyRank = (c) => CERTAINTY_ORDER.indexOf(c);

    // "Assigned by: Rule" [BB 2026-08-16] — the tooltip names WHO decided, not how the field works.
    const CERTAINTY_LABEL = { rule: 'Rule', agent: 'Agent', 'agent-verified': 'Agent (verified)',
                              human: 'Human' };
    const certaintyLabel = (c) => CERTAINTY_LABEL[c] || null;

    // Count first, render second. Returns what to show AND what to say — never a silent cap.
    function selectivity(total) {
      const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
      if (n === 0) {
        return { mode: 'empty', total: 0, shown: 0, withheld: 0, complete: true,
                 message: 'No papers in the index mention this.' };
      }
      if (n <= FIT_MAX) {
        return { mode: 'complete', total: n, shown: n, withheld: 0, complete: true,
                 message: `${n} paper${n === 1 ? '' : 's'}.` };
      }
      const shown = TRUNCATED_ROWS;
      return {
        mode: 'truncated', total: n, shown, withheld: n - shown, complete: false,
        // The total and the withheld count are BOTH stated. A reader who cannot see that 7,396
        // papers were left out will read the 20 as the answer.
        message: `${n} papers — showing the ${shown} with the highest RCR, ${n - shown} not shown. ` +
                 'This object is not selective; add a second one to narrow it.',
      };
    }

    // The concrete answer to "not selective": what else do these papers mention? Ranked by
    // co-occurrence, so the offered refinements exist in the data rather than being a vocabulary
    // list the reader has to guess from.
    //
    // ONE REFINEMENT IS NOT ALWAYS ENOUGH, and the guard is built for that. Across ALL pairs 95.3%
    // return <=25 papers, but pairs reached FROM the head are themselves large: H3:K27me3 (6,350)
    // plus H3:K4me3 is still 1,349. The message promises narrowing, not fitting — and selectivity()
    // simply fires again on the smaller number.
    function refinementSQL(descriptors, opts) {
      opts = opts || {};
      const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const inList = descriptors.length ? descriptors.map(lit).join(', ') : "''";
      const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 8;
      return [
        'SELECT other.descriptor, count(DISTINCT other.pmid) AS n',
        `FROM read_parquet('${MENTIONS(opts)}') mine`,
        `JOIN read_parquet('${MENTIONS(opts)}') other USING (pmid)`,
        `WHERE mine.descriptor IN (${inList})`,
        // Exclude the query's own descriptors: offering the reader what they already asked is not a
        // refinement.
        `  AND other.descriptor NOT IN (${inList})`,
        'GROUP BY other.descriptor',
        'ORDER BY n DESC',
        `LIMIT ${limit}`,
      ].join('\n');
    }

    return { relevantDescriptors, relevantDescriptorsAsync, furtherReadingSQL, countSQL, splitByType,
             materialOf, verdictGlyph, certaintyRank, selectivity, refinementSQL,
             bucketCountSQL, certaintyLabel, FILTERS, loadKeyIndex, prefilter, keysForQuery,

             CERTAINTY_ORDER, FIT_MAX, TRUNCATED_ROWS };
  }

  const api = { createFurtherReading };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/material-card-model.js
// The COMPUTATION half of a material card. `buildMaterialCard` in shell.js was 603 lines with
// exactly one DOM touch in it, and no suite could load it: it is async, DOM-bound and DuckDB-bound,
// so every claim about it had to be made by slicing source text and running the slice. Three of the
// defects fixed on 2026-08-07 lived here, and one guard was deleted with nothing going red.
//
// So the coordinate work moves here — pure, DOM-free, Node-require-able, same convention as the
// other `*-model.js` files — and shell.js keeps the fetching and the markup.
//
// EVERY DEPENDENCY IS PASSED IN. Not because globals would not work in the browser (they would),
// but because a module reaching for globals cannot be run in a suite at all — and the claims this
// module exists to support are all of the form "these numbers came from the alignment rows and the
// registry the page actually has", which is only checkable if both can be supplied.
//
// The original claim was narrower: that the card header's MW Δ and the per-material Mass table
// compute THE SAME QUANTITY. The header is gone (2026-08-07, see the tombstone at the foot of this
// file) and with it the second reader, so that claim is now answered by there being one computation
// rather than by comparing two. `material-card-agreement.test.js` gates the absence.
(function (root) {
  'use strict';

  // ── WHAT THE GRID READS AND WHAT THE READER READS ARE DIFFERENT NUMBERS ──────────────────────
  // The grid is drawn on alignment COLUMNS and labels them `family_position`, so marks and extent
  // bounds must reach it as columns. Everything the card WRITES — the mark pills, the ¬ pills, the
  // extent badge — is read by a person, and a person is owed the number the molecule itself uses.
  //
  // `H3[1-30]` would otherwise print "residues 143–225", and `H2A.Z:K7ac` would print K15ac: true
  // statements about the alignment, and not what anyone wrote or would recognise.
  //
  // ONE FRAME for the conversion, THE ONE `materialize3` CHOSE — and it is `displayAnchor`, not
  // `anchor`. `anchor` places the numbers that do not walk; a MARK walks, and it can land in a
  // column the anchor does not occupy at all, which is what `displayAnchor` exists to answer.
  //
  // TWO DELETIONS HERE, and they are one rule (2026-08-07). This read
  // `m.anchor || printRefOf(m.variant || m.family)` and then swallowed a null counterpart with
  // `o == null ? n : o` — so `H2A:S139ph` was anchored to P0C0S8, a molecule the walk had
  // ELIMINATED, and when that molecule turned out to have no residue at column 177 the raw COLUMN
  // was handed back as if it were a residue number. That is the reported `S177ph`.
  //
  // Both halves are the pre-columns reference-sequence rule, and both were already deleted by the
  // two other consumers: `particle-scene.js` writes -1 where `ownAtCol` is null — no dot, not a
  // wrong dot — and `three-tier-model.js` asks the walk rather than a print reference. This was the
  // last copy. Null now means null: no number, never a number in no frame.
  //
  // TWO VIEWS OF ONE FACT, and every consumer of this function must be handed the right one.
  //
  //   `mods` / `m.segments`   COLUMNS — for the grid, which is drawn on columns (`modPos`, `segCols`)
  //   `dispMods` / `dispSegments`   the ANCHOR'S OWN numbering — for everything else
  //
  // The second is not merely "for display": `ownAtCol(anchor, col)` recovers THE NUMBER THE READER
  // WROTE, because the anchor is by definition the molecule their numbers were in (258→27 for
  // H3:K27M, 15→7 for H2A.Z:K7ac, 148→121 for H2B1A:K121ub). So every consumer that speaks idea
  // coordinates — `resolvedAlignment`, `queryLayers`, `portMods` — takes this view, not the columns.
  //
  // Teaching only the display path was the 2026-08-05 defect: the resolver handed column 258
  // returns `{node:"error"}`, so the possible-sequences grid and the mass table came back EMPTY for
  // `H3:K27M`, and for `H2A.Z:K7ac` it silently resolved a different site. Six independent readings
  // of one field is the thing materialized.js exists to abolish, re-created inside one function.
  // `_unplaced` marks the case the deletion above made visible instead of papering over: the frame
  // has no counterpart for this site, so the number is dropped rather than guessed, and the pill
  // says why instead of printing a number that is true in no numbering.
  //
  // ONE FIELD FOR THE TOKEN THE NUMBERS WERE WRITTEN UNDER, and it is `variant` (2026-08-03).
  //
  // THE BUG: this used to read `m.frame`, and the DEFAULT view does not go through
  // `materialsFromCanon` — it goes through `worldView` and rebuilds a literal for this call
  // (`{family, variant, segments, certainty}`), which carries no `frame`. So the anchor fell back to
  // the family canonical and `H2A.Z:K7ac` was placed at canonical H2A's own 7 = column 17, which
  // H2A.Z calls its own 9 and where it holds an S. The mark was drawn two columns from the lysine.
  //
  // This is the SAME shape as the dropped-`segments` bug of 2026-07-28 that `page-consumers.test.js`
  // was written for, at the same boundary, one field over. `frame` and `variant` have held the same
  // value since `frameOf` was deleted, so the second field bought nothing and could only be lost.
  // Prefer `variant`; accept `frame` from any caller that still passes it.
  function cardFrames(m, mods, registry) {
    var dispAnchor = (m && m.displayAnchor) || null;
    var toOwn = (m && m.positionsAreColumns && dispAnchor && registry && registry.ownAtCol)
      ? function (n) { return (typeof n === 'number') ? registry.ownAtCol(dispAnchor, n) : n; }
      : function (n) { return n; };
    var dispMods = (mods || []).map(function (x) {
      if (!x || typeof x.position !== 'number') return x;
      var own = toOwn(x.position);
      return Object.assign({}, x, { position: own, _unplaced: own == null });
    });
    var dispSegments = ((m && m.segments) || []).map(function (sg) {
      return (sg && typeof sg.start === 'number' && typeof sg.end === 'number')
        ? Object.assign({}, sg, { start: toOwn(sg.start), end: toOwn(sg.end) }) : sg;
    });
    var token = (m && m.variant != null) ? m.variant
              : ((m && m.frame != null) ? m.frame : null);
    return { dispAnchor: dispAnchor, toOwn: toOwn, dispMods: dispMods,
             dispSegments: dispSegments, token: token };
  }

  // INTO THE COLUMN COORDINATE, both axes, before the grid sees them (2026-08-03). The grid is
  // drawn on columns and labels them `family_position`; handing it AUTHORED numbers shaded the
  // cell whose label matched, which is a different residue under any token that renumbers —
  // `H2A.Z:K7ac` lit H2A.Z's own 9, a serine. The extent had already moved (`segmentWhere`), so
  // the drawn extent and the summed mass had begun to disagree.
  //
  // One anchor for the whole card, which is R24: every number in one node is read in one
  // numbering, so the marks and the bounds cannot end up on different scales.
  // THE ANCHOR THE ENGINE CHOSE. `printRefOf(token)` is the canonical member of the token, which
  // is right for an unpinned query and WRONG when the reader named a molecule: `H2B1A:K121ub`
  // resolved to Q96A08 while its token printed in a bulk H2B, so the grid numbered the mark 120
  // where the reader wrote 121, and the cartoon (which guessed differently again) said something
  // else. One decision, made in materialize3, read here. Reviewed 2026-08-05.
  //
  // THAT WITNESS NO LONGER SPLITS, since 2026-08-24: H2B.1 holds only TSH2B, so `printRefOf` and
  // the pin are both Q96A08 and this query cannot show the bug any more. The rule is unchanged and
  // 18 variant tokens still contain members that disagree about a column — see the yeast case in
  // numbering-frame.test.js for one that still bites.
  //
  // ALREADY IN COLUMNS? THE CALLER SAYS SO. The world path hands the card `worldView`'s groups, and
  // since interpret3 those positions ARE alignment columns — converting again put the mark somewhere
  // else entirely: `H2A.Z:K7ac` went 15 → 23, and `H3:K27M` and `H2B:K120ub` went to null, so the
  // grid shaded the wrong cell in the first case and NO cell in the other two. The three legacy call
  // sites still pass authored numbers and still need the conversion. Measured and fixed 2026-08-05;
  // this is the same shape as the cartoon's `traj[column]`.
  //
  // BOTH ENDPOINTS OR NEITHER — R24's all-or-nothing, at the call site that needs it most.
  // `segCols` returned the segment AS AUTHORED when an endpoint would not place, and the grid then
  // compared an authored range against COLUMNS. `H2B{100-130}` dimmed columns 100–130, which the
  // ruler labels 72–102: a stated extent drawn thirty residues from where it was written, with
  // nothing on screen to say so. Canonical H2B stops at its own 125, so 130 has no column.
  //
  // An extent that cannot be placed is NOT DRAWN, and the card says why. Half of it is worse
  // than none: dimming is a claim about which residues the query excludes.
  //
  // DRIFT, KEYED BY THE COLUMN AT SOURCE. This used to convert `driftByIdea` here — column →
  // the anchor's own number → column — which is a round trip through a numbering that has no
  // name for a column the anchor does not occupy, and the grid is drawn on columns either way.
  // `portAlignment` walks columns to build the map, so it now returns that keying directly.
  // The legacy call sites still speak the anchor's numbers, and `gridRef` is their frame.
  function gridCoords(m, mods, opts) {
    var o = opts || {};
    var registry = o.registry || null;
    var token = o.token;
    var gridRef = (m && m.anchor)
      || ((registry && registry.printRefOf) ? registry.printRefOf(token || m.family, m.family) : null);
    var toCol = (m && m.positionsAreColumns)
      ? function (n) { return n; }
      : function (n) {
          return (gridRef != null && registry && registry.colAt && typeof n === 'number')
            ? registry.colAt(gridRef, n) : n;
        };
    var modPos = new Set((mods || []).filter(function (x) { return x.position != null; })
                                     .map(function (x) { return toCol(x.position); })
                                     .filter(function (x) { return x != null; }));
    var segCols = null, extentUnplaceable = false;
    var segments = (m && m.segments) || [];
    if (segments.some(function (sg) {
          return sg && (typeof sg.start === 'number' || typeof sg.end === 'number'); })) {
      var out = [];
      for (var i = 0; i < segments.length; i++) {
        var sg = segments[i];
        if (!sg || typeof sg.start !== 'number' || typeof sg.end !== 'number') { out.push(sg); continue; }
        var a = toCol(sg.start), b = toCol(sg.end);
        if (a == null || b == null) { extentUnplaceable = true; break; }
        out.push(Object.assign({}, sg, { start: a, end: b }));
      }
      if (!extentUnplaceable) segCols = out;
    }
    var driftIdea = o.driftIdea, driftCol = o.driftCol;
    var driftCols;
    if (m && m.positionsAreColumns) driftCols = driftCol;
    else if (driftIdea && registry && registry.colAt && gridRef) {
      var m2 = new Map();
      driftIdea.forEach(function (v, own) {
        var c = registry.colAt(gridRef, own);
        if (c != null) m2.set(c, v);
      });
      driftCols = m2;
    } else driftCols = driftIdea;
    return { gridRef: gridRef, toCol: toCol, modPos: modPos, segCols: segCols,
             extentUnplaceable: extentUnplaceable, driftCols: driftCols };
  }

  // THE MASS LOOP TAKES THE SITE COORDINATE, NOT THE READER'S (2026-08-07). It read `dispMods`
  // — the display anchor's own numbering — and looked those numbers up in `r.cells`, which is
  // keyed by IDEA position. The two coincide only when the anchor IS the family's canonical
  // member, because `family_position` is that member's own number; since the anchor became the
  // molecule the walk chose, they routinely do not. `H2A:S139ph` is the extreme case: the walk
  // lands on column 177 and canonical H2A has no residue there at all, so the site has NO idea
  // position and every idea-axis lookup had to miss. The Δ silently fell back to the base mass
  // and the mark was dropped from the cell's notation — one bug, two symptoms.
  //
  // `mods` is the card's site coordinate (columns under `positionsAreColumns`, idea positions on
  // the refusal-fallback path, where `dispMods` equals it anyway). The reader's numbering is
  // still `dispMods`, and it is still what the pills print — see the two-views note above.
  function massModsOf(mods) {
    return (mods || []).filter(function (x) {
      return x.position != null && !x.negated && (x.variant || x.modification);
    });
  }

  // BOTH COORDINATES FOR EACH MARK, from the pairing the grid itself is drawn on:
  // `alnModel.columns` is `{col, pos}` with `pos == null` for an insertion column. Row-independent,
  // so it is computed once per card rather than per row.
  function siteReader(positionsAreColumns, columns) {
    var ideaOfCol = new Map(), colOfIdea = new Map();
    (columns || []).forEach(function (c) {
      ideaOfCol.set(c.col, c.pos);
      if (c.pos != null) colOfIdea.set(c.pos, c.col);
    });
    function siteOf(mod) {
      var n = mod.position;
      if (typeof n !== 'number') return { col: n, pos: n };
      return positionsAreColumns
        ? { col: n, pos: ideaOfCol.has(n) ? ideaOfCol.get(n) : null }
        : { col: colOfIdea.has(n) ? colOfIdea.get(n) : n, pos: n };
    }
    // WHICH NUMBERING `emitMaterial` IS BEING HANDED, STATED rather than guessed — the same
    // declaration `positionsAre` exists for. Under `positionsAreColumns` the marks are columns, and
    // the idea branch could not translate a column with no idea position: it refused the whole
    // emit, which is why the Material cell printed a bare `H2AX`.
    var emitFrame = positionsAreColumns ? 'column' : undefined;
    return { ideaOfCol: ideaOfCol, colOfIdea: colOfIdea, siteOf: siteOf, emitFrame: emitFrame };
  }

  // Per-material masses: base MW from protein_masses (attached to alnModel.rows), plus a Δ computed
  // against EACH accession's OWN residue at the modified position — so "K27M" on an accession
  // carrying R at 27 evaluates R27→M, not K27→M. Negated marks are excluded by `massModsOf`: a
  // struck K27me asserts absence and must not shift mass.
  //
  // deps: { registry, emitMaterial, markSite, subDelta, ptmDelta } — all four are required for the
  // full answer, and each is guarded exactly as the shell guarded it, so a missing parser global
  // degrades the way it always did rather than throwing.
  async function massRowsFor(alnModel, massMods, positionsAreColumns, deps) {
    var d = deps || {};
    var emitMaterial = (typeof d.emitMaterial === 'function') ? d.emitMaterial : null;
    var markSite = d.markSite;
    var reader = siteReader(positionsAreColumns, alnModel && alnModel.columns);
    var emitFrame = reader.emitFrame;
    var massRows = [];
    var rows = (alnModel && alnModel.rows) || [];
    for (var ri = 0; ri < rows.length; ri++) {
      var r = rows[ri];
      var dAvg = 0, dMono = 0, unknown = false;
      // ONE STRING PER CELL, WRITTEN BY THE EMITTER (BB, 2026-07-29). The Material cell used to be a
      // handle plus a row of mark chips assembled here; it is now a single notation string, so the
      // one thing the reader can select and paste is produced by the same code that produces every
      // other notation on the page. What stays row-derived is the CONTENT of the marks — `R27M`
      // where this accession's own wild type diverges, the dropped `S31S` no-op, the terminal form —
      // because each mark justifies the mass delta beside it, and that is chemistry against this
      // molecule. So the loop below decides WHICH marks are true of this row, and `emitMaterial`
      // decides how to spell them and in whose numbering.
      //
      // `emitMods` carry the card's site coordinate (`emitFrame` says which); `warn` collects the
      // reasons this row's own chemistry departs from what the query stated, shown in gold.
      var emitMods = [], warn = [];
      // Positions only, for markSite's LABEL argument — a probe against the query's own mods, used
      // solely so a gap/terminal message can name the residue number this molecule uses.
      var probeEmit = emitMaterial ? emitMaterial(r.uniprot_id, massMods, d.registry, emitFrame) : null;
      var matLabel = function (mod) {
        if (!probeEmit) return null;
        var i = massMods.indexOf(mod);
        var mk = i >= 0 && probeEmit.marks[i];
        return mk ? mk.mod.position : null;
      };
      for (var mi = 0; mi < massMods.length; mi++) {
        var mod = massMods[mi];
        // Where this mark sits in THIS accession — a residue, a gap, or a terminus, which is not a
        // residue position at all and must never be read as a gap (alignment-model.js markSite).
        //
        // WHICH MAP, BY THE RULE THE GRID ALREADY USES (render.js: `isIns ? colCells : cells`).
        // A column with no idea position is an INSERTION and is read from `colCells`; `cells` is
        // the IDEA axis and is only correct where a `family_position` exists. The two hold the same
        // residue wherever both exist, so an unconditional `colCells` read would be equivalent
        // today — and would be a second copy of a rule that already has one place to live.
        var st = reader.siteOf(mod), isIns = st.pos == null;
        var site = markSite(mod, isIns ? r.colCells : r.cells, matLabel(mod),
                            isIns ? st.col : st.pos);
        var actual = site.residue;                              // residue in THIS accession
        // ONE emit mod per query mark, carrying what is true of THIS molecule. Both axes may be set
        // (`K27Mme3`), which is one mark in the notation — the chip version wrote two.
        var sub = null, ptm = null, expressible = false;
        if (mod.variant) {
          // A terminus is not substitutable — the engine rejects `H4:αM` outright — so this branch
          // is side-chain only and its gap test stands.
          if (actual == null) {
            // NO RESIDUE HERE, so there is no notation for it: writing `M@27` would not parse, and
            // writing `K27M` would assert a residue this molecule does not have. The mark is left
            // out of the string and the absence is said in words.
            warn.push('no residue at ' + site.label + ' in this material, so ' + mod.variant
                      + ' cannot be placed');
          } else if (mod.variant === actual) {
            // Equality: substituting to the residue already present is a no-op (zero mass Δ), and
            // `S31S` carries no information on a material that is already S at 31. Omitted from the
            // notation for the same reason it carried no chip.
          } else {
            var ds = await d.subDelta(actual, mod.variant);
            if (ds.unknown) unknown = true;
            dAvg += ds.average_delta; dMono += ds.monoisotopic_delta;
            sub = mod.variant; expressible = true;
            if (mod.residue && mod.residue !== actual)
              warn.push('the query stated ' + mod.residue + site.label + ', this material carries '
                        + actual);
          }
        }
        if (mod.modification) {
          if (site.gap) {
            // A set-valued mark reads as a list to a human, not as "me3,me2,me1".
            var modName = Array.isArray(mod.modification) ? mod.modification.join(' or ') : mod.modification;
            warn.push('no residue at ' + site.label + ' in this material, so ' + modName
                      + ' cannot be placed');
          } else {
            var dp = await d.ptmDelta(mod.modification);
            if (dp.unknown) unknown = true;
            dAvg += dp.average_delta; dMono += dp.monoisotopic_delta;
            ptm = mod.modification; expressible = true;
          }
        }
        if (expressible)
          emitMods.push({ position: mod.position, negated: false,
                          // A terminal mark names no residue: writing one would claim the group sits
                          // on a side chain, which is the opposite of what α means.
                          residue: site.terminal ? null : actual,
                          substitution: sub, modification: ptm });
      }
      // The cell's own string. The card's site coordinate in, this molecule's numbering out.
      var cellEmit = emitMaterial ? emitMaterial(r.uniprot_id, emitMods, d.registry, emitFrame) : null;
      // THE STATED EXTENT'S MASS WINS WHEN THERE IS ONE. `H3[1-30]` is a thirty-residue peptide,
      // and printing the 15.4 kDa chain beside it states the mass of a molecule the query has
      // just excluded. `baseAvg` rides along so the table can say what the whole chain would be.
      var useExt = alnModel.extent && r.extentAvg != null;
      massRows.push({ uniprot_id: r.uniprot_id, uniprotName: r.uniprotName, name: r.name,
                      handle: cellEmit && cellEmit.handle,
                      notation: cellEmit && cellEmit.notation,
                      warn: warn,
                      species: r.species, variant: r.variant, complete: r.massComplete,
                      massKnown: r.massKnown,
                      baseAvg: useExt ? r.extentAvg : r.baseAvg,
                      baseMono: useExt ? r.extentMono : r.baseMono,
                      chainAvg: useExt ? r.baseAvg : null,
                      extentN: useExt ? r.extentN : null,
                      // An extent with no residues in THIS material is not a light molecule; it is
                      // a material the query does not reach. Say that rather than print a number.
                      extentEmpty: !!(alnModel.extent && r.extentAvg == null),
                      dAvg: dAvg, dMono: dMono, unknown: unknown });
    }
    return massRows;
  }

  // ── `wildTypeAt` / `mwModsFor` WERE DELETED HERE (2026-08-07) ────────────────────────────────
  // They were THE HEADER'S WILD TYPE — a second reader of "which residue does this molecule carry
  // at this site", feeding a head-line MW Δ that the mass table below it computes per accession.
  //
  // The head line itself went in `5f6bca8`'s successor: it assigned `mwHtml` and nothing read it,
  // in any file, and had been dead since before `0c9fd66`. These two outlived it by a commit.
  //
  // DELETED RATHER THAN LEFT STANDING, because the alternative was not "keep some coverage" but
  // "keep a duplicate". The residue at a site is read ONE way on the live path — `markSite` over
  // the alignment row's `cells`/`colCells`, counted by `cells-axis.test.js`. `wildTypeAt` read it
  // the other way, through `registry.residueAtCol`/`residueAt`, and the two disagreed on screen for
  // `H2A.Z:K7A` (V→A above, K→A below) precisely because two readers existed. `material-card-
  // agreement.test.js` was written to compare them; with one computation left there is nothing to
  // compare, which is a stronger state than a green comparison — and that suite now GATES the
  // absence instead of asserting the agreement.
  //
  // Restoring a head-line mass means answering the question that killed it first: a card resolves
  // to a SET of materials, and a head line can stand behind only one number. The per-material Mass
  // table answers the same question per accession with the chips that justify each delta.
  //
  // What was here is in git at `aa4a9f9^`.
  //
  var api = { cardFrames: cardFrames, gridCoords: gridCoords, massModsOf: massModsOf,
              siteReader: siteReader, massRowsFor: massRowsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Pure model for the units bar: the v2 IR -> the list of physical units on screen.
//
// This file was the cartoon's whole model — family multisets, glyph ids, per-copy decoration, a
// kind->seat table. All of it answered "what does this copy look like", from the v1 parse tree or
// from an arrangement string, and particle-scene.js now answers it once from the IR. What is left
// is the only question that was ever this file's own: how many units are there, and what separates
// them.
(function (root) {
  'use strict';
  var FAMS = ['H2A', 'H2B', 'H3', 'H4'];

  // `unitCaption` lived here (BB, 2026-07-25: dropped). It was a THIRD opinion about how to write a
  // particle down — its own walk over the v1 subtree, its own bracket precedence — sitting next to
  // emit2 and the inspector's Canon line, and free to disagree with both. It also showed only the
  // STATED slots, so `(H3:K27M)` read "(H3K27M)" while every other pane discussed a completed
  // octamer. The query now has one caption, derived from canon in shell.js (`renderCanonCaption`).

  // The particles on screen, from the v2 IR.
  //
  // A new PARTICLE is opened by an array member AND by that member's own COUNT: `(H3)3` is three
  // nucleosomes in a row, exactly like `(H3)-(H3)-(H3)`, so it is three beads (BB, 2026-07-25). It
  // drew as one because the count lived on the node rather than in the member list — invisible until
  // meet2 started preserving repetition at all. A bare top-level `@` list is still ONE unit: it is a
  // single free assembly, not a bead per slot.
  function unitNodes(ir) {
    if (!ir || typeof ir !== 'object') return [];
    var members = (ir.node === 'array') ? (ir.members || []) : [ir];
    var out = [];
    members.forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      // Only a PARTICLE's repetition opens new units. `(H3)3` is three nucleosomes in a row, joined
      // by DNA. A repeated FREE assembly is one object, not several: `[H3@H4]2` is the (H3–H4)₂
      // tetramer — the copies self-associate, which is the only reason meet2 admits the repetition
      // at all. Expanding it drew a tetramer as two separate dimer beads.
      //
      // AND THE COPIES DIFFER IN ONE FIELD [BB 2026-08-14]. A stated linker is the gap after the
      // LAST copy, not after each of them (ruling (b)), so the earlier copies are the same particle
      // with the gap unstated — which is what `linkerAfter` below then reads. `withoutLinker` is the
      // engine's, shared with the array meet and `particlesOf`, so the bar cannot draw a spacing the
      // algebra does not believe. It returns `m` itself when there is no linker to drop.
      var k = (m.dna != null && m.count != null) ? Math.max(1, m.count) : 1;
      var drop = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2.withoutLinker : null;
      for (var i = 0; i < k; i++) out.push((drop && i < k - 1) ? drop(m) : m);
    });
    return out;
  }

  // The unit carries just its NODE, its classification and the linker that follows it — the families,
  // marks and glyph id it used to carry were only ever inputs to the renderer, and the renderer reads
  // the node itself now. `subtree` is kept as an alias while the panes that still take a v1 subtree
  // are ported.
  function unitList(ir, deps) {
    deps = deps || (typeof nucleosomeParser2 !== 'undefined' ? nucleosomeParser2 : null);
    var nodes = unitNodes(ir);
    return nodes.map(function (n, i) {
      // The linker after unit i is carried by the particle it trails FROM, and only counts when
      // something follows. Repeated copies used to be the SAME node, so a stated linker was drawn
      // between every pair of them — reading (a). `unitNodes` now hands back copies whose gap is
      // unstated except after the last, so this line is unchanged and draws (b) instead.
      var link = (i < nodes.length - 1 && n.dna) ? n.dna.linker : null;
      return {
        node: n, subtree: n,
        kind: (deps && deps.classify2) ? deps.classify2(n) : null,
        linkerAfter: (link && link.bp != null) ? link : null,
      };
    });
  }

  // WHAT LEFT (BB, 2026-07-25, stage 3). Eleven functions moved into particle-scene.js or died with
  // the old renderer: unitMarks, markedFamilies, variantFamilies, copyDeco, worldDeco, worldSubunits,
  // subunitSet, glyphSubunitSet, glyphId, famKey, decompose. Every one of them answered "what does
  // this copy look like" from the v1 parse tree or from an arrangement string; `seats()` answers it
  // once, from the IR. `decompose` is not replaced — an unnameable composition is now reported
  // rather than drawn as a greedy guess.
  var api = { unitList: unitList, unitNodes: unitNodes, FAMS: FAMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/particle-scene.js — the v2 IR node → cartoon renderer.
//
//   seats(node)                  IR  → SeatMap      which physical copy is what
//   layout(seatMap, opts)        SeatMap → Scene    geometry, z-order, colour
//   emit(scene)                  Scene → string     syntax only
//   renderParticle(node, opts)   the composition of the three
//
// ── WHY THIS REPLACES THE OLD PATH ───────────────────────────────────────────────────────────────
// The cartoon had TWO paths into the same picture: `worldDeco(parseArrangement(str))` when an
// arrangement tile was selected, and `fallbackDeco(unit)` — a walk over the v1 parse subtree — when
// it was not. They computed the same thing, per-copy decoration, from two different sources, and
// only one of them could be right about a partially stated query.
//
// They collapse because a WORLD IS AN IR NODE: `interpret3().worlds[i]` is an assembly, so drawing
// the selected world is just `renderParticle(worldIR)`. One input, one path. Nothing here consults
// an arrangement string.
//
// ── WHICH COPY HOLDS THE MARK ────────────────────────────────────────────────────────────────────
// A world IR is a flat eight-member assembly with NO face/copy/seat field:
//
//   (H3:K27M) world 0   H3[K27M] H4[] H2A[] H2B[]  H3[K27M] H4[] H2A[] H2B[]   homotypic
//   (H3:K27M) world 1   H3[K27M] H4[] H2A[] H2B[]  H3[]     H4[] H2A[] H2B[]   heterotypic
//
// so member POSITION looks like the only carrier of face identity, and `seats` was written to
// honour it. The oracle test overturned that: `interpret2` lists the marked copy first while the
// arrangement STRING it derives from the same world puts wild-type first ("/K27M"), so honouring
// member order made the cartoon disagree with its own arrangement tile about which copy is lit.
//
// Copies are therefore sorted into seats by a canonical signature. Nothing is lost: `interpret2`
// enumerates distinct MULTISETS, so two worlds never differ by permutation alone — worlds 0 and 1
// above differ in content ({M,M} vs {M,·}) and stay distinguishable. The two views of one object
// now agree by construction rather than by coincidence.
//
// ── THE FRAME ────────────────────────────────────────────────────────────────────────────────────
// There is no kind → seat-set table (the old `subunitSet`). A PARTICLE (dna != null) has all eight
// seats and the unfilled ones are drawn as ghosts — that is what makes a tetrasome read as a
// tetrasome rather than as a small tetramer. A FREE assembly gets only the seats it fills. `lift2`
// consumes a `count: 0` member into an exclusion, so the absence cannot come from the membership;
// the DNA carries it, and that is the same field `classify2` reads to tell the two apart.
(function (root) {
  'use strict';

  var FAMS = ['H3', 'H4', 'H2A', 'H2B'];

  // Dark family tints for a variant copy. The cartoon's authored fills are theme-invariant, so
  // these are too (the darker member of each ColorBrewer pair).
  var FAM_DARK = { H3: '#1f78b4', H4: '#33a02c', H2A: '#b3b300', H2B: '#e31a1c' };
  var FAM_LIGHT = { H3: '#a6cee3', H4: '#b2df8a', H2A: '#ffff99', H2B: '#fb9a99' };

  // WHICH POSE A BEAD HOLDS (specs/2026-08-11-the-animated-bead.md §6). FNV-1a over the bead's own
  // canonical identity: the same bead holds the same pose on every render, in every browser and in
  // a test, while different beads differ — so an array reads as an ensemble, not a row of clones.
  // Not a crypto hash. It picks a pose.
  function frameOf(identity, frameCount) {
    if (!frameCount || frameCount < 2) return 0;
    var h = 0x811c9dc5;
    for (var i = 0; i < identity.length; i++) {
      h ^= identity.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h % frameCount;
  }

  // The bead's identity is what it DEPICTS: which seats, which variants, which marks, what DNA.
  // Two beads that draw the same particle get the same pose, which is accepted (§6) — they are the
  // same particle. Uses only fields `seats()` is known to return.
  //
  // TWO OF THE THREE DECLARED INPUTS WERE DEAD (review, 2026-08-11, Important 4). A PARTICLE's
  // `sm.order` DOES include its empty seats — `seats()` pushes a ghost entry for every unfilled seat
  // so a tetrasome reads as a tetrasome — but this function's per-seat string never mentioned
  // `st.occupied`, so an occupied wild-type seat (`variant: null`, `marks: []`) and an unoccupied
  // ghost (the same two defaults) serialised IDENTICALLY. A tetrasome, a hexasome and a full octamer
  // that agree on their filled seats therefore produced the same string and held the same pose,
  // which is exactly the mixed-array ensemble case the spec's §6 argument is about. And `sm.dna` is
  // the `{polarity, footprint, linker}` OBJECT `seats()` returns (not a string), so `'' + sm.dna`
  // string-coerced to the constant `[object Object]` for every particle — `(H3)147` and `(H3)167`
  // were indistinguishable. Appending occupancy per seat and serializing `dna` properly (rather than
  // string-coercing it) makes both facts live again.
  function identityOf(sm) {
    return (sm.order || []).map(function (seat) {
      var st = (sm.seats && sm.seats[seat]) || {};
      return seat + '/' + (st.occupied ? '+' : '-') + '/' + (st.variant || '') + '/'
           + ((st.marks || []).map(function (m) { return m.token; }).join(','));
    }).join('|') + '#' + (sm.dna == null ? '' : JSON.stringify(sm.dna));
  }

  // A part with frames is drawn at THIS bead's frame; one without is rigid and unchanged.
  function atFrame(p, frame) {
    if (!p.frames || !p.frames.length) return p.markup;
    return p.markup.replace(/\sd="[^"]*"/, ' d="' + p.frames[frame % p.frames.length] + '"');
  }

  function isNeg(m) { return !!(m && (m.negated || m.absent)); }

  // A modification's display token: residue + position + substitution/PTM ("K27M", "K16ac",
  // "K27Mme3"). The position is what the dot is placed at.
  function markToken(m) {
    return (m.residue || '') + (m.position != null ? m.position : '')
         + (m.substitution || '') + (m.modification || '');
  }

  // The variant token this proteoform PINS, or null when nothing is pinned. One line, because
  // `variantToken2` already answers exactly this: it returns null for a family-wide variant, so it
  // never hands back the family name.
  //
  // There were two of these, in this file and the other one, and they differed (census §2,
  // 2026-08-05). particle-scene's guarded `t !== pf.family`; shell-model's did not. Measured:
  // `variantToken2` returns null for `(H3)` and `(H2A)` and a real token for `(H3.1)`, `(caH3)`,
  // `(H2A.Z)` — the guard was dead defensiveness and the two agreed everywhere reachable. Agreeing
  // everywhere reachable is what a duplicate does right up until it does not.
  //
  // Throws rather than degrading, like `markKey`: the fallbacks the two copies carried differed from
  // each other too, and a fallback that only runs when the engine is missing is a second answer
  // nobody can see being wrong.
  function pinnedVariant(pf) {
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.variantToken2 !== 'function')
      throw new Error('variantToken2 unavailable — load build/parser2.js first');
    return P.variantToken2(pf.family, pf.variant);
  }

  // meet2's. Was a local copy differing from shell.js's only by an `Array.isArray` guard
  // (census §2, 2026-08-05).
  // The particles of a node with repetition expanded — the engine's own walk, wrapped here the same
  // way `particleOf` is.
  function particlesFor(node) {
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.particlesOf !== 'function') return (node && node.members) || [];
    return P.particlesOf(node);
  }

  function particleOf(node) {
    var P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P || typeof P.particleOf !== 'function')
      throw new Error('particleOf unavailable — load build/parser2.js first');
    return P.particleOf(node);
  }

  // Copies of one family within one face, as a comparable string.
  function copySig(c) {
    return (c.variant || '') + ' '
         + c.marks.map(function (m) { return m.position + ':' + m.token; }).sort().join(',');
  }
  // `stateSig` and `orderSig` stood here until 2026-08-05. They were this file's copy of the
  // enumerator's arrangement-string FORMAT — "" wild-type, "K27M,S28ph" marks, "\x1f" a variant,
  // "∅" absent — reproduced so the cartoon could re-derive `interpret2`'s canonical dyad choice by
  // string comparison. Their own comment said so: "byte-identical in shape to interpret2's
  // sig/flipSig, so comparing two of these reproduces its canonical choice."
  //
  // That is the third dyad-flip implementation the 2026-08-04 spec tabulated, and it went with the
  // swap it existed to feed. Nothing here reproduces an engine format any more; `seats` reads the
  // IR's own `face` stamps, and an unstamped node is drawn in its own member order.
  // Walk one member list into a flat list of copies (expanding `count`, flattening co-brackets).
  //
  // A WORLD IS EXPLICIT, so on the world path this expands nothing: `worldIR` and (since 2026-08-05)
  // `singleWorld` both emit one member per copy with every count 1. `count` is still read, because
  // `seats` also draws QUERY nodes — the units bar and the unit beads hand it the IR the reader
  // typed, and `(H3:K27M)` really is one proteoform with count 2 there.
  //
  // THE ENCLOSING COUNT IS BACK, because the note that removed it was only true of the world path
  // (BB, 2026-08-06). It read: "a query node that nests one is completed by `lift2` before it reaches
  // a world, and the invariant in stoichiometry-nesting.test.js holds the whole class." The invariant
  // does hold — over WORLDS. But `seats` also draws query nodes, as the paragraph above says, and
  // `beadsHtml` falls back to the materialized node and then to the raw query IR whenever no world is
  // selected. Measured on `([H3@H4]2@H2A@H2B)`:
  //
  //     world (interpret3)        H3:2 H4:2 H2A:2 H2B:2      ← agrees with compositionCounts
  //     materialize3 node         H3:1 H4:1 H2A:2 H2B:2      ← drawn half-empty
  //     raw query IR (fallback)   H3:1 H4:1 H2A:2 H2B:2      ← ditto
  //
  // So an octamer written with an explicit tetramer drew as a hexasome-shaped thing on two of the
  // three paths this function is reached by. `copyMultiplier` is the engine's own rule and knows the
  // part that made this subtle: a PARTICLE's own count is repetition along DNA, not extra copies, so
  // the root is exempt and `{H3@H4}2` still draws one tetramer rather than two dimers.
  function copiesOf(members, node) {
    var out = [], pins = {}, pinN = 0;
    var P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    var mult = function (n, isRoot) {
      return (P2 && typeof P2.copyMultiplier === 'function') ? P2.copyMultiplier(n, isRoot)
           : (isRoot && n && n.dna != null ? 1 : (n && n.count == null ? 1 : n.count));
    };
    (function walk(list, pin, carried) {
      (list || []).forEach(function (n) {
        if (!n || typeof n !== 'object') return;
        if (n.node === 'proteoform') {
          var fam = n.family;
          if (!fam || FAMS.indexOf(fam) < 0) return;    // H1 and friends have no seat in this art
          var k = ((n.count == null) ? 1 : n.count) * carried;
          if (k <= 0) return;                            // a consumed absence — see THE FRAME
          for (var i = 0; i < k; i++) out.push({
            family: fam, occupied: true, variant: pinnedVariant(n),
            // The MOLECULES this copy stands for. Carried because a mark's position may be an
            // alignment COLUMN (an interpret3 world) and the chain is drawn in the molecule's OWN
            // numbering — the conversion is `ownAtCol(accession, column)` and it needs the accession.
            accession: (Array.isArray(n.accession) && n.accession.length) ? n.accession.slice() : null,
            // WHOSE NUMBERING THIS COPY'S NUMBERS ARE IN. Decided once by `materialize3` — the pin
            // when the reader named one — and carried here rather than re-guessed.
            anchor: n.anchor || null,
            marks: (n.modifications || []).filter(function (m) { return !isNeg(m); })
                     .map(function (m) { return { position: m.position, token: markToken(m) }; }),
            pin: pin,
          });
          return;
        }
        if (n.node !== 'assembly' && n.node !== 'array') return;
        var p = pin;
        if (p == null && n.dna == null && n !== node) { p = 'p' + (++pinN); pins[p] = true; }
        walk(n.members, p, carried * mult(n, n === node));
      });
      // …and the ROOT's own count, where the root is the thing being walked INTO. `[H3@H4]2` is the
      // tetramer: two H3 and two H4 in one bead, which is what the world says and what the two
      // non-world paths were missing. Applied only for an assembly/array, because a bare proteoform
      // root IS `members[0]` and would otherwise have its count applied twice.
    })(members, null,
       (node && (node.node === 'assembly' || node.node === 'array')) ? mult(node, true) : 1);
    return { copies: out, pins: Object.keys(pins) };
  }

  // A face holds at most one copy of any family; the families it holds, as a comparable key.
  function halfOctamer(copies) {
    var seen = {};
    for (var i = 0; i < copies.length; i++) {
      if (seen[copies[i].family]) return false;
      seen[copies[i].family] = 1;
    }
    return true;
  }
  function famSet(copies) {
    return copies.map(function (c) { return c.family; }).sort().join(',');
  }

  function seats(node, deps, atlas) {
    deps = deps || root;
    node = particleOf(node);
    var isParticle = !!(node && node.dna != null);
    var members = (node && node.members) || (node && node.node === 'proteoform' ? [node] : []);

    // FACE STRUCTURE. `interpret2` builds a world IR one face at a time (its `[0,1].forEach(face)`
    // loop), so an even member list splits down the middle into the two half-octamers, and face i is
    // copy i. A query IR need not be face-structured (`(H3:K27M)` is one proteoform with count 2), so
    // faces are used only when they are actually there.
    var faces = null;
    // THE MEMBERS SAY WHICH FACE THEY ARE ON, when they come from `interpret2`/`interpret3` —
    // `worldIR` stamps `face` on every copy (2026-08-04). Preferred over the split below because the
    // split assumes the two faces present the SAME NUMBER of copies, which is false for any
    // sub-octamer: measured, a hexasome is 2 copies on one face and 4 on the other. The guards below
    // catch that and fall through to the unstructured path, so the picture was not WRONG — it just
    // lost the face structure exactly where the particle is most interesting.
    var tagged = isParticle && members.length > 0 &&
      members.every(function (m) { return m && (m.face === 1 || m.face === 2); });
    if (tagged) {
      var fa = copiesOf(members.filter(function (m) { return m.face === 1; }), node);
      var fb = copiesOf(members.filter(function (m) { return m.face === 2; }), node);
      if (fa.copies.length || fb.copies.length) faces = [fa, fb];
    }
    if (!faces && isParticle && members.length >= 2 && members.length % 2 === 0) {
      var h = members.length / 2;
      var a = copiesOf(members.slice(0, h), node), b = copiesOf(members.slice(h), node);
      // Both halves must be plausible HALF-OCTAMERS. "Same number of copies" is not enough: a
      // completed query IR like `(H3:K27M@H4:K16ac)` has six members — H3ᴹ, H3, H4ᴬᶜ, H4, {H2A}2,
      // {H2B}2 — and splitting it down the middle produced a "face" holding two H3 and no H2A,
      // which then lost seats for the families that fell entirely into one half. A real face holds
      // AT MOST ONE copy of each family, and the two faces cover the same families.
      if (a.copies.length && halfOctamer(a.copies) && halfOctamer(b.copies)
          && famSet(a.copies) === famSet(b.copies)) faces = [a, b];
    }

    var byFam = {}, pins = [];
    if (faces) {
      // THE DYAD FLIP. The two faces are related by a symmetry, and `interpret2` canonicalises its
      // arrangement STRING under it (`flipSig`, taking the lexicographically smaller of the two) while
      // leaving the world IR unflipped. Rendering the IR's own face order therefore lit the wrong copy
      // for exactly those worlds whose canonical string is the flipped one — the cartoon and its own
      // tile disagreeing about which half of the particle carries the mark. Applying the same rule
      // here makes them agree by construction rather than by luck.
      // THE FACE ORDER IS THE NODE'S OWN (deleted here 2026-08-05, BB).
      //
      // A canonicalising swap stood here: when the members were NOT face-stamped it compared the two
      // face orders with `orderSig` and took the smaller. It existed because `interpret2`
      // canonicalised its arrangement STRING under the dyad while leaving the world IR unflipped, so
      // the cartoon had to re-derive the same choice or light the wrong copy. `interpret2` was
      // deleted on 2026-08-05 and `interpret3` stamps `face` on every world member, which had already
      // reduced the swap to `!tagged` — dead for worlds, live only for a node the enumerator never
      // touched, where it reordered faces on an argument that no longer holds.
      //
      // Measured before deleting: no seat assignment in the corpus moves. The untagged path is
      // reached by materialized QUERY nodes (`materialize3` does not stamp `face`), and for those the
      // node's own member order is what the reader wrote.
      pins = faces[0].pins.concat(faces[1].pins);
      faces.forEach(function (face, fi) {
        FAMS.forEach(function (f) {
          face.copies.filter(function (c) { return c.family === f; })
            .forEach(function (c) { (byFam[f] = byFam[f] || [])[fi] = c; });
        });
      });
    } else {
      var all = copiesOf(members, node);
      pins = all.pins;
      // No face structure to honour: order each family\'s copies canonically so the picture is
      // stable across renders of the same node.
      FAMS.forEach(function (f) {
        byFam[f] = all.copies.filter(function (c) { return c.family === f; })
          .sort(function (x, y) { var i = copySig(x), j = copySig(y); return i < j ? -1 : i > j ? 1 : 0; });
      });
    }

    // THE FRAME. A PARTICLE (dna != null) always has all eight seats — a tetrasome is a nucleosome
    // with two EMPTY ones, and those empty seats are what make it readable as a tetrasome rather than
    // as a small tetramer. They cannot come from the membership: `lift2` CONSUMES a `count: 0` member
    // into an exclusion, so `(H3@H4@{H2A}0@{H2B}0)` resolves to four proteoforms with no trace of the
    // absence. What separates it from a free `[H3@H4@H3@H4]` is the DNA — the same field `classify2`
    // reads to tell a tetrasome from a tetramer, so the picture and the word agree by construction.
    //
    // A FREE assembly gets only the seats it fills: a dimer is two subunits, not eight with six holes.
    var out = {}, order = [];
    FAMS.forEach(function (fam) {
      // COPY k GOES TO SEAT k [BB 2026-08-11]. `seatOrder(atlas, fam)` stood here, ordering the two
      // seats by `particle-priority` so copy k landed on "the seat the asset marks as sign-copy k".
      // That answers a DIFFERENT question — which seat carries the ± sign for a family — and it is
      // a PER-FAMILY answer, while a face is one physical half of one particle and needs the same
      // answer for all four families. Priority agrees with the seat number for three families and
      // deviates for the fourth, so a co-bracket's marks landed three-on-one-half and one on the
      // other: `([H3K27M@H4S1C@H2BK120ub][…])` drew the H3 mark on H3:2 and the rest on :1, and the
      // picture said a different copy carried the modification than the notation did.
      //
      // A world now stamps `face` as the copy number itself, so there is nothing left to look up.
      for (var s = 1; s <= 2; s++) {
        var seat = fam + ':' + s, c = (byFam[fam] || [])[s - 1];
        if (c) { out[seat] = Object.assign({ seat: seat }, c); order.push(seat); }
        else if (isParticle) {
          out[seat] = { seat: seat, family: fam, occupied: false, variant: null, marks: [], pin: null };
          order.push(seat);
        }
      }
    });

    var P = deps || {};
    return {
      seats: out, order: order, pins: pins,
      kind: P.classify2 ? P.classify2(node) : null,
      counts: P.compositionCounts ? P.compositionCounts(node) : null,
      dna: isParticle ? node.dna : null,
    };
  }

  // ── layout ──────────────────────────────────────────────────────────────────────────────────────
  // opts:
  //   atlas          (required) build/sprite-atlas.json — the baked geometry
  //   dnaMode        'auto' | 'off'; 'auto' follows the node's own `dna` field. It can SUPPRESS
  //                  DNA (a legend glyph) but never add it — that would make the picture disagree
  //                  with `classify2`, which reads the same field to tell a tetramer from a tetrasome.
  //   arrayMember    include the linker strands so adjacent particles join
  //   leadingLinker  false on the first array member — nothing joins on its left
  //
  // SELECTION IS NOT DRAWN HERE ANY MORE (BB, 2026-07-31). There was a `selected` option that pushed
  // the atlas's `selector` part — a 30%-opacity disc behind the bead. It was the one selection state
  // on the page that lived INSIDE the artwork, which is also where its contrast was worst: muted grey
  // under saturated family fills. The unit bar marks its own selection now, with a dot above the
  // bead, and this renderer draws the particle and nothing about UI state.
  //
  // The atlas keeps the `selector` part; it is simply never pushed.
  function layout(sm, opts) {
    opts = opts || {};
    // BELOW the default, not above it: reading `opts.deps` first made `layout(sm)` throw on the very
    // line the default exists to prevent. Reviewed 2026-08-05.
    var reg = (opts.deps && opts.deps.DEFAULT_REGISTRY) || (root.nucleosomeParser2 && root.nucleosomeParser2.DEFAULT_REGISTRY) || null;
    var atlas = opts.atlas;
    if (!atlas || !atlas.parts || !atlas.parts.length)
      throw new Error('particle-scene: no sprite atlas. An empty atlas renders a plausible blank '
                    + 'bead, so this is an error rather than a fallback.');

    var wantDna = opts.dnaMode === 'off' ? false : (sm.dna != null);
    var arrayMember = !!opts.arrayMember;
    var vb = (wantDna && arrayMember) ? atlas.viewBox : (atlas.coreViewBox || atlas.viewBox);

    var frameCount = (atlas && atlas.keyTimes) ? atlas.keyTimes.split(';').length : 0;
    // ELEVEN DISTINCT FRAMES, NOT TWELVE (Minor 7, review 2026-08-11). `keyTimes` carries one entry
    // per decimated sample PLUS the loop wrap that closes the SMIL cycle back to frame 0 — spec §2
    // says eleven frames, and measured, `frames[0] === frames[frameCount - 1]`. Hashing mod the full
    // `frameCount` gave a static bead's pose two ways to land on frame 0 (index 0 itself, and the
    // wrap index), so it was drawn roughly twice as often as any other pose. This does NOT touch
    // `values`/`keyTimes` — the wrap stays in the SMIL, animating the selected bead unchanged — it
    // only excludes the wrap from the population a STATIC bead's pose is drawn from.
    var poseCount = frameCount;
    if (frameCount > 1) {
      var wraps = atlas.parts.some(function (p) {
        return p.frames && p.frames.length === frameCount && p.frames[0] === p.frames[frameCount - 1];
      });
      if (wraps) poseCount = frameCount - 1;
    }
    var frame = (opts && typeof opts.frame === 'number')
      ? opts.frame : frameOf(identityOf(sm), poseCount);

    var parts = [], dots = [];
    atlas.parts.forEach(function (p) {
      if (p.kind === 'selector') return;           // never drawn — see the header note on selection
      if (p.kind === 'dna' || p.kind === 'linker') {
        if (!wantDna) return;
        if (p.kind === 'linker') {
          if (!arrayMember) return;
          if (p.id === 'DNA:linker1' && opts.leadingLinker === false) return;
        }
        parts.push({ id: p.id, markup: p.markup, cls: 'bead-dna' });
        return;
      }
      var st = sm.seats[p.seat];
      if (!st) return;                                        // this copy is not in this particle
      if (!st.occupied) { parts.push({ id: p.id, markup: atFrame(p, frame), cls: 'bead-absent', wrap: true, frames: p.frames }); return; }
      // A VARIANT COPY IS RECOLOURED WHOLE — fold and tails (BB, 2026-07-25). Restricting this to the
      // HFD left a dark core wearing wild-type arms, which reads as a fold-domain annotation rather
      // than as a different protein. The old renderer inlined every part of the copy; this does too.
      if (st.variant) {
        // The outline is the black underlay that gives the tube its edge and its open fold end.
        // Tinting it would erase the outline rather than recolour the copy.
        var tint = !/:outline$/.test(p.part || '');
        parts.push({ id: p.id, markup: tint ? recolor(atFrame(p, frame), FAM_DARK[st.family] || '#555') : atFrame(p, frame),
                     cls: null, frames: p.frames });
        return;
      }
      parts.push({ id: p.id, markup: atFrame(p, frame), cls: null, frames: p.frames });
    });

    // One dot per modification, at that residue's point on the traced chain. A mark whose residue
    // runs past the modelled trajectory falls back to the subunit centroid — recorded as such, so a
    // numbering regression shows up as `placement: 'centroid'` in the scene rather than as a dot
    // that merely looks a bit central.
    sm.order.forEach(function (seat) {
      var st = sm.seats[seat];
      if (!st.occupied || !st.marks.length) return;
      // Per-frame now: the mark must sit on the tail as THIS bead draws it. The shape guard keeps a
      // pre-frames atlas working, which is what makes Tasks 2 and 4 independently revertible.
      var all = atlas.trajectories[seat] || [];
      var framed = all.length && Array.isArray(all[0]) && Array.isArray(all[0][0]);
      var traj = framed ? (all[frame % all.length] || []) : all;
      var c = atlas.centroids[seat];
      var fill = st.variant ? (FAM_DARK[st.family] || '#555') : (FAM_LIGHT[st.family] || '#999');
      st.marks.forEach(function (mk) {
        // A COLUMN IS NOT A RESIDUE NUMBER. `traj` is the traced chain indexed by the molecule's OWN
        // position, and an interpret3 world carries the mark's ALIGNMENT COLUMN — 148 for caH2B
        // K120, where the chain has ~126 points. `traj[147]` is undefined, so the dot fell back to
        // the subunit centroid and the mark appeared merely "centred". The scene already recorded
        // that as `placement: 'centroid'` for exactly this reason.
        //
        // THE NODE SAYS WHICH COORDINATE IT CARRIES; NO CALLER DECLARES IT. `opts.materialized` used
        // to, because `beadsHtml` handed over either a world (alignment COLUMNS) or the raw query IR
        // (authored numbers) — and a flag that the caller must remember is a flag the caller can get
        // wrong, silently: column 15 is a real trajectory index, so `H2A:K5ac` drawn raw landed on
        // residue 15 with nothing to give it away.
        //
        // `anchor` is `materialize3`'s own stamp — it is the molecule whose numbering the numbers are
        // in, it is what R30 reads to refuse re-materialization, and measured across the corpus it is
        // set on every materialized copy and on no raw one. So the conversion happens exactly where
        // there is something to convert WITH, and a node that was never materialized is drawn in the
        // numbering it already carries. The two cannot disagree, because only one of them is asked.
        //
        // The old `accession[0] || printRefOf(...)` fallbacks are gone with the flag: they were the
        // re-guessing the anchor exists to prevent, and they picked different molecules than the
        // material card did — for `H2B1A:K121ub`, Q96A08 against P62807, two molecules numbering the
        // same mark differently.
        var own = mk.position;
        if (st.anchor && reg && reg.ownAtCol && typeof own === 'number') {
          var o = reg.ownAtCol(st.anchor, own);
          own = (o == null) ? -1 : o;              // no counterpart here → no dot, not a wrong dot
        }
        var pt = (own >= 1 && traj[own - 1]) ? traj[own - 1] : null;
        var placement = pt ? 'trajectory' : 'centroid';
        var xy = pt ? { x: pt[0], y: pt[1] } : c;
        if (!xy) return;
        dots.push({ x: xy.x, y: xy.y, seat: seat, fill: fill,
                    position: own, aln_column: st.anchor ? mk.position : null,
                    token: mk.token, placement: placement,
                    // The mark's position in EVERY frame, so a selected bead can move it with its residue.
                    // Null when this mark fell back to the centroid — there is nothing to ride.
                    track: (framed && placement === 'trajectory')
                      ? all.map(function (f) { return f[own - 1] || null; })
                      : null });
      });
    });

    // WHERE THIS BEAD'S TIMELINE STARTS. The pose is a frame index; the same pose is a POINT IN
    // TIME, because `keyTimes[i]` is exactly the fraction of the cycle at which frame i is shown.
    // Handing that out lets a paused timeline and the static markup agree instead of merely being
    // near each other — a bead resumed at `phase` starts on the frame it was already drawing, so
    // nothing jumps when it begins to move.
    var phase = null;
    if (atlas.keyTimes && atlas.dur) {
      var kts = atlas.keyTimes.split(';');
      var secs = parseFloat(atlas.dur);                       // "24s" — SMIL's own spelling
      if (kts[frame] != null && isFinite(secs)) phase = parseFloat(kts[frame]) * secs;
    }
    return { viewBox: vb, transform: atlas.groupTransform || '', parts: parts, dots: dots,
             kind: sm.kind, dna: wantDna, frame: frame, phase: phase };
  }

  // `none` IS NOT A COLOUR (BB, 2026-08-11), and a stroked part carries its colour in `stroke`.
  // A drawn tail was a filled outline; an animated tail is a stroked centreline, so tinting only
  // `fill` would leave a variant copy with a recoloured fold and wild-type arms.
  //
  // WHICH ATTRIBUTE CARRIES THE COLOUR IS A FACT ABOUT THE SHAPE, NOT ABOUT ITS NAME (review,
  // 2026-08-11, Important 3). This used to rewrite `fill` and `stroke` unconditionally, with the
  // caller keying a `:outline`-suffix guard to skip the one part that must not be touched
  // (`particle-scene.js`'s `tint` variable, in `layout`). `HFD` is not named `:outline` and is not
  // guarded, and it is a FILLED shape — `fill="#ffff99" stroke="#000000"` — whose stroke is the
  // fold's own black edge, not a colour waiting to be chosen. Global-over-`(fill|stroke)` repainted
  // it the family colour and erased the edge, turning the fold into an unbordered blob.
  //
  // The real discriminator is `fill="none"`: a STROKED part (the animated tail centreline) has no
  // fill at all and carries its colour in `stroke`, so `stroke` is what must move. A FILLED part (a
  // fold, or a standalone-only drawn tail) carries its colour in `fill`; whatever it draws in
  // `stroke` is edge ink, not identity, and stays put. Asking the element itself — rather than
  // trusting the caller to have named the part correctly — means a future part with no `:outline` in
  // its id still gets this right.
  function recolor(markup, hex) {
    var stroked = /\bfill\s*=\s*"none"/i.test(markup) || /fill\s*:\s*none\b/i.test(markup);
    var attrRe = stroked ? /(fill|stroke)\s*=\s*"(?!none")[^"]*"/gi : /(fill)\s*=\s*"(?!none")[^"]*"/gi;
    var out = markup.replace(attrRe, function (m, attr) { return attr + '="' + hex + '"'; });
    out = stroked ? out.replace(/stroke\s*:\s*#[0-9a-fA-F]+/i, 'stroke:' + hex)
                  : out.replace(/fill\s*:\s*#[0-9a-fA-F]+/i, 'fill:' + hex);
    return out;
  }

  // ── emit ────────────────────────────────────────────────────────────────────────────────────────
  // Syntax only. No decisions live here, so nothing about the picture can be decided in two places.
  function emit(scene, opts) {
    opts = opts || {};
    // Animation is opt-in and shares one clock: `keyTimes`/`dur` come off the atlas, so a tail's
    // `d` and its riders' `cx`/`cy` never drift out of sync with each other.
    var atlas = opts.atlas || {};
    var kt = atlas.keyTimes, dur = atlas.dur || '24s';
    function anim(attr, vals) {
      return '<animate attributeName="' + attr + '" dur="' + dur
           + '" repeatCount="indefinite" calcMode="linear" keyTimes="' + kt
           + '" values="' + vals + '"/>';
    }
    var inner = scene.parts.map(function (p) {
      // Animate the RAW markup first — `p.wrap` needs the unclassed version to wrap (the class
      // goes on the `<g>` instead), and reading `p.markup` again at the return line would throw
      // this away and draw a ghost seat's tail frozen mid-pose.
      var raw = p.markup;
      if (opts.animate && kt && p.frames && p.frames.length) {
        raw = raw.replace(/\/>$/, '>') + anim('d', p.frames.join(';')) + '</path>';
      }
      var m = p.cls ? raw.replace(/^<(\w+)/, '<$1 class="' + p.cls + '"') : raw;
      return p.wrap ? '<g class="' + p.cls + '">' + raw + '</g>' : m;
    }).join('');
    var dots = scene.dots.map(function (d) {
      var c = '<circle class="bead-dot" fill="' + d.fill + '" cx="' + d.x + '" cy="' + d.y + '" r="1.7"';
      // A track containing a `null` (a residue that only rode the chain in SOME frames) would emit a
      // broken `values` list, so `.every(Boolean)` guards it — not merely `d.track`, which a
      // centroid-fallback mark also carries as `null` and would otherwise crash the `.map` below.
      // A MARK IS TWO CIRCLES AND BOTH MUST TRAVEL [BB 2026-08-11]. The dot is a coloured disc with
      // a small black centre, and only the disc was animated — so on a selected bead the centre
      // stayed where the residue had been while its own disc moved out from under it. Neither
      // circle is the mark on its own; they are one mark drawn twice, and they share one track.
      var cxv = d.track && d.track.every(Boolean)
        ? d.track.map(function (p) { return p[0]; }).join(';') : null;
      var cyv = cxv ? d.track.map(function (p) { return p[1]; }).join(';') : null;
      var mark = '<circle class="bead-dot-mark" cx="' + d.x + '" cy="' + d.y + '" r="0.62"';
      if (opts.animate && kt && cxv) {
        return c + '>' + anim('cx', cxv) + anim('cy', cyv) + '</circle>'
             + mark + '>' + anim('cx', cxv) + anim('cy', cyv) + '</circle>';
      }
      return c + '/>' + mark + '/>';
    }).join('');
    // `data-phase` is the ONLY thing the DOM layer needs to know about posing: it drives the
    // timeline with `setCurrentTime`, and has no business knowing that a pose came from a hash.
    var phaseAttr = (opts.animate && kt && scene.phase != null)
      ? ' data-phase="' + scene.phase.toFixed(4) + '"' : '';
    return '<svg class="bead" viewBox="' + scene.viewBox + '"' + phaseAttr + ' aria-hidden="true">'
         + '<g transform="' + scene.transform + '">' + inner + dots + '</g></svg>';
  }

  // ── the whole thing ─────────────────────────────────────────────────────────────────────────────
  // An ARRAY recurses and composes: each particle keeps its own full (linker-margin) frame and is
  // translated by one frame width, so the strands join inside ONE <svg>. Array geometry therefore
  // lives here rather than in CSS abutment of sibling elements plus a `hideLinker1` flag threaded
  // down from a v1 tree check.
  function renderParticle(node, opts) {
    opts = opts || {};
    if (!node || typeof node !== 'object') return '';
    // THE PARTICLES, NOT THE MEMBERS (BB, 2026-08-06). This asked the member list twice — once for
    // "is this an array" and once for how many beads to draw — and both are wrong where a particle
    // carries its own count: `(H3)3` is ONE member and three nucleosomes, so it drew as a single
    // bead. `beadsHtml` never hands a whole array in today (it passes one unit at a time), which is
    // the only reason this was latent rather than visible; `particlesOf` is the same expansion the
    // units bar and the Arrays gate already use.
    // ONLY AN ARRAY EXPANDS HERE. A bare assembly handed in is ONE particle to draw, however large
    // its own count: `unitNodes` has already turned that repetition into separate UNITS, and
    // `beadsHtml` calls this once per unit. Expanding it again drew `(H3)2` as two units of two beads
    // — a 4-mer — while `(H3)(H3)`, whose members each carry count 1, was right (BB, 2026-08-07).
    var parts = (node.node === 'array') ? particlesFor(node) : [];
    if (parts.length > 1) {
      var vb = (opts.atlas.viewBox || '0 0 1 1').split(/\s+/).map(Number);
      var n = parts.length;
      // ONE RULE FOR BOTH CALLERS (review, 2026-08-11): "only the selected bead animates" (spec §2)
      // is stated per BEAD, and a composed array here draws several beads inside one <svg>. There is
      // no per-member selection to honour — `opts.animate` names the whole call's ONE selected bead,
      // and this call is not that; it is a chain of neighbours. Forwarding `animate` to every member
      // therefore animated every bead in the chain, which is the "row of clones in motion" the spec's
      // scope decision exists to prevent. Forcing it off here — rather than, say, animating only
      // member 0 — keeps the rule uniform: `renderParticle` animates AT MOST the one particle a
      // single-particle call draws, never a member of a multi-particle composition.
      var gs = parts.map(function (m, i) {
        var memberOpts = Object.assign({}, opts, {
          arrayMember: true, leadingLinker: i !== 0, animate: false,
        });
        var sc = layout(seats(m, opts.deps, opts.atlas), memberOpts);
        var inner = emit(sc, memberOpts).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
        return '<g transform="translate(' + (i * vb[2]) + ',0)">' + inner + '</g>';
      }).join('');
      // CROP THE OUTER EDGES ONLY (2026-09-25). A single particle already trims to `coreViewBox` —
      // the octamer-centred square margin either side of the full frame. This composition never did:
      // it draws `n` whole frames end to end, so a dinucleosome's viewBox was exactly 2x the single
      // frame width (124.092 measured, TODO.md's "chip previews" entry) with the SAME left/right
      // margins a lone particle already trims sitting exposed at the two outer ends. An INTERIOR
      // linker is real geometry joining two particles and must stay full width — only the run's own
      // two open ends (nothing before the first particle, nothing after the last) get the crop, so
      // the margins removed here are read off `coreViewBox` against `viewBox`, the same numbers a
      // lone bead already uses, rather than a second hand-tuned constant.
      var coreVb = (opts.atlas.coreViewBox || '').split(/\s+/).map(Number);
      var leftMargin = coreVb.length === 4 ? (coreVb[0] - vb[0]) : 0;
      var rightMargin = coreVb.length === 4 ? ((vb[0] + vb[2]) - (coreVb[0] + coreVb[2])) : 0;
      // Rounded to the atlas's own precision (scripts/build_sprite_atlas.js's `round`, 3 decimals) —
      // the inputs are two independently-rounded numbers subtracted from a multiple of a third, which
      // otherwise prints trailing float noise (e.g. 107.40700099999998) into a checked-in test fixture.
      var round3 = function (x) { return Math.round(x * 1000) / 1000; };
      var cropX = round3(vb[0] + leftMargin);
      var cropW = round3((n * vb[2]) - leftMargin - rightMargin);
      return '<svg class="bead bead-array" viewBox="' + cropX + ' ' + vb[1] + ' ' + cropW + ' ' + vb[3]
           + '" aria-hidden="true">' + gs + '</svg>';
    }
    // `particleOf`, not a fourth hand-written unwrap — this file already wraps it (see the top).
    // CRITICAL FIX (review, 2026-08-11): this used to call `emit(layout(...))` — ONE argument — so
    // `opts.animate` and `opts.atlas` (for `keyTimes`/`dur`) never reached `emit`, and the selected
    // bead, the only one the design ever animates, silently rendered static. `opts` must reach `emit`
    // the same way it already does in the array branch above.
    var one = particleOf(node);
    return emit(layout(seats(one, opts.deps, opts.atlas), opts), opts);
  }

  var api = { seats: seats, layout: layout, emit: emit, renderParticle: renderParticle,
              FAM_DARK: FAM_DARK, FAM_LIGHT: FAM_LIGHT, recolor: recolor,
              markToken: markToken, pinnedVariant: pinnedVariant,
              frameOf: frameOf, identityOf: identityOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/example-chips.js
// The example chips under the query bar. Extracted from shell.js on 2026-08-15 (U6 of
// specs/2026-08-13-shell-seams.md).
//
// Chrome, and the only unit in the seam map that nothing is entangled with in either direction. It
// reads two things — the query field, and whether there is an answer on screen — and writes four
// elements of its own. Nothing in the page calls into it except through the two entry points it
// already published on `window`.
//
// THE BOUNDARY WAS HALF-DRAWN HERE BEFORE ANY OF THIS. `syncChips` and `peekChips` were hung on
// `window` rather than declared bare, because the reveal needed a real pointer and so what was
// testable had been split from when it was asked. That was the `*-model.js` argument made inside one
// file, which is why this unit ranked last: it had already solved its own version of the problem.
// `peekChips` is gone (2026-09-23) and the split went with it; `syncChips` stays on `window` —
// `page-consumers.test.js`
// reaches them there, and on the page `window` IS the object the module exports onto.
(function (root) {
  'use strict';

  let _h = {};
  function configureChips(host) {
    _h = host || {};
    // AND SYNC, because until this call there was no field to look at. The strip binds at module
    // load and ends with a `syncChips()`, which was correct while this code lived in shell.js with
    // `inputEl` in hand. Here it runs before shell.js hands the field over, so it read every load as
    // "bar empty" — a fixed reset wearing the name of a synchronisation. Invisible on a cold load,
    // where the bar IS empty; wrong on a back-navigation or session restore, where the browser
    // repopulates the field and the examples would sit over the answer until `dbReady()` re-dispatches
    // `input` seconds later.
    if (typeof root.syncChips === 'function') root.syncChips();
  }
  const queryInput = () => (_h.queryInput ? _h.queryInput() : null);
  const currentIR  = () => (_h.currentIR ? _h.currentIR() : null);

  // ONE COPY MUST BE WIDER THAN THE VIEWPORT, or the wrap at span*0.5 / span*1.5 lands the reader
  // somewhere visibly different from where they were. Three copies was safe at fifteen chips
  // (~2,600px per copy) and is not at six (~1,050px) on a laptop. The chip count is an external
  // decision in _data/chips.yml, so this is derived rather than chosen.
  //
  // `* 2` is a full viewport either side of the middle copy, which is what the two thresholds need;
  // `+ 1` is the middle copy itself. The floor of 3 is the geometry: there is no middle without one
  // copy either side of it.
  function copiesFor(viewportWidth, oneCopyWidth) {
    const w = Number(oneCopyWidth);
    if (!Number.isFinite(w) || w <= 0) return 3;      // measure() can run before layout has settled
    const v = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
    return Math.max(3, Math.ceil((v * 2) / w) + 1);
  }

  // ── Example chips ────────────────────────────────────────────────────────────────────────────────
  // An invitation, not a toolbar: laid out only while the query bar is EMPTY. Once there is a query of
  // your own, a row of other people's queries is noise sitting between you and your answer — so it
  // tucks (see the dock below), and rests are how you ask for it back.
  //
  // ONE CIRCULAR STRIP, not six at a time (BB, 2026-07-30). It used to show a random six of the pool
  // with a `⟳` to redraw. The strip says the same thing better: scrolling either way runs on for as
  // long as you keep going, so the breadth is demonstrated instead of promised, and no chip is a chip
  // you may or may not ever meet.
  //
  // Circular by CLONING: the track is repeated and the viewport is kept inside the middle copy,
  // jumping by one copy-width whenever it drifts out. The jump is invisible because the copies are
  // identical — that identity is the whole trick, so the clones must never be edited or filtered
  // independently of the original.
  //
  // HOW MANY COPIES IS DERIVED, NOT CHOSEN — see `copiesFor` above. One copy has to be wider than
  // the viewport or the reader can see past the middle copy into a clone, and the chip COUNT is an
  // external decision in `_data/chips.yml` that no layout may depend on.
  //
  // Nothing moves on its own, which was also true of the ⟳: an auto-advancing strip makes every target
  // a moving one, reads as decoration on an instrument, and has no honest answer to
  // prefers-reduced-motion. The motion is the reader's.
  // NO DOM, NO CHIPS. shell.js only ever ran with a page under it; a module is also `require`d,
  // and this binds at load — so the guard is on the whole block rather than on each element.
  if (typeof document !== 'undefined') (function bindChips() {
    const box   = document.getElementById('chips');
    const track = document.getElementById('chips-track');
    if (!box) return;

    // THE CHIP LABEL IS AUTHORED, NOT DERIVED (BB, 2026-08-06). For a few hours the label was the
    // page's own printed descriptor, computed here from `data-q`. Reverted: a chip is an INVITATION,
    // and the shortest true invitation is not always the canonical one — `(H4K16ac)-30-(H4)` says what
    // it offers, while its printed form spells out the second particle's whole unmarked complement.
    // So the text comes from `docs/_data/chips.yml` (`label`, defaulting to `q`) and is edited THERE.
    //
    // Styling still applies everywhere the page is REPORTING something it worked out — captions,
    // material cells, measurement rows. The difference is authorship, not spelling.

    // Delegated, because two thirds of the chips on screen are clones that did not exist at bind time.
    // `dragging` is why this is not a plain click handler: a drag ends with a click on whatever chip
    // is under the pointer, and inserting a query the reader was only scrolling past is worse than
    // doing nothing.
    //
    // INSERTS `data-q`, NOT THE LABEL — the two are deliberately different since 2026-08-06. The label
    // is authored prose from chips.yml; `data-q` is the notation. (This handler was deleted by accident
    // when the label-derivation block above it was reverted, which is how clicking a chip did nothing.)
    box.addEventListener('click', (e) => {
      const chip = e.target.closest && e.target.closest('.chip');
      if (!chip || dragged) return;
      const q = queryInput();
      if (!q) return;                                   // no host, no field — see configureChips
      q.value = chip.dataset.q;
      q.focus();
      // A CHIP RUNS, and it is now the only thing besides Return that does [BB 2026-08-25]. Typing
      // stopped running the query, so this can no longer get there by dispatching a synthetic
      // `input` — that event means "the text changed, update the chrome" and nothing more. A chip is
      // a worked EXAMPLE and seeing the answer is the whole point of clicking one, which is exactly
      // the distinction the atlas comment draws when it explains why a CELL does not run.
      //
      // `runQuery` syncs the strip itself, so there is no separate `syncChips` here — that is the
      // whole reason it does, since every caller needs the same two things in the same order.
      if (window.runQuery) window.runQuery();
    });

    // The number of copies PRESENT IN THE TRACK — not a target. It only ever goes up (see `grow`),
    // so `span` is always `scrollWidth / copies` and never a stale divisor.
    let copies = 1;
    let span = 0;                     // width of one copy of the track, in scroll px
    let dragged = false;
    // Declared up here with `dragged` and not with the drag handlers below, because the resize
    // observer reads it and is installed first: a callback that fires before the declaration ran
    // would hit the dead zone rather than `false`. It cannot today — observers deliver at the end of
    // a frame — but the ordering is not something this block should have to depend on.
    let down = false;
    // Published out of the strip block so `syncChips` can reach it, and a no-op when there is no
    // track — the render suites drive this file against a stub DOM where the whole strip is absent,
    // and a `syncChips` that threw there would take the clear button down with it.
    let recentre = () => {};

    // `track.children &&` is not defensive padding: the stub DOM the render suites drive shell.js
    // against answers getElementById with a generic element that has no children collection, and this
    // whole block is decoration those suites do not exercise.
    if (track && track.children && track.children.length) {
      const originals = Array.from(track.children);
      const addCopies = (n) => {
        for (let k = 0; k < n; k++) for (const c of originals) {
          const clone = c.cloneNode(true);
          // A clone is the same chip said again. To a screen reader that is noise, and to the tab
          // order it is a second stop at the same place — so the copies are for the eye only.
          clone.setAttribute('aria-hidden', 'true');
          track.appendChild(clone);
        }
        copies += n;
      };
      // At this point the track holds exactly one copy, so its scrollWidth IS one copy's width.
      addCopies(copiesFor(box.clientWidth, track.scrollWidth) - copies);
      const measure = () => { span = track.scrollWidth / copies; };

      // GROWS, NEVER SHRINKS. A window that gets wider can need more copies; one that gets narrower
      // needs fewer, and removing them mid-scroll would move the reader — the surplus costs a few
      // hidden clones and buys a strip that never jumps under a hand.
      const grow = () => {
        measure();
        if (!span) return;
        const want = copiesFor(box.clientWidth, span);
        if (want > copies) { addCopies(want - copies); measure(); }
      };

      // THE CARD BEFORE THE FIRST ONE SHOWS ITS TAIL [BB 2026-08-26]. The strip rests with the
      // PRECEDING chip's last fifth visible at the left edge — not with the first chip's leading
      // fifth cut off, which is what this did on the first attempt and is the opposite gesture: a
      // clipped first card says "you are looking at the middle of this card", while a card tail
      // says "there is another one behind you".
      //
      // The strip is circular and has no ends, but a row that begins flush at its own left edge
      // looks like a row that BEGINS there, leaving the only evidence otherwise a chip clipped at
      // the far right, off where nobody is looking.
      //
      // MEASURED OFF THE ELEMENT, not computed from a width. The chip before the middle copy's
      // first is the last chip of the copy before it, and the flex `gap` sits between them — so
      // taking its right edge and backing off a fifth of its width lands the rest position exactly,
      // gap included, without this code needing to know the gap exists.
      const TAIL = 0.2;
      const centre = () => {
        measure();
        if (!span) return;
        const prev = track.children[originals.length - 1];   // last chip of the FIRST copy
        if (!prev) { box.scrollLeft = span; return; }
        const tRect = track.getBoundingClientRect();
        const pRect = prev.getBoundingClientRect();
        // Both rects move together as the box scrolls, so their difference is scroll-independent.
        box.scrollLeft = (pRect.left - tRect.left) + pRect.width * (1 - TAIL);
      };
      centre();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(centre);
      recentre = centre;

      // THE REST POSITION IS A FUNCTION OF THE LAYOUT, so it has to be recomputed when the layout
      // moves — which the observer did not do. It re-measured `span` and stopped, and `span` is the
      // wrap-around arithmetic, not the offset: the strip kept wrapping correctly at a rest position
      // computed once, against widths that no longer applied.
      //
      // The widths really do move, and not only on a window resize. `.chips-dock.tucked` hides
      // `.chip-artbox` and `.chip-head` outright, so a tucked chip is one line of notation and an
      // untucked one is a card — the offset that lands the preceding card's tail at the left edge is
      // a different number in each state, and the strip crosses between them every time the menu
      // opens or closes.
      //
      // NOT WHILE A POINTER IS DOWN. Mid-drag the reader is the one moving the strip, and re-resting
      // it under their finger is the page taking the gesture back. Nothing else is guarded: the
      // strip is circular, so a scroll offset is not a place the reader can be returned FROM — every
      // copy shows the same chips — and a rest position that is right is worth more than one that is
      // where it was left.
      // WATCH `box` TOO, NOT ONLY `track`. `grow()` reads `box.clientWidth` — "a window that gets
      // wider can need more copies" — but `.chips-track { flex: none }` inside a flex `.chips`
      // (`_shell.scss:396`) means the track's border box is max-content: it changes only when the
      // chip CONTENT changes (tuck/untuck, a copy appended), never when the viewport resizes. An
      // observer on `track` alone never fires for the one case the comment above names; `box` is
      // the element whose size the widen-the-window case actually changes.
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => { grow(); if (down) measure(); else centre(); });
        ro.observe(track);
        ro.observe(box);
      }

      // Keep the viewport inside the middle copy. Thresholds at half a copy either side rather than at
      // the hard edges: momentum scrolling overshoots, and wrapping at 0 would stop the flick dead.
      box.addEventListener('scroll', () => {
        if (!span) return;
        if (box.scrollLeft < span * 0.5) box.scrollLeft += span;
        else if (box.scrollLeft > span * 1.5) box.scrollLeft -= span;
      }, { passive: true });

      // Drag to scroll, since the scrollbar is hidden and a mouse has no horizontal wheel. The wheel
      // is deliberately NOT hijacked: the strip has no end to release at, so a page scroll that
      // happened to pass over it would never get out.
      let startX = 0, startL = 0;      // `down` is declared with `dragged`, above the observer
      box.addEventListener('pointerdown', (e) => {
        down = true; dragged = false; startX = e.clientX; startL = box.scrollLeft;
      });
      box.addEventListener('pointermove', (e) => {
        if (!down) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > 4) dragged = true;      // 4px: a click with a tremor is still a click
        if (dragged) box.scrollLeft = startL - dx;
      });
      const release = () => { down = false; };
      box.addEventListener('pointerup', release);
      box.addEventListener('pointercancel', release);
      box.addEventListener('pointerleave', release);
    }

    // The chips are part of the empty state, so they follow the INPUT, not the parse: a half-typed
    // query is still a query in progress, and having the row reappear mid-token would be the page
    // second-guessing you.
    // ONE function owns both, because they are one state read two ways: the chips are the empty
    // field's invitation and the clear button is the non-empty field's exit. Deriving them separately
    // is how you end up with a clear button on an empty field.
    //
    // `|| ''` is not defensive padding: the stub DOM that page-consumers/measurement-render drive the
    // render path against supplies a #chips element but an input with no `value`, and an absent value
    // means an EMPTY FIELD — which is exactly the state that shows the chips.
    const clearBtn = document.getElementById('qclear');

    // ── The examples TUCK, they do not leave ─────────────────────────────────────────────────────
    // [BB 2026-08-05: "Can the hidden query suggestion bar show up transiently if a result is shown
    // and when the user hovers with their mouse slightly below the query bar and rests there for a
    // bit?"]
    //
    // The row still gets out of the way on the first keystroke, for the reason it always did. What it
    // no longer does is become unreachable: clearing the field was the only way back to the pool, and
    // clearing the field means throwing away the query you came with. Now it goes out of the reading
    // flow and leaves behind the thin band it sat in, which is the hover target — an element with
    // `display: none` has no bounds and cannot be one, which is why this needed a dock at all.
    //
    // A DWELL, NOT A HOVER. The band lies between the field and the answer, so a pointer travelling
    // from one to the other crosses it every time; revealing on entry would flash the strip at someone
    // who was only passing through. The timer is the "rests there for a bit", and it is restarted on
    // every entry, so leaving and coming back means resting again rather than resuming.
    //
    // ONLY OVER AN ANSWER, and asked when the timer FIRES. `syncChips` runs on the keystroke — 150 ms
    // before the parse it would be asking about — so a check made there would be answering about the
    // previous query. An `error` IR counts as no answer: the field is already red and the reason is
    // already on screen where the strip would land.
    const dock = document.getElementById('chips-dock');
    // THE PEEK IS GONE [BB 2026-09-23]. Resting a pointer on the tucked dock's 14px band used to
    // bring the strip back over the answer, after a 280ms dwell; a button did the same for a finger
    // for part of one day. Both are deleted, and the rule that replaces them is simpler than either:
    // THE EXAMPLES BELONG TO THE EMPTY FIELD. They are reached by clearing — the × in the field, or
    // emptying it and pressing Return — and by nothing else.
    //
    // What was wrong with the peek is not that it was hard to find. It put the examples ON TOP of
    // the thing the reader had asked for, and the chips it revealed were the ones whose art had not
    // been fetched, so the reveal was a row of empty boxes over a real answer. The 2026-08-05 ask it
    // answered — "can the suggestion bar show up transiently when the user rests below the bar" —
    // is met by the × instead, which is one deliberate gesture rather than a timed accident.

    // THE STRIP FOLLOWS THE ANSWER, NOT THE FIELD [BB 2026-08-25].
    //
    // It used to tuck on the first keystroke, and that was right while typing RAN the query: text in
    // the field meant an answer was arriving, so the examples were about to be in the way. Under
    // Return-to-run they are different states, and the old rule made the menu unusable — composing
    // `H3` from the atlas and then reaching for a mark took the favorites away, though nothing had
    // been asked and the rest of the menu was still on screen.
    //
    // So the question is now "is there an answer standing", which is `menu-open` — the class
    // `showOnboarding` toggles, and the one rule that already decides whether the menu is showing.
    // The whole menu arrives and leaves together.
    //
    // THE CLEAR BUTTON STILL FOLLOWS THE FIELD, and it is the reason this function's old comment
    // said the two were "one state read two ways". They are not, any more: ✕ is the non-empty
    // field's exit and must appear while you are still composing. One function still owns both,
    // because deriving them apart is how you get a clear button on an empty field.
    // THE TOUCH PEEK WAS ADDED AND REMOVED ON THE SAME DAY [BB 2026-09-23]. A button in the dock
    // band gave a finger the reveal a pointer gets by resting there. It worked and it was wrong:
    // over an answer the strip obstructs the answer, and the chips it reveals are the ones whose
    // art has not loaded, so what a reader gets for the tap is a row of empty boxes across their
    // result. The examples belong to the EMPTY state — reached by clearing the field, which the ×
    // already does — and not to a state that has something to say.
    window.syncChips = function syncChips() {
      const filled = String(queryInput() && queryInput().value || '').trim() !== '';
      const menuOpen = typeof document !== 'undefined' && document.body
        && document.body.classList.contains('menu-open');
      // The state is the DOCK's, not the row's: the row has to stay in the DOM to be summoned back.
      const wasTucked = dock && dock.classList.contains('tucked');
      if (dock) dock.classList.toggle('tucked', !menuOpen);
      if (clearBtn) clearBtn.hidden = !filled;
      // A TUCK IS A LAYOUT CHANGE, and the rest position is measured off the layout. Tucking takes
      // the art and the headline out of every chip, so the chip whose tail rests at the left edge is
      // a different width before and after — measured on the frame AFTER the class lands, because
      // `getBoundingClientRect` inside this call would still be reading the old one.
      //
      // This is also the cold load. The module ends with a `syncChips()` that tucks the dock (the
      // body carries no `menu-open` until shell.js declares the menu state), so the very first
      // `centre()` was computed against the untucked card layout the page never shows at rest.
      //
      // ONLY ON THE CHANGE. `syncChips` runs on every keystroke, and re-resting the strip each time
      // would drag it out from under a reader who had scrolled it and then typed — the state did not
      // move, so neither should the strip.
      if (dock && dock.classList.contains('tucked') !== wasTucked) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(recentre);
        else recentre();
      }
    };

    if (clearBtn) clearBtn.addEventListener('click', () => {
      const q = queryInput();
      if (!q) return;
      q.value = '';
      q.focus();
      // CLEARING RUNS, and it has to. Emptying the field is how you get the page back to its empty
      // state — `onInput` reads a blank field and calls `setEmpty()`, which restores the menu. Under
      // the old rule the synthetic `input` reached that through the debounce; now that typing no
      // longer runs anything, dispatching alone would leave the previous answer standing under an
      // empty bar, which is the one combination that states something false.
      if (window.runQuery) window.runQuery();
      else q.dispatchEvent(new Event('input'));       // no shell yet — at least restore the chrome
    });
    syncChips();
  })();

  // `syncChips` is published on `window` by the block above, deliberately and since before this file
  // existed. `configureChips` is the module's one entry point; `copiesFor` is exported because it is
  // the one piece of this file that can be checked without a layout, and it decides whether the
  // strip is circular.
  const api = { configureChips, copiesFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/atlas-compose.js
// How the atlas dial builds a query string. No DOM, no engine, no registry — see the test.
//
// THE DIAL COMPOSES, IT DOES NOT VALIDATE [BB 2026-08-25]. The reader takes the risk by pressing
// Return, exactly as they do when typing: an input device does not adjudicate keystrokes. This is
// not a concession to difficulty — it converges with the 2026-08-24 ruling that a cell click SETS
// and does not RUN, whose reason was that answering each of 175 targets on the way past is not
// reading, it is being interrupted.
//
// WHY THIS FILE IS PURE. The whole of the new dial behaviour is three string decisions, and none
// of them needs a browser. Kept apart from variant-atlas.js so they can be tested in plain node,
// which is the same `*-model.js` boundary the rest of the page draws — the DOM layer only wires.
(function (root) {
  'use strict';

  // WHY A CLOSED PARTICLE JUXTAPOSES INSTEAD OF JOINING WITH `@`. Two particles are written as
  // neighbours — `(H3K27M)(H3K36me3)` — while `@` separates members WITHIN one assembly. So the
  // separator is decided by what the string already ends with, not by how many tokens have been
  // clicked.
  //
  // AND A NEIGHBOUR IS WRAPPED, WHICH IS THE HALF THIS GOT WRONG. Juxtaposing a BARE token after a
  // `)` composes a string the grammar does not accept at all — measured against the bundle,
  // `(H3)H2A`, `(H3K27M)H2A` and `(H3)(H4)H2A` all fail to parse, and so does `(H3)@H2A`. After a
  // closing paren the grammar admits only another particle, a linker, or a count; there is no
  // spelling of "closed particle, then a bare run", so the run model could not be carried across a
  // wrap and had to be repaired here rather than tolerated downstream.
  //
  // The cost was not the parse error a reader could see. `endsAtPosition` (toppings.js) parses the
  // prefix to decide whether a mark can attach, and answers `false` for anything it cannot parse —
  // so the mark palette went INERT for the whole of the second particle, with every topping click a
  // silent no-op. THE DIAL STILL DOES NOT VALIDATE: it does not ask whether the reader's molecule is
  // the one they meant, which is settled at Return. It only owes them a string the engine can read.
  //
  // THE OPEN GROUP [BB 2026-08-26]. `openGroup` says the trailing `(…)` is one THIS function built
  // and is still accumulating, so a further click joins it — `(H3)(H4)` + `H2B` → `(H3)(H4@H2B)`.
  // Without the bit the two readings are indistinguishable in the string and the wrong one is a
  // legal parse of the wrong molecule: a click after the reader's own Wrap means "start the next
  // particle", and a click after this function's auto-wrap means "and this one too". So the caller
  // holds it — it is the caller that knows whether the last gesture was a wrap or a click — and
  // Wrap CLOSES the group, which is what the button already meant.
  // A `)` IS NOT THE ONLY TAIL AFTER WHICH A BARE RUN IS ILLEGAL. The grammar admits no bare run
  // after a COUNT (`(H3)2`) or a LINKER (`(H3)-50-`) either, and both are strings a reader can type
  // or the dial can hold. Testing only `endsWith(')')` produced `(H3)2@H2A` and `(H3)-50-@H2A`,
  // which do not parse — the SAME failure the header above records and repaired for one tail only:
  // the string is rejected, `endsAtPosition` then answers false for the whole of it, and the mark
  // palette goes inert with every topping click a silent no-op.
  //
  // A count is digits or their subscript spellings; a linker is `-…-`. Nothing else may follow a
  // closing paren, so this enumerates the tails rather than guessing at them.
  const CLOSED_TAIL = /\)(?:[0-9\u2080-\u2089]+|-[^-()]*-)?$/;

  function appendToken(value, token, openGroup) {
    const v = String(value == null ? '' : value).trim();
    const t = String(token == null ? '' : token).trim();
    if (!t) return v;
    if (!v) return t;
    if (!CLOSED_TAIL.test(v)) return v + '@' + t;      // a bare run — unchanged, and legal as it is
    // The open-group join REOPENS a trailing `)`, so it is only available when there is one. After a
    // count or a linker the group is closed by something the reader wrote, and the only legal
    // continuation is a new particle.
    return (openGroup && v.endsWith(')'))
      ? v.slice(0, -1) + '@' + t + ')'                 // join the group this function opened
      : v + '(' + t + ')';                             // a new neighbour, closed so the string parses
  }

  // Wraps the TRAILING RUN: from the end back to the last closing `)`, or to the start if there is
  // none [BB 2026-08-25].
  //
  // A no-op when there is nothing to wrap. `()` is not what the reader asked for and is a worse
  // string than the one they already had, so an empty run returns the input untouched — which is
  // also what makes the button safe to press twice.
  function tacoWrap(value) {
    const v = String(value == null ? '' : value);
    const start = v.lastIndexOf(')') + 1;      // 0 when there is no `)` — the whole string
    const run = v.slice(start);
    if (!run.trim()) return v;
    // A COUNT OR A LINKER IS NOT A RUN. `(H3)2` wrapped to `(H3)(2)` and `(H3)-50-` to `(H3)(-50-)`,
    // both parse errors from inputs that parse — so pressing Wrap silently destroyed the reader's
    // query. There is nothing to wrap in either, which is the same answer an empty run already gets.
    if (/^(?:[0-9\u2080-\u2089]+|-[^-()]*-)$/.test(run.trim())) return v;
    return v.slice(0, start) + '(' + run + ')';
  }

  // The species lock [BB 2026-08-25]. Deliberately crude: one build, one organism. A more
  // sophisticated cross-species build is explicitly not now.
  //
  // WHY IT EXISTS AT ALL. Additive clicking creates a failure that set-mode could not have: two
  // cells from different rings each call `adoptTaxon`, the second wins, and the bar reads as one
  // organism while showing two organisms' proteins — stating one thing and meaning another, which
  // is the exact fault `adoptTaxon` was introduced to fix for the species button.
  //
  // An idea segment names a subtree and no organism, so it passes a null taxon and is never
  // refused: narrowing the context would answer a question the reader did not ask.
  function lockDecision(lockedTaxon, clickedTaxon, fieldIsEmpty) {
    if (clickedTaxon == null) return { allowed: true, taxon: lockedTaxon };
    if (fieldIsEmpty || lockedTaxon == null) return { allowed: true, taxon: clickedTaxon };
    if (clickedTaxon === lockedTaxon) return { allowed: true, taxon: lockedTaxon };
    return { allowed: false, taxon: lockedTaxon };
  }

  // ── THE LOCK IS DERIVED FROM THE BAR, NOT FROM THE LENS [BB 2026-08-30] ──────────────────────
  //
  // It used to be `contextTaxon()` — the organism the "Read as" button spells — and that made the
  // species-gutter label an escape hatch out of the lock it was documented as not touching. The
  // gutter click moves the lens on purpose, because choosing what you read as is how you get OUT of
  // an organism; but while the lock WAS the lens, moving it moved the lock:
  //
  //   click a human cell    a human handle is in the bar, lock 9606
  //   click the Mm gutter   writes no token — and the lock silently becomes 10090
  //   click a mouse cell    lockDecision(10090, 10090, false) ALLOWS it
  //   → a mouse protein joins a bar holding a human one: the exact failure the lock exists to
  //     prevent, reached through the one gesture exempted from it.
  //
  // So the lock asks what the BAR CONTAINS. The lens may still move freely — that was the point of
  // exempting the gutter — it just no longer speaks for which organisms are already in play. This
  // stays PURE and takes its engine and registry as arguments, like everything else in this file.
  //
  // NULL MEANS "NO LOCK", AND EVERY UNCERTAIN CASE RETURNS IT. An idea token names no organism; a
  // bar that already mixes two cannot be made worse and picking one would be a guess about which
  // the reader meant; a mid-edit string that does not parse is not a claim about anything, and
  // refusing every ring until it parses would strand the reader mid-build. This is a composition
  // aid, and the ruling above it stands: the dial composes, Return adjudicates.
  function taxonOfQuery(str, P, registry) {
    var s = String(str == null ? '' : str).trim();
    if (!s) return null;
    if (!P || !registry || typeof P.lift2 !== 'function' || typeof P.parse !== 'function') return null;
    if (typeof P.resolve2 !== 'function' || typeof registry.taxonOfAccession !== 'function') return null;
    // RESOLVE, DO NOT MERELY LIFT. `lift2` leaves a handle RAW — `lift2(parse("H2B3")).accession` is
    // `["H2B3"]`, and `taxonOfAccession` knows nothing about that string — so asking the lifted node
    // returned null for every mnemonic and gene handle. `queryForCell` PREFERS the mnemonic wherever
    // it is a handle, which is 99 of the 175 cells, so the lock was inert for exactly the cells the
    // reader clicks most: fly H2B3 then a human cell was allowed, and the bar mixed organisms
    // through the hole this function was written to close. `resolve2` is the step that turns a
    // handle into an accession.
    var node;
    try { node = P.resolve2(P.lift2(P.parse(s)), {}, registry); } catch (e) { return null; }
    var taxa = {}, n = 0;
    (function descend(x) {
      if (!x || typeof x !== 'object') return;
      var acc = x.accession;
      var list = Array.isArray(acc) ? acc : (acc ? [acc] : []);
      for (var i = 0; i < list.length; i++) {
        var t = null;
        try { t = registry.taxonOfAccession(list[i]); } catch (e) { t = null; }
        if (t == null) continue;
        var k = Number(t);
        if (!taxa[k]) { taxa[k] = true; n++; }
      }
      var ms = x.members || [];
      for (var j = 0; j < ms.length; j++) descend(ms[j]);
    })(node);
    if (n !== 1) return null;                    // none named an organism, or more than one did
    return Number(Object.keys(taxa)[0]);
  }

  const api = { appendToken, tacoWrap, lockDecision, taxonOfQuery };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/variant-atlas.js
// The front-page atlas: 175 proteins and 44 idea segments, every one of them a query.
//
// The SVG is generated by graphics/variants/01_build.R and promoted into _includes/ by
// 03_promote.R. It is INLINED, not an <img>, because an <img> has no reachable DOM — and the whole
// point is that the picture is the input surface.
//
// THE FIGURE ALREADY KNEW WHAT EVERYTHING WAS. This module invents no mapping from pixels to
// meaning: the generator emits `data-token` on each idea wedge and `data-mnemonic` /
// `data-accession` / `data-protein-name` on each cell, because it is the thing that has the
// registry in hand. So this is a listener and a lookup, not a model. If a token here is wrong, it
// is wrong in the parquet, and the fix is upstream.
//
// TWO KINDS OF TARGET, and the difference is the layer:
//
//   .atlas-idea  an IDEA. `caH2B` names a subtree and nothing else — no organism, no accession.
//                Clicking it writes the token and touches nothing else, because narrowing the
//                context would answer a question the reader did not ask.
//
// A CLICK SETS, IT DOES NOT RUN. Both kinds fill the query field — and a cell also moves the
// species lens — and then stop. Return is what asks for an answer. See the click handler.
//   .atlas-cell  a MATERIAL. `H2B3` is a UniProt mnemonic, and mnemonics REPEAT across organisms —
//                H2B3 is Q27484 in C. elegans and a different protein in S. cerevisiae. So the
//                cell click sets the context taxon as well; without it the handle is ambiguous and
//                the reader gets whichever organism the resolver reaches first. The species is not
//                decoration on this click, it is half of what was clicked.
//
// WHY adoptTaxon AND NOT setContextTaxon. Every fix has two halves. `setContextTaxon` writes the
// context YAML, which is what the resolver reads — and leaves the species-lens BUTTON showing the
// organism you were in before, so the page states one thing and means another. `adoptTaxon` writes
// the YAML, moves the button, follows the port and clears the cache. It is exported for exactly
// this. It returns false for an organism the page cannot resolve into, and then the click still
// writes its token: a query in the wrong context beats no query.
(function (root) {
  'use strict';

  let _h = {};

  // The id is `notation-input`, not `q`. This said `q`, which is not an element on the page — so
  // the fallback could only ever return null and a call made without a host was a silent no-op
  // wearing the shape of a fallback. Kept rather than deleted, now that it can actually fire: this
  // module is inlined into one page and the host comes from shell.js, but a no-op that looks like
  // a safety net is worse than either having one or not.
  function queryInput() {
    return (_h.queryInput && _h.queryInput()) || document.getElementById('notation-input');
  }

  // ── WHICH STRING A CELL WRITES, AND WHY IT IS NOT ALWAYS THE MNEMONIC ───────────────────────
  //
  // 76 of the atlas's 175 cells carry a mnemonic that is SHADOWED by an idea token of the same
  // spelling — 27 of the 101 distinct mnemonics. `H2A1` is
  // a UniProt mnemonic and also the variant H2A.1; `CENPA` is a mnemonic and also cenH3; `H4` is a
  // mnemonic and also the family. The grammar resolves those to the IDEA, with accession null — so
  // writing the mnemonic for those cells would silently widen the query from the one protein the
  // reader clicked to a whole variant subtree across every organism. It parses, it renders, and it
  // answers a question nobody asked. That is measured, not feared: 43% of the cells.
  //
  // So the cell asks the engine what its own name means and falls back when the answer is not this
  // molecule. The order — mnemonic, then bare accession — is the SAME fallback emitMaterial already
  // uses for a material handle, so the bar shows the spelling the engine would have chosen anyway.
  //
  // With no engine on the page, the accession is the safe choice: it is never shadowed.
  function queryForCell(cell) {
    const mnemonic = cell.getAttribute('data-mnemonic') || '';
    const accession = cell.getAttribute('data-accession') || '';
    const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!mnemonic) return accession;
    if (!P || typeof P.lift2 !== 'function' || typeof P.parse !== 'function') return accession || mnemonic;
    try {
      const node = P.lift2(P.parse(mnemonic));
      const names = node && Array.isArray(node.accession) ? node.accession : [];
      if (names.length) return mnemonic;                 // the mnemonic IS a handle — use the name
    } catch (e) { /* unparseable: the accession below is still a valid query */ }
    return accession || mnemonic;
  }

  // ONE HANDLER ON THE CONTAINER, not 217 on the targets. The figure is a static tree emitted by R;
  // binding per element would mean re-binding whenever it is regenerated, and would put 217 closures
  // on a page that already has plenty.
  function configureVariantAtlas(host) {
    _h = host || {};
    const svg = document.querySelector('svg.variant-atlas');
    if (!svg) return false;                 // no figure on this page — every path below is a no-op

    // ── THE SPECIES LOCK IS NOT STATE, IT IS THE "READ AS" CONTEXT [BB 2026-08-25] ─────────────
    // It began as a `_lockedTaxon` of the atlas's own, seeded null and taken by the first click.
    // That was a second copy of something the page already knew: a fresh load highlighted no ring
    // while the "Read as" button already said Hs, and the two could agree only by accident.
    //
    // So the lock is DERIVED — but from the BAR, not from the lens [BB 2026-08-30]. It was
    // `contextTaxon()`, and that made the species-gutter label an escape hatch out of the lock it
    // is documented as not touching: the gutter moves the lens deliberately, and while the lock WAS
    // the lens, moving it moved the lock. Human cell → Mm gutter → mouse cell was allowed, and a
    // mouse protein joined a bar holding a human one. `taxonOfQuery` (atlas-compose.js, pure and
    // tested) asks what the bar CONTAINS instead; the lens stays free to move, which was the point
    // of exempting the gutter in the first place. Clearing the field still releases the lock, and
    // there is still no lock STATE to reset.
    // MEMOISED ON THE FIELD'S STRING, because the HOVER path calls this. `lockDecision` decides
    // whether a ring is inert, and that runs on every `pointermove` over a 175-cell figure —
    // measured at 0.98 ms for `H3`, 1.56 ms for a mononucleosome and 2.44 ms for a dinucleosome per
    // event, since `taxonOfQuery` does a full parse → lift2 → resolve2 with the registry. The click
    // path calling it once was never the problem. The key is the exact string, so any edit
    // recomputes, which is the same discipline `composed` uses two functions up.
    let _lockKey = null, _lockVal = null;
    const lockedTaxon = () => {
      const q = queryInput();
      const v = (q && q.value) || '';
      if (v === _lockKey) return _lockVal;
      const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
      _lockKey = v;
      _lockVal = (typeof taxonOfQuery === 'function')
        ? taxonOfQuery(v, P, P && P.DEFAULT_REGISTRY)
        : null;
      return _lockVal;
    };

    // THE RESTING HIGHLIGHT IS A DIFFERENT QUESTION AND KEEPS THE LENS. It shows which organism the
    // figure is being READ AS — the thing the "Read as" button spells — so on a fresh page it lights
    // Hs and agrees with the button. Tying it to the bar would leave the figure blank until the
    // reader clicked something, and would make the gutter click, whose whole purpose is to move the
    // lens, appear to do nothing at all.
    const lensTaxon = () =>
      (typeof contextTaxon === 'function') ? contextTaxon() : null;

    // ── THE OPEN GROUP ──────────────────────────────────────────────────────────────────────────
    // `appendToken` cannot tell a `(…)` it built itself from one the reader wrapped, and the two
    // take opposite continuations: a click after Wrap starts the NEXT particle, a click after an
    // auto-wrap joins the one being built. So the bit lives here, with the gestures that set it.
    //
    // HELD AS THE STRING, NOT AS A FLAG. A flag goes stale the moment the reader types in the
    // field — they can edit between clicks, and a stale `true` would append into a group they had
    // just closed by hand. Comparing against the exact string this function last produced makes any
    // edit at all close the group, which is the conservative answer and the one that cannot compose
    // a molecule nobody asked for.
    let composed = null;
    const compose = (q, token) => {
      const next = appendToken(q.value, token, composed !== null && q.value === composed);
      composed = next;
      return next;
    };

    svg.addEventListener('click', (e) => {
      // ── A SPECIES NAME SETS THE CONTEXT AND WRITES NOTHING [BB 2026-08-25] ──────────────────
      //
      // A THIRD KIND OF TARGET, and it belongs to a different layer again. A cell names a molecule
      // and an idea segment names a subtree; the gutter label names neither — it names the ORGANISM
      // the figure is read in. So it moves the lens and stops, which is the same thing the "Read as"
      // dropdown does, said in the figure the reader is already looking at.
      //
      // Deliberately NOT subject to the species lock: choosing what you are reading as is how you
      // get OUT of an organism, so gating it on the lock would make the lock unescapable except by
      // clearing the query. It touches no token, so it cannot mix two organisms into one bar.
      const spLabel = e.target.closest && e.target.closest('.atlas-sp-label[data-taxon]');
      if (spLabel) {
        const spTaxon = Number(spLabel.getAttribute('data-taxon'));
        if (spTaxon && typeof adoptTaxon === 'function' && !adoptTaxon(spTaxon) &&
            typeof loadSpecies === 'function') {
          Promise.resolve(loadSpecies()).then(() => { adoptTaxon(spTaxon); rest(); }).catch(() => {});
        }
        rest();
        return;
      }

      const cell = e.target.closest && e.target.closest('.atlas-cell');
      const idea = e.target.closest && e.target.closest('.atlas-idea');
      const hit  = cell || idea;
      if (!hit) return;

      const q = queryInput();
      if (!q) return;

      if (cell) {
        // The taxon lives on the species RING, not on the cell: one ring is one organism, and
        // repeating the attribute 175 times would be 175 chances for it to disagree with itself.
        const ring  = hit.closest('[data-taxon]');
        const taxon = ring && Number(ring.getAttribute('data-taxon'));
        // TRY NOW, AND AGAIN WHEN THE SPECIES LIST EXISTS. `adoptTaxon` resolves a taxon id through
        // `SPECIES_TAXON`, which is seeded `{Hs: 9606}` and only filled by `loadSpecies()` inside
        // the DuckDB boot — while this figure is painted, and clickable, well before that. So an
        // early click on any non-human cell used to return false and silently leave the lens on
        // human [BB 2026-08-24].
        //
        // The retry is safe in BOTH readings of a false, which is why it needs no flag: false means
        // either "the lens is already there", where calling again does nothing, or "I do not know
        // this taxon yet", where calling again after the load is exactly the repair. Nothing is
        // awaited on the click path — the field is filled synchronously below and the lens catches
        // up — so a slow boot costs the reader nothing they can see.
        // THE FIRST CELL CLICK LOCKS ITS SPECIES RING [BB 2026-08-25]. Additive clicking creates a
        // failure set-mode could not have: two cells from different rings each call `adoptTaxon`,
        // the second wins, and the bar reads as ONE organism while showing TWO organisms' proteins
        // — stating one thing and meaning another, which is the exact fault `adoptTaxon` exists to
        // fix for the species button. Deliberately crude; cross-species building is not now.
        //
        // Asked BEFORE adoptTaxon, so a refused click moves nothing at all — neither the field nor
        // the lens.
        const decision = lockDecision(lockedTaxon(), taxon || null, fieldIsEmpty());
        if (!decision.allowed) return;              // another ring, mid-build — this cell is inert
        if (taxon && typeof adoptTaxon === 'function' && !adoptTaxon(taxon) &&
            typeof loadSpecies === 'function') {
          Promise.resolve(loadSpecies()).then(() => { adoptTaxon(taxon); rest(); }).catch(() => {});
        }
        // The context has just moved, so the resting highlight has to follow it — this is the click
        // that decides which organism the figure is now reading as.
        rest();
        q.value = compose(q, queryForCell(cell));
      } else {
        // An idea segment names a subtree and no organism, so it never takes or tests the lock.
        q.value = compose(q, idea.getAttribute('data-token') || '');
      }
      if (!q.value) return;

      // THE FIGURE SETS THE QUERY, IT DOES NOT RUN IT [BB 2026-08-24]. This used to dispatch
      // `input`, which is what the example chips do, and running the query was the whole of the
      // click. A chip is a worked example and running it is the point; a cell is one of 175
      // targets a reader is browsing, and answering each one on the way past is not reading, it is
      // being interrupted. Setting the field and the context leaves the reader holding a query they
      // can edit, extend, or abandon — and Return runs it, which is the same key that runs anything
      // else typed here and skips the debounce while it is at it.
      //
      // `syncChips` is still called, because that is chrome and not an answer: the example strip has
      // to get out of the way of a filled field whether or not the field has been submitted.
      // Deliberately NOT a synthetic `input` event — that would schedule `onInput` through the
      // debounce and put us straight back where we started.
      if (window.syncChips) window.syncChips();
      q.focus();
    });

    // ── HOVER ANYWHERE IN A RING, LIGHT ITS WHOLE SPECIES ──────────────────────────────────────
    //
    // Three elements move together and they are not siblings: the ring's background annulus (a
    // child of the ring group), the other six rings (its siblings), and the species name in the
    // gutter (in a DIFFERENT group entirely, because the gutter belongs to no ring). That last one
    // is why this is script and not `:has()` — a CSS rule can reach the first two, and pairing the
    // label needs a per-taxon selector, which means seven hardcoded rules for a species list that
    // comes from the data.
    //
    // Classes, not inline style: what "lit" looks like belongs in the stylesheet with the rest of
    // the theme, and it has to differ between light and dark like everything else here.
    const rings   = [...svg.querySelectorAll('.atlas-ring[data-taxon]')];
    const labels  = [...svg.querySelectorAll('.atlas-sp-label[data-taxon]')];
    const sectors = [...svg.querySelectorAll('.segment-bg[data-token]')];
    let litTaxon = null;
    let litToken = null;

    // THE RESTING STATE IS THE CONTEXT RING, LIT [BB 2026-08-25] — not "nothing lit".
    //
    // The lock used to announce itself by DIMMING the rings it ruled out, and that was too quiet to
    // read: a uniformly duller ring gives the eye nothing to compare against. The highlight is now
    // the SAME one hovering already draws — which the reader has already seen and understood — and
    // it is simply where the figure sits when the pointer is elsewhere. On a fresh page that lights
    // Hs, agreeing with what the "Read as" button says instead of leaving the figure blank beside it.
    const restingTaxon = () => {
      const t = lensTaxon();
      return t == null ? null : String(t);
    };

    // The lock engages only once there is something to build on — an empty bar means any ring may
    // still be chosen. One reading of the field, used by both the click and the hover, so the two
    // can never disagree about whether a cell is live.
    const fieldIsEmpty = () => {
      const q = queryInput();
      return !String((q && q.value) || '').trim();
    };

    // THE FIELD REPAINTS THE FIGURE, because emptying it releases the lock. There is no lock STATE
    // to clear any more — `lockDecision` reads the field directly — but the resting highlight still
    // has to be redrawn, since a ring that was inert a moment ago is clickable again and must stop
    // looking dim.
    const _qEl = queryInput();
    if (_qEl) _qEl.addEventListener('input', () => rest());

    const key = (el) => `${el.getAttribute('data-token')}\u0000${el.getAttribute('data-ring')}`;

    function lightSpecies(taxon) {
      if (taxon === litTaxon) return;              // pointer moved cell-to-cell WITHIN one ring
      litTaxon = taxon;
      rings.forEach((r) => {
        const on = taxon != null && r.getAttribute('data-taxon') === taxon;
        r.classList.toggle('is-lit', on);
        r.classList.toggle('is-dim', taxon != null && !on);
      });
      labels.forEach((l) => l.classList.toggle('is-lit',
        taxon != null && l.getAttribute('data-taxon') === taxon));
    }

    // Back to rest — the context ring lit, rather than a blank figure.
    //
    // `litTaxon` is nulled first because `lightSpecies` short-circuits when the taxon has not
    // changed, and rest() is called precisely when the CONTEXT may have moved under an unchanged
    // pointer. Without this, adopting a new organism would leave the previous ring lit until the
    // pointer next crossed a boundary.
    function rest() {
      litTaxon = null;
      lightSpecies(restingTaxon());
    }

    // An idea segment lights the ANGULAR band across the species rings — its own backing sector,
    // paired by token AND ring, because `H2A` names a family wedge and could name a variant too.
    function lightSegment(k) {
      if (k === litToken) return;
      litToken = k;
      sectors.forEach((p) => p.classList.toggle('is-lit', k != null && key(p) === k));
    }

    // WHY THE CLEAR IS DELAYED, AND WHY ONLY BARELY. Rings are separated by a 0.5 pt gap and cells
    // by a hairline, and crossing either one puts the pointer briefly on no target at all — so an
    // immediate clear blinks the highlight every time the eye follows a row outward. Any
    // pointerover cancels the timer, so it only ever expires when the pointer has genuinely left.
    // (The gap was 0.4 mm until 2026-08-24 and is now the stroke width, so the crossing it has to
    // outlast is about a third of what it was — which is the other half of why 40 ms is enough.)
    //
    // The delay was 120 ms, chosen to outlast the crossing at ANY speed. That is the wrong thing to
    // buy [BB 2026-08-24]: it also outlasts the move to the next cell, so a reader browsing along a
    // column sees the highlight sitting on the cell they have already left, which reads as a figure
    // that does not respond rather than as one that is being careful. A flicker at a seam is
    // legible — the reader sees the gap they crossed. A lag is not; it looks broken. So the delay
    // now covers only the crossing itself at reading speed and stays under the ~50 ms at which a
    // response still feels immediate, and the flicker at a fast traverse is accepted.
    //
    // Assigning the gap to a neighbour was the other option all along, and it moves the seam rather
    // than removing it: there is always a boundary somewhere.
    const CLEAR_MS = 40;
    let clearTimer = null;
    const cancelClear = () => { if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; } };

    svg.addEventListener('pointerover', (e) => {
      cancelClear();
      const t = e.target;
      if (!t.closest) return;
      // The species NAME surfaces its ring too — it is the label OF the thing, so reading it and
      // pointing at it are the same gesture [BB].
      // THE RING IS ASKED OF THE POINTER, NOT OF A CELL [BB 2026-08-24]. This used to walk up from
      // `.atlas-cell`, so the only way into a species was to be on one of its proteins — and the
      // highlight dropped out over every column that organism has no protein in, which is the
      // majority of most rings. It read as the figure failing, when those absences are the very
      // thing the lit band draws. The ring's background annulus is now a hit target (see
      // `.species-bg` in _shell.scss), so anywhere in the band answers, gutter included, and
      // `closest` finds the ring whether the pointer is on a cell, on the empty floor between two
      // of them, or on the whitespace where the name is written.
      const label = t.closest('.atlas-sp-label[data-taxon]');
      const ring  = t.closest('.atlas-ring[data-taxon]');
      const taxon = ring ? ring.getAttribute('data-taxon')
                  : label ? label.getAttribute('data-taxon') : null;
      const idea  = t.closest('.atlas-idea');
      // A TARGET THAT NAMES NOTHING IS A GAP, NOT A DESTINATION [BB 2026-09-23]. The svg root, the
      // hairline group between segments, the segment backgrounds and the legend all receive
      // pointerover as the pointer crosses them, and none of them carries a taxon or an idea. This
      // handler used to answer such a target by painting REST at once — so the 40 ms grace that
      // pointerout arms was cancelled and overridden on every hairline, and a pointer travelling
      // along a ring saw the lit ring drop and relight at each seam: the jitter. Crossing a gap now
      // re-arms the same grace the leave arms, and the next real target cancels it.
      if (taxon == null && !idea) {
        clearTimer = setTimeout(() => { rest(); lightSegment(null); }, CLEAR_MS);
        return;
      }
      // AN INERT RING DOES NOT LIGHT UP. While the lock holds, hovering a ruled-out organism must
      // not offer the highlight of one you can click — the figure would be inviting a click it will
      // refuse. It stays at rest instead, which keeps the lit ring on the organism actually in play.
      const inert = taxon != null
        && !lockDecision(lockedTaxon(), Number(taxon), fieldIsEmpty()).allowed;
      lightSpecies(inert ? restingTaxon() : (taxon != null ? taxon : restingTaxon()));
      lightSegment(idea ? key(idea) : null);
    });

    svg.addEventListener('pointerout', () => {
      cancelClear();
      // Back to REST, not to blank: the context ring stays lit while the pointer is away.
      clearTimer = setTimeout(() => { rest(); lightSegment(null); }, CLEAR_MS);
    });

    // Paint the resting state now, so a page that has never been hovered still says which organism
    // it is reading as. The species list arrives with the DuckDB boot, well after this runs, so it
    // is painted again when the lens finishes loading — see `restAtlas` on the species-lens host.
    rest();
    window.restAtlas = rest;

    // ── THE TACO ────────────────────────────────────────────────────────────────────────────────
    // Wraps the trailing run of the query into one particle — from the end back to the last `)`, or
    // to the start [BB 2026-08-25]. It sits on the atlas because the dial is what accumulates that
    // run, and wrapping it is the last gesture of building with the dial.
    //
    // Like the cell click, it SETS and does not RUN: `syncChips` is chrome and not an answer, and a
    // synthetic `input` event would schedule `onInput` through the debounce and answer a question
    // the reader has not asked yet.
    const tacoBtn = document.getElementById('taco');
    if (tacoBtn) tacoBtn.addEventListener('click', () => {
      const q = queryInput();
      if (!q) return;
      // WRAP CLOSES THE GROUP, and it does so even when it wraps nothing. Pressing it on a particle
      // the dial auto-closed — where the trailing run is empty and `tacoWrap` is a no-op — is how a
      // reader says "done with this one", and it is the only gesture that says it. Closing before
      // the early return is what makes the next click start a neighbour instead of joining.
      composed = null;
      const wrapped = tacoWrap(q.value);
      if (wrapped === q.value) return;      // nothing to wrap — do not churn the field or the caret
      q.value = wrapped;
      if (window.syncChips) window.syncChips();
      q.focus();
    });

    return true;
  }

  const api = { configureVariantAtlas };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/toppings.js
// "Add toppings" — the mark axis as a palette. Until now the 35 PTM tokens were never on the page
// at all, so the only way to reach `me2s` was to already know it exists.
//
// THE GROUPING IS A REGISTRY FACT, read from the generated tables and not decided here. Inventing a
// grouping in page JS would be a second source of truth about marks; registry/vocabulary.yaml is
// the first and only one, and `class:` is the field. See its comment there.
//
// WHY `me` IS DRAWN AS A PARENT AND NOT A PEER. Under the cross-axis principle a token naming a SET
// of more than one member is not one of them: it carries no mass, everything below it entails it,
// and `compatible2(K4me0, K4me)` returning TRUE — unmethylated compatible with methylated — is the
// bug that ruling exists to kill. A flat row of 35 would put `me` beside `me1` as though they were
// the same kind of thing. The palette tells the truth the lattice already tells.
//
// A group with exactly ONE member IS that member, and none of this applies (`ac`, `ph`, `ub`).
(function (root) {
  'use strict';

  // THE SHELF ORDER AND WORDING COME FROM THE REGISTRY [BB 2026-08-25]. They were a `SECTION_ORDER`
  // array here — the last thing about this palette the registry did not decide, and so the one
  // thing a reader could not change without editing page code. The order is now the order the
  // classes first appear in `ptms:` in registry/vocabulary.yaml, and the heading is the class id
  // with its first letter raised, both arriving as `PTM_CLASS_ORDER`.
  //
  // `order` is passed in rather than read from the global so the pure function stays pure and the
  // suite can hand it a list; the DOM half below supplies the generated tables.

  // The first letter raised and nothing else — the same rule the shelf headings use, and for the
  // same reason: "O-GlcNAcylation" and "ADP-ribosylation" are already spelled the way they read,
  // and a general titlecaser would wreck both.
  const cap1 = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

  function toppingSections(names, classes, groups, order, residues) {
    const tokens = Object.keys(names || {});
    // Group SIZE is what decides set-ness, which is why it is counted rather than assumed: a
    // singleton's token equals its group name too, and only the count tells the two apart.
    const size = {};
    tokens.forEach((t) => { const g = groups[t]; size[g] = (size[g] || 0) + 1; });

    const byClass = new Map();
    tokens.forEach((t) => {
      const c = classes[t] || 'other';
      if (!byClass.has(c)) byClass.set(c, []);
      const res = (residues && residues[t]) || [];
      byClass.get(c).push({
        token: t,
        name: names[t],
        group: groups[t],
        residues: res,
        // WHAT THE TOOLTIP SAYS: "Monomethylation (K, R)". The residues are half of what a reader
        // needs from a three-letter token — `me2a` is arginine-only and `me2` is not — and the
        // palette had that fact in hand and was not showing it.
        title: cap1(names[t]) + (res.length ? ' (' + res.join(', ') + ')' : ''),
        isSet: groups[t] === t && size[t] > 1,
      });
    });

    const shelves = Array.isArray(order) ? order : [];
    const ids = shelves.map((s) => s.id);
    const labelOf = (id) => {
      const s = shelves[ids.indexOf(id)];
      return (s && s.label) || id;
    };
    // A class carried by a mark but absent from the registry's list is APPENDED, under its raw id,
    // rather than dropped. A mark that has been given a shelf must not vanish from the page for
    // want of an entry in a second list; the generator warns, which is the right place to notice.
    const known = ids.filter((c) => byClass.has(c));
    const extra = [...byClass.keys()].filter((c) => ids.indexOf(c) === -1);
    return known.concat(extra).map((c) => ({ class: c, label: labelOf(c), marks: byClass.get(c) }));
  }

  // THE REPLACE PALETTE — the non-canonical residues, the ones a substitution can name that are not
  // among the standard 20. Same shape as a topping and the same insertion, because in the notation
  // they ARE the same gesture: both land after a stated position, and `H4:K20Ecx` is written exactly
  // the way `H4:K20me1` is.
  //
  // The shelves come from `kind`, which the generator DERIVES from the residue's own fields rather
  // than from a list somebody keeps in step — see build_vocabulary_js.R. So this function does no
  // grouping of its own either; it orders by first appearance, exactly as the marks do.
  //
  // NO `isSet` HERE, although B/Z/J/X genuinely are sets. Their set-ness is not a display choice on
  // this axis: the ambiguity codes are ONLY ever written as substitutions and the shelf already says
  // so by name, where `me` sits in a row of leaves it could be mistaken for.
  function replaceSections(residues) {
    const list = Array.isArray(residues) ? residues : [];
    const byKind = new Map();
    list.forEach((r) => {
      if (!byKind.has(r.kind)) byKind.set(r.kind, []);
      byKind.get(r.kind).push({
        token: r.token,
        name: r.name,
        title: cap1(r.name),
        isSet: false,
      });
    });
    return [...byKind.keys()].map((k) => ({ class: k, label: cap1(k), marks: byKind.get(k) }));
  }

  // Is there a residue AT THE CURSOR for a mark to land on?
  //
  // ASKED OF THE ENGINE, AND IT HAS TO BE. The obvious version is a regex for trailing digits, and
  // it is wrong on the commonest path there is: `H3`, `H31`, `H2A1` all end in digits that are part
  // of the NAME, not a position — and those are exactly the strings the atlas dial writes, so a
  // reader who dialled a protein and then clicked a mark got `H31ac`. A regex cannot tell a family
  // digit from a residue digit; the parser already does.
  //
  // AT THE CURSOR, NOT ANYWHERE IN THE TREE [review, 2026-08-26]. The first version asked whether
  // the lifted tree held ANY positioned mark, which is true of `(H3K27M)` — so pressing Wrap and
  // then clicking a mark produced `(H3K27M)me3`, which the grammar rejects, and the taco cannot
  // repair it the way it repairs `(H3)H2A`. The flow that reaches it is the one the menu itself
  // teaches: step 4, then step 2. Two rules cover it, and they are checked in this order:
  //
  //   1. A CLOSING DELIMITER ENDS A PARTICLE, and nothing suffixes a closed particle. `)`, `]`
  //      and `}` are therefore a flat no, whatever the tree says.
  //   2. THE LAST PROTEOFORM DECIDES, not any of them. `H3K27M@H4` ends on a member with no
  //      position, so a mark has nothing to attach to even though the member before it does.
  //
  // "Does `text + token` parse" was the other candidate and is WORSE: `H31ac` and `H3me3` both
  // parse, so it would re-admit the bug the engine check was introduced to kill.
  //
  // THIS IS STILL NOT THE VALIDATION THE DIAL FORSWEARS. It asks whether a residue exists HERE, not
  // whether the reader's molecule is the one they meant — that is settled at Return. Conservative
  // when it cannot tell: an unparseable prefix returns false and the palette goes inert.
  function endsAtPosition(textBeforeCursor, parser) {
    const text = String(textBeforeCursor == null ? '' : textBeforeCursor).trim();
    if (!text) return false;
    if (/[)\]}]$/.test(text)) return false;        // rule 1 — a closed particle takes no suffix
    const P = parser || (typeof nucleosomeParser2 !== 'undefined' ? nucleosomeParser2 : null);
    if (!P || typeof P.parse !== 'function' || typeof P.lift2 !== 'function') {
      // No engine (a bare require in a node suite): fall back to the shape test. Kept deliberately
      // rather than returning false, so the palette still works if the bundle fails to load — but
      // it is the weaker answer, and the engine path above is the real one.
      return /\d+[A-Za-z]*$/.test(text);
    }
    try {
      return endsOnAPosition(P.lift2(P.parse(text)));
    } catch (e) {
      return false;                          // mid-token, or not a query yet — nothing to attach to
    }
  }

  // The RIGHTMOST proteoform, which is the one the cursor is sitting at the end of. Walks the last
  // member down through arrays and assemblies rather than searching the whole tree, which is the
  // difference between "this query mentions a position" and "this query ENDS at one".
  function lastProteoform(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node.members) && node.members.length) {
      return lastProteoform(node.members[node.members.length - 1]);
    }
    return node;
  }

  // Measured against the engine, which is the point of doing it this way: `H3`, `H31` and `H2A1`
  // all lift with `modifications: []` — the digits are the variant's name — while `H3K27` lifts
  // with `{position: 27, residue: "K"}`. That is the distinction the regex could not draw.
  function endsOnAPosition(node) {
    const last = lastProteoform(node);
    return !!(last && Array.isArray(last.modifications)
      && last.modifications.some((m) => m && m.position != null));
  }

  // A SUBSTITUTION IS STRICTER THAN A MARK, and reusing one guard for both palettes hid it. A mark
  // may follow another mark — `H3K27me1` takes `ac` — but a substituted residue must come
  // IMMEDIATELY after the position, before anything else is said about it:
  //
  //   H3:K27      + Ecx  ->  H3:K27Ecx      parses
  //   H3K27me1    + Ecx  ->  H3K27me1Ecx    REJECTED — the mark is already there
  //   H3K27M      + Ecx  ->  H3K27MEcx      REJECTED — the slot is taken
  //
  // So Replace asks for a BARE position: the last thing written must be a residue and its number,
  // carrying neither a substitution nor a mark yet. Found by asserting that every insertion the
  // guard allows still parses — the review found the closing-delimiter half, this half was under it.
  function endsAtBarePosition(textBeforeCursor, parser) {
    if (!endsAtPosition(textBeforeCursor, parser)) return false;
    const P = parser || (typeof nucleosomeParser2 !== 'undefined' ? nucleosomeParser2 : null);
    if (!P || typeof P.parse !== 'function' || typeof P.lift2 !== 'function') return false;
    try {
      const last = lastProteoform(P.lift2(P.parse(String(textBeforeCursor).trim())));
      const mods = (last && last.modifications) || [];
      const tail = mods[mods.length - 1];
      return !!(tail && tail.position != null && !tail.substitution && !tail.modification);
    } catch (e) {
      return false;
    }
  }

  function insertTopping(value, cursor, token) {
    const v = String(value == null ? '' : value);
    const at = Math.max(0, Math.min(Number(cursor) || 0, v.length));
    const t = String(token == null ? '' : token);
    return { value: v.slice(0, at) + t + v.slice(at), cursor: at + t.length };
  }

  let _h = {};
  const queryInput = () => (_h.queryInput && _h.queryInput())
    || (typeof document !== 'undefined' ? document.getElementById('notation-input') : null);

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function configureToppings(host) {
    _h = host || {};
    if (typeof document === 'undefined') return false;

    // The LABEL, not the id: the wording is authored in the registry, so nothing here rewrites it.
    // This used to strip hyphens out of the id, which is how "ubiquitin-like" became the heading
    // "ubiquitin like" — a page inventing wording because the registry only gave it a key.
    //
    // ONE RENDERER FOR BOTH PALETTES. "Add toppings" and "Replace" differ in what they insert and
    // in nothing else — same tile, same shelves, same inert-until-there-is-a-position rule — so a
    // second copy of this would be a second place for the two to drift apart.
    const rowFor = (s) => '<div class="topping-row"><span class="topping-cls">'
      + esc(s.label) + '</span><span class="topping-marks">'
      + s.marks.map((m) => '<button type="button" class="topping'
          + (m.isSet ? ' topping-set' : '') + '" data-token="' + esc(m.token) + '" title="'
          + esc(m.title) + (m.isSet ? ' — names the group, states no degree' : '') + '">'
          + esc(m.token) + '</button>').join('')
      + '</span></div>';

    // ONE DELEGATED HANDLER PER BOX, not one per button — the buttons are rewritten on every mount,
    // so a per-button listener would have to be re-bound anyway. Each box carries its OWN
    // precondition: a mark may follow a mark, a substitution may not (see endsAtBarePosition).
    const bind = (b, canLand) => b.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.topping');
      if (!btn) return;
      const q = queryInput();
      if (!q) return;
      const at = (q.selectionStart == null) ? String(q.value || '').length : q.selectionStart;

      // LIVE BUT INERT-UNTIL-VALID [BB 2026-08-25]. A mark needs a residue to land on. Rendering the
      // palette dimmed would put a dead region on the landing page; this way the reader sees the
      // whole menu from the start and it works the moment there is a position to attach to.
      if (!canLand(String(q.value || '').slice(0, at))) { q.focus(); return; }

      const next = insertTopping(q.value, at, btn.dataset.token);
      q.value = next.value;
      q.focus();
      if (q.setSelectionRange) q.setSelectionRange(next.cursor, next.cursor);
      // Chrome only — deliberately NOT a synthetic `input` event, for the same reason the atlas
      // click is not one: that would schedule `onInput` through the debounce and answer a question
      // the reader has not asked yet.
      if (window.syncChips) window.syncChips();
    });

    // EACH PALETTE MOUNTS ON ITS OWN [review, 2026-08-26]. They were mounted in sequence inside one
    // set of early returns — `if (!box) return false` and `if (!secs.length) return false` — so a
    // missing #toppings element, or a PTM table that failed to load, silently took the Replace
    // palette down with it. The two read INDEPENDENT tables (PTM_* against NONCANONICAL_RESIDUES)
    // and neither needs the other to be sound, so nothing should couple their fates.
    //
    // An empty section list still draws nothing rather than an empty shell: a palette with no
    // vocabulary behind it is a heading promising tokens that are not coming.
    const mount = (id, sections, canLand) => {
      const b = document.getElementById(id);
      if (!b || !sections.length) return false;
      b.innerHTML = sections.map(rowFor).join('');
      bind(b, canLand);
      return true;
    };

    // Built here rather than in Liquid: the tables live in a GENERATED JS file, which Liquid cannot
    // read. Same reason the atlas is inlined rather than fetched — the data is already where the
    // script is.
    //
    // ALL OF THEM, NO DISCLOSURE [BB 2026-08-25]. Four shelves were open and the remaining four sat
    // behind an "all 35 marks" summary, which was the right shape for a full-width block under the
    // atlas and the wrong one beside it: a column has the height to spend, and a mark you cannot see
    // is a mark you have to already know about — which is the whole reason this palette exists.
    const marks = mount('toppings', toppingSections(
      typeof PTM_NAMES !== 'undefined' ? PTM_NAMES : {},
      typeof PTM_CLASS !== 'undefined' ? PTM_CLASS : {},
      typeof PTM_GROUP !== 'undefined' ? PTM_GROUP : {},
      typeof PTM_CLASS_ORDER !== 'undefined' ? PTM_CLASS_ORDER : [],
      typeof PTM_RESIDUES !== 'undefined' ? PTM_RESIDUES : {}), endsAtPosition);

    const replace = mount('replace', replaceSections(
      typeof NONCANONICAL_RESIDUES !== 'undefined' ? NONCANONICAL_RESIDUES : []), endsAtBarePosition);

    return marks || replace;
  }

  const api = { toppingSections, replaceSections, endsAtPosition, endsAtBarePosition,
                insertTopping, configureToppings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ONE PANEL IDIOM (Task 9, 2026-09-23) — openSheet/closeSheet for the four .qeditor sheets.
//
// THE POSITION IS FOR THE READER, NOT FOR THE CODE. An earlier version of this note said
// species-lens.js and diagnostics.js read `typeof openSheet` AT LOAD TIME to decide whether to bind
// their click handlers. Neither does: diagnostics.js reads it INSIDE the click callback and
// species-lens.js inside `bindCtl`'s click handler (`showEditor`, the function this note used to
// name, is deleted — code-review 2026-09-25), so by the time either runs every include has finished
// and the order here cannot matter. Corrected 2026-09-23 — a false reason is worse than none,
// because it is what a future reader would weigh when moving the include.
//
// Two things do hold. `openSheet`/`closeSheet` are top-level `function` declarations, hoisted
// across app.js's one classic script, so they are reachable from anywhere regardless of position.
// And this is NOT the `Object.assign(globalThis, …)` at the foot of sheet.js, which does not run
// until sheet.js has finished. Keeping the include above its two consumers costs nothing and means
// a house-style rewrite to an IIFE (every sibling here is one) would not silently break them.
// docs/_includes/js/sheet.js — ONE PANEL, FOUR SHEETS, OPENED BY NAME.
//
// specs/2026-09-23-page-rebuild-query-answer.md §6. There were four `.qeditor` drawers in three
// places (`#ctxeditor`/`#porteditor` under the query field in query.html; `#licenceeditor`/
// `#diageditor` in the footer, sheet.html), opened by three different mechanisms sharing one close
// handler. `.qeditor` was written assuming a panel expanding under the FIELD, which is why the two
// in the footer were a layout it was never written for. All four now live in sheet.html and share
// this one open/close idiom; docs/_sass/_sheet.scss is the component that works wherever they sit.
//
// `name` is orthogonal to `setPageState` — a sheet may open over any page state (empty, answer,
// refused) and does not touch `body[data-state]`.
'use strict';

// `Object.create(null)` rather than `{}`: `SHEETS['constructor']`/`'toString'`/`'valueOf'` are
// truthy on an ordinary object literal (they resolve through the prototype), which used to slip
// past the `unknown sheet` throw below and then no-op at `if (!el) return` — the exact silent
// failure the throw exists to prevent. A null-prototype object has no inherited properties for a
// sheet name to collide with, so a plain `in`/index lookup is honest.
const SHEETS = Object.create(null);
Object.assign(SHEETS, { context: 'ctxeditor', port: 'porteditor', licence: 'licenceeditor', diagnostics: 'diageditor' });

function closeSheet() {
  for (const id of Object.values(SHEETS)) {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  if (document.body) document.body.classList.remove('sheet-open');
  // `--foot-h` (shell.js, bindFooterHeight) skips its own ResizeObserver while `sheet-open` is set,
  // and a sheet closing changes the footer's `position` back to `fixed` without changing its content
  // height — so nothing re-measures it. Re-run it now that the class above is gone, catching a
  // footer whose WRAP changed while the sheet was up (rotate a phone with Diagnostics open) [2026-09-26
  // review, finding 1]. `typeof`, not a bare call: shell.js loads AFTER sheet.js in app.js and only
  // assigns this once its own module-scope IIFE has run — by the time a reader can press anything
  // that reaches closeSheet, both modules have already executed, but the node suites that load
  // sheet.js alone (this file has none of shell.js in scope) must not throw for its absence.
  if (typeof refreshFootHeight === 'function') refreshFootHeight();
}

// Throws on an unknown name rather than no-op-ing: a caller that misspells a sheet name should
// fail loudly, not silently do nothing while the reader wonders why nothing opened.
//
// `opts.toggle` is an explicit opt-in, not the default: `species-lens.js`'s `bindCtl` calls this
// with no opts for the context/port editors and means OPEN, full stop — reopening the "Read as"
// menu and picking a species again must not close what it just opened. `#qdiag` and `#qlicence`
// pass `{ toggle: true }` because pressing the same control again to dismiss it is a decision those
// two made before this idiom existed, and it stays theirs on purpose.
function openSheet(name, opts) {
  if (!(name in SHEETS)) throw new Error(`openSheet: unknown sheet ${JSON.stringify(name)}`);
  const id = SHEETS[name];
  const el = document.getElementById(id);
  const wasOpen = !!(el && !el.hidden);
  closeSheet();                       // one at a time, even when the named element is missing —
  if (!el) return;                    // a missing target must not leave a stale sheet open (below)
  if (opts && opts.toggle && wasOpen) return;
  el.hidden = false;
  if (document.body) document.body.classList.add('sheet-open');
}

// Through the host object, never by name: app.js concatenates every module into one classic script,
// where a top-level `const`/`function` lives in the global lexical scope and is NOT a property of
// globalThis. A consumer reaching for a declared name works in every node suite and fails on the
// page. (docs/CLAUDE.md)
Object.assign(globalThis, { openSheet, closeSheet });

// docs/_includes/js/species-lens.js
// The query-global species lens: the organism maps, the two menus beside the query bar, and the
// context/port overrides everything else resolves through. Extracted from shell.js on 2026-08-15
// (U7 of specs/2026-08-13-shell-seams.md).
//
// It owns `qcontext` and `qport` — the only mutable state in this refactor that other panes read —
// and `contextOverrideForQuery`, which is called from nine places and is what makes a query mean a
// molecule in one organism rather than another.
//
// WHY THIS ONE PAYS FOR ITSELF. `notation-canon.js` (U3+U4) had to take the lens through an
// installer, because `contextOverrideForQuery` was declared in shell.js and a name declared there is
// not on `globalThis`. Moved here it is an ordinary module export, reachable by name from any module
// the way `escapeHtml` and `meetBench` already are, and the installer is gone.
//
// WHAT THE HOST IS FOR, and it is one entry. Two places force a fresh render — `lastKey = null`
// followed by dispatching `input` on the query field. `lastKey` is declared in **index.html's own
// script block**, not in any module, which makes it exactly as unreachable from here as a shell.js
// declaration; and the two lines are one idea, so the host takes the idea: `rerender()`.
//
// THE ACCESSION LENS CAME HOME. `adoptTaxon` (below) lived inside `onInput`, reaching in here for
// SPECIES_TAXON and writing `qcontext`/`qport` from outside — the seam map's one argument against a
// clean cut. It returns whether the lens MOVED, which is the whole of what the controller needs: on
// true it rebuilds its IR, because the lens is an input to resolve2. The lens decision is here; the
// IR stays with whoever owns the IR.
(function (root) {
  'use strict';

  let _h = {};
  function configureSpeciesLens(host) { _h = host || {}; }
  function rerender() { if (_h.rerender) _h.rerender(); }

  // ── Query-global context + port controls (beside the query bar) ────────────
  // Ported from specs/mockups/2026-07-13-shell-materials-arrangements.html
  // (the block after renderMeasurements(null)), with real re-resolve wiring
  // added for qcontext (Step 2 below) instead of the mockup's no-op comment.

  // ── The organism list has ONE source, and it is not this file ───────────────────────────────────
  // These were hand-written literals listing four organisms, while registry/organisms.tsv admitted six
  // and docs/data/proteins.parquet shipped all six. C. elegans (18 accessions) and D. melanogaster
  // (9) were therefore present in the data and unreachable from the menus — more accessions than
  // S. cerevisiae, which was offered. Three independent lists (organisms.tsv, the menu markup, these
  // maps) drift the moment any one of them is edited, and only one of them is the truth.
  //
  // So the menus are now DERIVED from proteins.parquet, which is itself derived from organisms.tsv
  // (init/fetch_registry.R filters UniProt to its taxa). That makes two properties true by
  // construction rather than by maintenance:
  //   · the menu can never offer an organism the registry does not admit;
  //   · the menu can never offer an organism we hold no protein for — which is the honest answer to
  //     "can I read the query as this?", since resolution needs sequences.
  //
  // Seeded with human only, and that is not a fourth list: human canonical is the project's declared
  // reference organism (CLAUDE.md §8), and the seed exists so a query typed before DuckDB finishes
  // loading still resolves. loadSpecies() replaces it wholesale.
  let SPECIES_TAXON = { Hs: 9606 };
  // For prose, not for lookup — a card that resolves to nothing has to name the organism it looked in.
  let SPECIES_NAME  = { Hs: 'H. sapiens' };
  function speciesLabel(code) { return SPECIES_NAME[code] || null; }

  // Taxon → display name, by reversing SPECIES_TAXON. Both maps are filled from the data by
  // loadSpecies(), so this names any organism the page can resolve into and nothing it cannot.
  function speciesNameForTaxon(taxon) {
    if (taxon == null) return null;
    const code = Object.keys(SPECIES_TAXON).find((c) => SPECIES_TAXON[c] === Number(taxon));
    return code ? SPECIES_NAME[code] : null;
  }

  // Taxon → menu code, the other direction of the same reversal.
  function codeForTaxon(taxon) {
    if (taxon == null) return null;
    return Object.keys(SPECIES_TAXON).find((c) => SPECIES_TAXON[c] === Number(taxon)) || null;
  }

  // WHICH ORGANISM A SEQUENCE WAS LOOKED FOR IN (BB, 2026-07-29). Read from the entries that actually
  // decide it — the Show as YAML when a port is active, otherwise the Read as YAML — at the same
  // precedence resolveContext uses: the family block first, then the context-level default. Reading
  // it off the menu code instead would go stale the moment the YAML is hand-edited, which is exactly
  // the disagreement making the YAML authoritative was meant to end.
  function effectiveTaxonFor(family, variant) {
    const key = variant ?? family;
    const src = portActive()
      ? { fam: (typeof portOverrides === 'object' ? portOverrides : {}), def: (typeof portDefaultTaxon !== 'undefined' ? portDefaultTaxon : null) }
      : { fam: (typeof contextOverrides === 'object' ? contextOverrides : {}), def: (typeof contextDefaultTaxon !== 'undefined' ? contextDefaultTaxon : null) };
    const entry = src.fam[key] ?? src.fam[family] ?? {};
    return entry.taxon_id ?? src.def ?? null;
  }

  // "Homo sapiens" → "Hs". The code is a LABEL derived from the name, never an identity: taxon_id is
  // the identity. Collisions are resolved by lengthening the epithet (a hypothetical Xenopus laevis +
  // Xenopus tropicalis pair gives Xl/Xt already, but Drosophila melanogaster beside a second
  // D. me… species would need more), and as a last resort by the taxon itself, because two organisms
  // sharing a code would make the menu silently ambiguous.
  function assignSpeciesCodes(rows) {
    const used = new Set();
    return rows.map((r) => {
      const parts = String(r.species || '').trim().split(/\s+/);
      const genus = (parts[0] || '?').charAt(0).toUpperCase();
      const ep    = parts[1] || '';
      let code = null;
      for (let n = 1; n <= Math.max(ep.length, 1); n++) {
        const c = genus + ep.slice(0, n).toLowerCase();
        if (!used.has(c)) { code = c; break; }
      }
      if (!code) code = genus + String(r.taxon_id);
      used.add(code);
      return { taxon_id: Number(r.taxon_id), species: r.species, code };
    });
  }

  // Abbreviated binomial for display: "Homo sapiens" → "H. sapiens".
  function abbrevBinomial(s) {
    const parts = String(s || '').trim().split(/\s+/);
    return parts.length < 2 ? String(s || '') : `${parts[0].charAt(0)}. ${parts.slice(1).join(' ')}`;
  }

  // Fill the maps and both menus from the data. Called once, after DuckDB is ready.
  async function loadSpecies() {
    const conn = await dbConnect();
    let rows;
    try {
      rows = await runPrepared(conn,
        `SELECT DISTINCT taxon_id, species FROM read_parquet('${PROTEINS_URL}')
         WHERE species IS NOT NULL ORDER BY species`, [], 'species-list');
    } finally { await conn.close(); }
    if (!rows || !rows.length) return;               // keep the seed rather than empty the menus

    // THE ORDER COMES FROM THE REGISTRY, NOT FROM THE ALPHABET [BB 2026-08-24]. The query still says
    // `ORDER BY species`, which is a stable order for the QUERY to return; this reorders what the
    // reader sees. Three places used to declare an order for the same seven organisms — this menu
    // alphabetically, the atlas in a hard-coded vector, registry/organisms.tsv in the sequence they
    // were added — so a reader moving from the figure to the menu re-learned the list. `TAXON_ORDER`
    // is that file's row order, emitted by build_vocabulary_js.R.
    //
    // A taxon the registry file does not list keeps its place at the END, alphabetically among its
    // own kind, rather than being dropped: the parquet is the authority on which organisms have
    // data and this file is the authority on their order, and the second must not silently veto the
    // first. `indexOf` returning -1 is exactly that case, mapped past the end.
    //
    // ORDER FEEDS `assignSpeciesCodes`, which is why this happens BEFORE it: codes are assigned
    // greedily first-come, so two species sharing a genus initial and epithet prefix would resolve
    // differently under a different order. None do today — measured, the seven codes are unchanged
    // — but the coupling is real and the sort has to come first for it to be decidable at all.
    const rank = (t) => {
      const i = (typeof TAXON_ORDER !== 'undefined' && Array.isArray(TAXON_ORDER))
        ? TAXON_ORDER.indexOf(Number(t)) : -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    rows = rows.slice().sort((a, b) => rank(a.taxon_id) - rank(b.taxon_id) ||
                                       String(a.species).localeCompare(String(b.species)));

    const list = assignSpeciesCodes(rows);
    SPECIES_TAXON = {};
    SPECIES_NAME  = {};
    list.forEach((s) => { SPECIES_TAXON[s.code] = s.taxon_id; SPECIES_NAME[s.code] = abbrevBinomial(s.species); });

    // If the seeded default is not among them, fall back to the first rather than leaving qcontext
    // pointing at a code that no longer resolves.
    if (!(qcontext in SPECIES_TAXON)) qcontext = list[0].code;
    if (!(qport    in SPECIES_TAXON)) qport    = qcontext;

    [['qctxmenu', 'qc'], ['qportmenu', 'qp']].forEach(([menuId, attr]) => {
      const menu = document.getElementById(menuId);
      if (!menu) return;
      // APPENDED, not inserted before a sentinel. This read `menu.querySelector('.cmi.custom')` and
      // inserted each species before it, to keep "Custom…" last in the dropdown. There is no
      // dropdown and no Custom item: the panel this row now sits in IS the custom editor, so the
      // sentinel would be a permanent null and `insertBefore(b, null)` an append wearing the name
      // of an ordering.
      menu.querySelectorAll('.cmi[data-' + attr + ']').forEach((el) => el.remove());
      list.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cmi';
        b.setAttribute('data-' + attr, s.code);
        // THE BINOMIAL ALONE [BB 2026-09-23]. It showed the code AND the name (`Hs  H. sapiens`),
        // which is two spellings of one organism in a row where every entry then reads twice. The
        // code is what the footer shows once you have picked, so inside the panel the NAME is the
        // half that adds something. `data-qc`/`data-qp` still carry the code — it is the value, and
        // it never depended on being printed.
        b.innerHTML = `<i>${escapeHtml(abbrevBinomial(s.species))}</i>`;
        menu.appendChild(b);
      });
    });
    updateControls();
  }

  // query-global state: port is "off" exactly when it equals the context
  let qcontext = 'Hs', qport = 'Hs';

  // True only once the user has actively picked a species via the #qctx menu.
  // While false (the untouched default state), contextOverrideForQuery() must
  // return {} rather than a taxon_id — otherwise the call-level override in
  // resolveContext(family, variant, overrides) (duckdb.js's
  // `{...userOv, ...overrides}` merge) unconditionally clobbers any per-family
  // taxon_id the user already set via the pre-existing Context editor
  // (context-editor.js's `contextOverrides` global, i.e. userOv), even though
  // qcontext defaults to 'Hs' and the user never touched this control.

  // `closeMenus()` WAS HERE. It cleared `.ctxmenu.open`, a class that no longer exists — left in
  // place it would have been a function that runs over an empty NodeList forever, which reads as
  // cleanup and is not. The sheet closes through `closeSheet()` like every other panel.

  // THE BUTTON OPENS THE SHEET; THE ROW INSIDE IT STILL DELEGATES THE PICK [BB 2026-09-23]. It used
  // to toggle an absolutely-positioned `.ctxmenu` anchored under the pill, with a "Custom…" entry at
  // the end that opened this sheet — two surfaces for one decision. The species row lives in the
  // sheet now, so opening is `openSheet` and there is nothing left to close on an outside click.
  //
  // `sheetName` rather than deriving one from `menuId`: the sheet names are sheet.js's contract
  // (`context` · `port` · `licence` · `diagnostics`) and the element ids are dom-contract's. Two
  // vocabularies that happen to line up today is not a reason to compute one from the other.
  function bindCtl(btnId, menuId, sheetName, onPick) {
    // NO DOM, NO CONTROLS. shell.js only ever ran with a page under it; a module is also
    // `require`d by node suites, where these are the entry points that would throw at import.
    if (typeof document === 'undefined') return;
    const btn = document.getElementById(btnId), menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    btn.addEventListener('click', () => {
      // NOT a toggle. Picking a species and reopening the panel to pick another must land on an
      // open panel — see `sheet.js`'s comment on `opts.toggle` for why OPEN, not toggle, is the
      // contract for these two editors.
      if (typeof openSheet === 'function') openSheet(sheetName);
    });
    menu.addEventListener('click', e => {
      const it = e.target.closest('.cmi');
      if (!it) return;
      onPick(btn, it);
    });
  }

  function updateControls() {
    // NO DOM, NO CONTROLS. shell.js only ever ran with a page under it; a module is also
    // `require`d by node suites, where these are the entry points that would throw at import.
    if (typeof document === 'undefined') return;
    // THE ATLAS IS ONE OF THE CONTROLS [BB 2026-08-25]. Its lit ring says which organism the page is
    // reading as, which is the same fact the "Read as" button spells — so it has to be repainted
    // wherever that fact moves, and this function is where every path that moves it converges (the
    // menu pick, Apply in the editor, `adoptTaxon`, and the initial species load). Hooking the
    // dropdown handler alone would have left the figure stale on the other three.
    if (typeof root.restAtlas === 'function') root.restAtlas();
    // THE DISCLOSURE CARET WENT WITH THE MENU [BB 2026-09-23]. Both controls used to carry one, and
    // the CSS rotated it on `.ctxmenu.open` — a state that no longer exists, so it would have been a
    // triangle that never turns. They sit in the footer now beside Diagnostics and Licence, which
    // carry none, and they open the same kind of panel those two do.

    // THE BUTTONS READ THE YAML (BB, 2026-07-29). They used to show the last menu pick, which went
    // stale the moment the text box was hand-edited — the same disagreement making the YAML
    // authoritative was meant to end, surviving in the one place the reader looks first.
    //
    // Each shows its CONTEXT-LEVEL default. A family block that names a different taxon is an
    // exception the button does not try to summarise: "Mixed" would say less than a species code on
    // the common case, and the exceptions are one click away in the panel the button opens.
    //
    // NO FALLBACK (BB, 2026-08-07). This read `?? 9606`, which was the right answer arrived at
    // independently — and the engine's own reader arrived at ⊤ instead, so the button and the answer
    // disagreed for exactly as long as nobody compared them. The context is initialised at startup
    // and is never unset, so there is nothing to substitute for. The `typeof` is not a fallback: it
    // covers a render suite that loads shell.js without the editor, where null (→ no code → the label
    // stands) is honest and 9606 would be a claim.
    const ctxTaxon  = (typeof contextDefaultTaxon !== 'undefined') ? contextDefaultTaxon : null;
    // The same predicate the materials pane uses, so the button's arrow and the drift indicators can
    // never disagree about whether a port is on — they did, and the button was the honest one only by
    // accident (both read "a YAML exists").
    const portOn    = portGoesElsewhere();
    // THE SHOW AS STATES ITS OWN TARGET (BB, 2026-08-07). This read the context whenever the port was
    // off, because an unstated Show as used to INHERIT one — and the panel was rewritten below to say
    // so. Both are gone with the third state: the Show-as context is initialised and never unset, so
    // the button shows what it holds, exactly as the Read as button does. `portOn` is a comparison of
    // the two and no longer decides what either one displays. The `typeof` guards a page that loaded
    // shell.js without the editors; it is not a fallback, and no suite exercises it — nothing in
    // tests/js evaluates shell.js, so the whole family of `typeof` checks in this file is unverified.
    const portDef   = (typeof portDefaultTaxon !== 'undefined') ? portDefaultTaxon : null;
    const portTaxon = portDef != null ? portDef : ctxTaxon;

    // Keep the globals truthful too — portDriftActive() and the accession lens both read them.
    qcontext = codeForTaxon(ctxTaxon)  || qcontext;
    qport    = codeForTaxon(portTaxon) || qport;

    // GUARDED for the same reason `#qctx` and `#qport` below are. Unguarded is what shell.js could
    // afford: it ran with the whole page under it and this call sat at the bottom of the file. Here
    // it runs at module load, and the module's stated contract is that it loads standalone — so a
    // page or a harness with a `document` but not these two ids would throw during initialisation
    // and take `bindCtl`, `adoptTaxon` and the entire export list down with it. Pre-existing code;
    // what changed is the claim being made about it, and this makes the claim true.
    // THE CODE ONLY — "Map" and the arrow between them are static markup in footer.html, so these
    // two write the half that changes and nothing else [BB 2026-09-23]. The arrow used to be
    // PREFIXED to the port code when the port went elsewhere; with a permanent arrow in the label
    // that signal has to live somewhere else, and `.on` is where — the same tint `Match` uses.
    const cb = document.getElementById('qctx');
    if (cb) cb.innerHTML = '<b>' + qcontext + '</b>';
    const pb = document.getElementById('qport');
    if (pb) {
      pb.innerHTML = '<b>' + qport + '</b>';
      pb.classList.toggle('on', portOn);
    }

    // WHICH SPECIES IS SELECTED, IN THE PANEL THAT OFFERS THEM. The row had no selected state at
    // all as a dropdown — you opened it, picked, and it closed, so there was never a moment where
    // "the current one" had to be visible. It stays open now, so a row of identical buttons with no
    // mark would leave the reader's own choice unreadable.
    for (const [menuId, attr, code] of [['qctxmenu', 'qc', qcontext], ['qportmenu', 'qp', qport]]) {
      const menu = document.getElementById(menuId);
      if (!menu) continue;
      menu.querySelectorAll('.cmi[data-' + attr + ']')
        .forEach((el) => el.classList.toggle('on', el.getAttribute('data-' + attr) === code));
    }
  }

  // `showEditor(id)` — the id-to-sheet-name translator this comment used to describe — is DELETED
  // (code-review 2026-09-25, LOW 5). Both of its callers (the "Custom…" branches in the Read-as/
  // Show-as menus) went with the `.cmi.custom` dropdown on 2026-09-23; `bindCtl` above opens the
  // sheet directly (`openSheet(sheetName)`) and neither `showEditor` name survives in `api`. Kept
  // dead for two waves after that move, it would have been wrong if revived: its non-`openSheet`
  // fallback (`el.hidden = false`) never set `body.sheet-open`, so it opened a panel with no scrim
  // and no scroll lock. Not opening the editor without `{ toggle: true }` is still the rule — see
  // `sheet.js`'s comment on `opts.toggle` — it is just `bindCtl`'s `openSheet(sheetName)` call that
  // carries it now.

  // SPECIES → CONTEXT, as of 2026-07-29.
  //
  // resolveContext(family, variant, overrides) in duckdb.js resolves a material under three layers,
  // lowest first: the context-level `taxon_id` from the editor's YAML (contextDefaultOverride), then
  // that YAML's per-family block, then `overrides` — which is now ONLY an accession the query itself
  // named, since an accession pins its own species.
  //
  // The species menu does not participate in that merge. It WRITES the YAML (applyContextTaxon) and
  // the merge reads it back, so the control and the text box cannot disagree.
  //
  // THE LENS IS ALWAYS EXPLICIT (BB, 2026-07-26: "context and port should be set by default as Hs,
  // not silently be false"). The original failure was a hidden third state: the chip SAID `Hs` while
  // `qcontextTouched === false` made it assert nothing, so the displayed context and the applied one
  // disagreed until you touched the control. That was first fixed with an explicit `custom` branch;
  // the branch is now unnecessary, because with a single authority there is nothing for a third state
  // to diverge FROM. A lens that shows a species and imposes none is the kind of quiet disagreement
  // this project keeps finding; if `Hs` is what the page says, `Hs` is what it means.

  // THE EDITOR'S YAML IS THE ONLY SOURCE OF CONTEXT (BB, 2026-07-29).
  //
  // This used to return a call-level `{taxon_id}` straight from the dropdown, which resolveContext
  // then merged OVER the per-family YAML — so the dropdown silently beat anything typed in the
  // editor. There were two sources of one fact and the wrong one won.
  //
  // Now the dropdown WRITES the YAML (applyContextTaxon below) and this reads it back, so there is
  // one authority and the menu is a way to populate it. The invariant the previous `'custom'` special
  // case protected still holds and is now structural rather than a branch: there is no state in which
  // the lens silently does nothing, because the lens IS the text in the box.
  function contextOverrideForQuery() {
    return (typeof contextDefaultOverride === 'function') ? contextDefaultOverride() : {};
  }

  // The taxon the page is READING AS, as a number — which is exactly what the "Read as" button
  // spells. Added so the atlas has ONE source for which organism is current [BB 2026-08-25]: it was
  // keeping its own copy, seeded null, so a fresh page highlighted no ring while the button already
  // said Hs, and the two could only ever agree by accident. `qcontext` IS that state — the lens is
  // the text in the box — so this reads it rather than tracking it.
  function contextTaxon() {
    return SPECIES_TAXON[qcontext] ?? null;
  }

  // Changing qcontext must invalidate the resolved-context cache and force a
  // full re-resolve: clearContextCache() (duckdb.js) flushes resolveContext's
  // memoized results (keyed on [family, variant, overrides] — see
  // duckdb.js:31-33), and nulling lastKey + re-dispatching 'input' forces
  // onInput() to treat the (unchanged) query text as new and re-run
  // renderMaterials()/AM lookups under the new overrides.
  function onQueryContextChanged() {
    clearContextCache();
    rerender();
  }

  // Port drift (materials pane only). See specs/2026-07-13-port-drift-design.md.
  // Active iff the port lens differs from context, or the Show-as YAML targets somewhere the Read-as
  // YAML does not. `portDriftActive` is the pure rule; `portGoesElsewhere` is the state it reads.
  //
  // It used to read `isPortActive()`, which answers "is a Show-as YAML set" — a different question,
  // and one that stays true forever once any target has been picked. See portTargetsElsewhere.
  function portGoesElsewhere() {
    // The `typeof`s cover a page that loaded shell.js without the pure models or the editors. False
    // is the honest answer where the rule cannot be evaluated: a page with no lenses has no port. It
    // is a guard on the CALL, not a substitute for either end — both are stated wherever the editors
    // are loaded, which is every page the site ships.
    if (typeof portTargetsElsewhere !== 'function') return false;
    if (typeof portDefaultTaxon === 'undefined' || typeof contextDefaultTaxon === 'undefined') return false;
    return portTargetsElsewhere(portDefaultTaxon, portOverrides, contextDefaultTaxon);
  }
  function portActive() {
    return portDriftActive(qport, qcontext, portGoesElsewhere());
  }

  // Call-level override injecting the query-global port species taxon, mirroring
  // contextOverrideForQuery(). Empty when port is off or set to 'custom' (then we
  // defer entirely to the portOverrides YAML via resolvePortContext).
  // Mirrors contextOverrideForQuery: the Show as YAML is the only source of the port target, and the
  // menu writes it (applyPortTaxon). The old `qport === 'custom' || qport === qcontext` guard is gone
  // for the same reason its Read as twin was — with one authority there is nothing to diverge from,
  // and "no port" is now simply an empty Show as YAML.
  function portOverrideForQuery() {
    return (typeof portDefaultOverride === 'function') ? portDefaultOverride() : {};
  }

  // Changing qport invalidates the src↔port alignment cache and forces a full
  // re-render (mirrors onQueryContextChanged). Only materials actually change,
  // but re-dispatching 'input' is the simplest correct path.
  function onQueryPortChanged() {
    clearAlignmentCache();
    rerender();
  }

  // Picking a species WRITES the editor's YAML and applies it, rather than setting a parallel piece
  // of state. That is the whole point of the rework: one authority, and the menu is a shortcut into
  // it. "Custom…" just opens the editor on whatever the menu last wrote, so the reader starts from a
  // filled-in example instead of a blank box — which is the other half of "easier to edit".
  function applyContextTaxon(code) {
    const taxon = SPECIES_TAXON[code];
    const box   = document.getElementById('context-yaml');
    if (taxon == null || !box || typeof contextYamlForTaxon !== 'function') return false;
    setContextTaxon(taxon, SPECIES_NAME[code] || null);
    onQueryContextChanged();                                  // clears the cache and re-renders once
    return true;
  }

  bindCtl('qctx', 'qctxmenu', 'context', (btn, it) => {
    qcontext = it.dataset.qc;
    // applyContext() already re-renders; only fall back to the old path if the write failed.
    if (!applyContextTaxon(qcontext)) onQueryContextChanged();
    updateControls();
  });

  function applyPortTaxon(code) {
    const taxon = SPECIES_TAXON[code];
    const box   = document.getElementById('port-yaml');
    if (taxon == null || !box || typeof contextYamlForTaxon !== 'function') return false;
    setPortTaxon(taxon, SPECIES_NAME[code] || null);
    onQueryPortChanged();
    return true;
  }

  bindCtl('qport', 'qportmenu', 'port', (btn, it) => {
    qport = it.dataset.qp;
    if (!applyPortTaxon(qport)) onQueryPortChanged();
    updateControls();
  });

  // The document-level "click outside `.qctl` closes the menu" listener went with the menu. `.qctl`
  // is not in the markup any more either.

  // AN ACCESSION MOVES THE SPECIES LENS (BB, 2026-07-26, option A). A material names its own species,
  // and the query means that molecule — so the lens follows rather than fights it, and the chip shows
  // WHY you are looking at yeast. This is the visible version of the pin we removed: the same
  // information, asserted where the reader can see and change it instead of inside a context override
  // they never made.
  //
  // It lived in `onInput` until 2026-08-15 — lens logic in the controller, reaching in here for
  // SPECIES_TAXON and writing qcontext/qport from outside. Returning whether the lens MOVED is what
  // lets it come home: the caller rebuilds its IR on a true, because the lens is an INPUT to resolve2
  // (variant sets and numbering frames are per-taxon) and a pass built before the move answers the
  // wrong question. The IR is the caller's; the lens is ours.
  function adoptTaxon(wantTaxon) {
    if (wantTaxon == null || SPECIES_TAXON[qcontext] === wantTaxon) return false;
    const label = Object.keys(SPECIES_TAXON).find((k) => SPECIES_TAXON[k] === wantTaxon);
    if (!label) return false;
    // Write the YAML, not just the code: the YAML is what resolveContext reads, so setting the code
    // alone would move the button and leave the actual lens where it was.
    if (typeof setContextTaxon === 'function') setContextTaxon(wantTaxon, SPECIES_NAME[label] || null);
    if (qport === qcontext) qport = label;      // an unmoved port follows the context
    qcontext = label;
    updateControls();
    clearContextCache();
    return true;
  }

  updateControls();

  // `contextOverrideForQuery` is the reason the notation module's installer could go: it is exported
  // here, so a bare call resolves through `globalThis` from any module on the page.
  const api = { configureSpeciesLens, adoptTaxon, contextOverrideForQuery, portOverrideForQuery,
                contextTaxon,
                updateControls, loadSpecies, portActive, portGoesElsewhere,
                speciesLabel, speciesNameForTaxon, codeForTaxon, effectiveTaxonFor,
                assignSpeciesCodes, abbrevBinomial };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// docs/_includes/js/relevance-model.js
// The relevance layer, extracted from shell.js on 2026-08-15 (U1 of specs/2026-08-13-shell-seams.md).
// Decides which measurements are relevant. Pure in the sense that matters here: not one DOM
// reference, and every piece of the page's mutable state it reads arrives through `host`.
//
// WHY IT IS A FACTORY AND NOT A MODULE OF FUNCTIONS. Six memos live in here — the tile up-sets, the
// datum up-sets, the datum IRs, the materialized datums, the reference particle and the query column
// spec. As module-level state they would be shared by every caller and unresettable from a test; as
// instance state each `createRelevance()` starts clean, which is what lets the suite assert a memo
// key matters by building two instances instead of reaching into a private Map.
//
// `host` supplies the page's live state as GETTERS, never as values — `broaden`, the selected unit
// and the world map all change between renders, and a value captured at construction would freeze the
// answer to whatever was true at boot.
//
// Dependencies (glyph-universe, measurements-model, shell-model, the engine) resolve from `host`
// first and the global scope second. In a node suite they are injected; in the page they are
// genuinely global — but only because those modules END with `Object.assign(globalThis, api)`.
//
// A FUNCTION DECLARED IN SHELL.JS IS NOT GLOBAL, AND THAT COST A ROUND TRIP. `docs/index.html`
// inlines everything into a `<script type="module">`, and a module's top-level declarations do NOT
// become properties of `globalThis`. So `root.unitIR2` is undefined on the real page while every
// node suite finds it fine — the VM suites run shell.js as a CLASSIC script, where declarations do
// land on the context. `make test` stayed green (99 suites) and the page failed open: with no
// reference particle the mark axis has no operand, returns true for every row, and the measurements
// panel showed six sections where the query admits one. Caught by the screenshot diff, 2026-08-15.
//
// The rule that follows: anything DECLARED IN SHELL.JS must arrive through `host`. The global
// fallback is for the `Object.assign` modules only.
//
// `particleOf` deliberately did NOT come along: shell.js:138/2028/2062/3402 still call it, and it is
// a one-line delegate to the engine. This file uses the engine's directly rather than owning a name
// that four other places also need.
//
// `tileGlyphIndex` has no caller anywhere in the repository. Carried across unchanged rather than
// dropped, because an extraction that also deletes is an extraction whose diff no longer means "the
// same code, somewhere else". Delete it separately or not at all.
(function (root) {
  'use strict';

  function createRelevance(host) {
    const h = host || {};
    // host first, global scope second.
    const fn = (name) => {
      if (typeof h[name] === 'function') return h[name];
      return (typeof root[name] === 'function') ? root[name] : null;
    };
    const engine = () => (h.nucleosomeParser2 || root.nucleosomeParser2 || null);

    const broaden = () => !!(h.broaden && h.broaden());
    const worldFor = (arrStr) => (h.worldFor ? h.worldFor(arrStr) : null);
    const glyphC = () => (h.glyphC ? h.glyphC() : new Set());
    const contextOverride = () => (h.contextOverride ? h.contextOverride() : null);

    // The fixed glyph universe G, enumerated once (glyph-universe.js) — same deterministic index the
    // ingestion used, so a datum's stored glyph_mask lines up with a tile's glyph here.
    const enumerate = fn('enumerateGlyphs');
    const GLYPH_U = enumerate ? enumerate() : { glyphs: [], index: {} };

    // Keyed by the arrangement string because that is what a tile IS on this page, but the glyph is
    // derived from the WORLD IR — `glyphOf` reads `variant`/`modifications` as fields instead of
    // decoding stateSig's control prefixes out of the string. The world map covers every octamer (the
    // accepted limit, 200, is below WORLD_IR_CAP, 256, so the IR list never truncates).
    function tileWorld(arrStr) { return worldFor(arrStr) || null; }
    function tileGlyphIndex(arrStr) {
      const w = tileWorld(arrStr);
      const glyphOf = fn('glyphOf');
      const gi = (w && glyphOf) ? GLYPH_U.index[glyphOf(w)] : null;
      return gi == null ? null : gi;
    }
    // One tile's up-set, memoised: the same handful of arrangement strings is re-tested against every
    // candidate row and again for every has-data dot.
    const _tileUpSet = new Map();
    function tileUpSet(arrStr) {
      if (!_tileUpSet.has(arrStr)) {
        const w = tileWorld(arrStr);
        const worldUpSet = fn('worldUpSet');
        _tileUpSet.set(arrStr, (w && worldUpSet) ? worldUpSet(w, GLYPH_U) : []);
      }
      return _tileUpSet.get(arrStr);
    }
    // …AND THE TILE UP-SET MEMO is cleared from OUTSIDE, by whoever rebuilds the world map. It used to
    // cache a pure function of the arrangement string; it now caches `worldUpSet(worldFor(arrStr))`,
    // so its value depends on that map. The key is not unique across queries either: `stateSig`
    // embeds an identity's INDEX into a per-interpretation list, so one string can denote different
    // worlds in two queries, and the strict measurement filter would read the previous one's answer.
    // Reviewed 2026-08-05. Extracting made this an explicit call instead of a reach into a private Map.
    function resetWorlds() { _tileUpSet.clear(); }

    // The datum's stored SHAPE — a point (or empty, for arrays/materials, which never attach to a tile).
    function datumGlyphMask(row) {
      if (!row || row.glyph_mask == null) return [];
      try { return typeof row.glyph_mask === 'string' ? JSON.parse(row.glyph_mask) : row.glyph_mask; } catch (e) { return []; }
    }
    // …and its up-set, which is what `compatible` compares. The parquet keeps the precise shape and the
    // MODE decides how much of it binds, so opening the datum needs no re-ingestion. Memoised per row.
    const _datumUpSet = new WeakMap();
    function datumUpSet(row) {
      if (row && typeof row === 'object') {
        if (_datumUpSet.has(row)) return _datumUpSet.get(row);
        const glyphUpSet = fn('glyphUpSet');
        const s = glyphUpSet ? glyphUpSet(datumGlyphMask(row), GLYPH_U) : [];
        _datumUpSet.set(row, s);
        return s;
      }
      return [];
    }

    // ── Relevance, axis by axis ───────────────────────────────────────────────────────────────────
    // Two axes, two mechanisms, and neither one is the whole answer:
    //   SHAPE  — the glyph prefilter below. Cheap, set-valued, and only ever an OVER-approximation: its
    //            single obligation is soundness (never drop what the meet would keep).
    //   MARK   — `meet2`, via compatible2/entails2. This is the relation the answer is DEFINED by; the
    //            prefilter exists to keep it off the hot path, not to replace it.
    // Running the shape axis alone is what made the panel's `entails` toggle attach an H2A.Z datum to an
    // H2A world (finding 2, specs/2026-07-24-glyph-relevance-oracle.md). Both now run, in that order —
    // the same two-stage shape then the same `rel(datumIR, queryIR)` that queryThreeTier's Tier 0/Tier 2
    // already use for the Arrays card, so one page no longer holds two relevance semantics.

    // Shape axis. broaden → the datum's up-set meets the query's; strict → the datum's concrete shape lies
    // IN the selected tile's up-set (the datum is at least as specific as that world).
    function glyphRelevantRows(rows, selectedArrStr) {
      if (broaden()) { const C = glyphC(); return rows.filter(r => datumUpSet(r).some(g => C.has(g))); }
      if (!selectedArrStr) return [];
      const up = tileUpSet(selectedArrStr);
      return rows.filter(r => datumGlyphMask(r).some(g => up.includes(g)));
    }

    // AN ARRAY OF ONE IS THAT ONE. Both sides of the relation must sit at the SAME level of the IR —
    // meet2 bottoms out on a node-type mismatch, so handing it an array-of-one datum against an assembly
    // query silently rejects everything. A lone particle lifts to an array of one; unwrap it.
    //
    // The engine's, since 2026-08-05. This sentence was written six times across the repo (census §2).
    function particleOf(ir) {
      const P2 = engine();
      return (P2 && typeof P2.particleOf === 'function') ? P2.particleOf(ir) : ir;
    }

    // The datum's own IR, from the notation it was deposited under. Memoised per (notation, taxon): the
    // same handful of descriptors recur across every row of a screen.
    //
    // IT RESOLVES, IT DOES NOT MERELY LIFT (BB, 2026-07-29). A deposited descriptor may be written on the
    // MATERIAL — `H2B2:K123ub`, yeast H2B in yeast numbering, which is the numbering the measurement was
    // actually made in and the numbering ruling 3 says to preserve. `lift2` alone leaves that 123 as a
    // literal, so the relevance meet compared it against the query's idea-120 and rejected: the yeast
    // container was found by the SQL tier and then silently dropped by this one, which is the opposite of
    // the "must be findable by a human-framed K120ub query" its own spec states. `resolve2` translates
    // material→idea at the authored moment (`toIdeaFrame`) — the datum keeps its own spelling in the
    // table and enters the lattice on idea coordinates, which is exactly the split relevance needs.
    //
    // THE TAXON IS NOT OPTIONAL. A UniProt mnemonic is not unique: 47 of them name more than one framed
    // accession and 22 of those groups disagree on numbering (`H14` is P10412 at 120 and O17536 at 154),
    // so the same string denotes different residues in different organisms. The datum's own taxon is the
    // context that settles it, and it travels on the measurement row.
    //
    // Fail-open on a refusal, matching the callers below: 7 of the 247 stored notations are vocabulary
    // gaps, and a resolve error (an unclassifiable handle, a position with no idea counterpart) must not
    // be a harder failure than a parse error already is. Falling back to the lifted IR keeps today's
    // behaviour for exactly those rows rather than dropping them.
    const _datumIR = new Map();
    // THE MATERIAL IT WAS MEASURED ON, NOT THE CLADE IT WAS SPELLED WITH (BB, 2026-07-30).
    //
    // The variant axis is a TREE and a token denotes its SUBTREE — right for a query, where `caH3` must
    // reach H3.1. On a DATUM the same expansion states ignorance: `[H2AZ]2` resolves to
    // `variant: ["H2A.Z","H2A.Z.1","H2A.Z.2"]`, i.e. "measured on H2A.Z, or Z.1, or Z.2 — unknown
    // which". A world pins `H2A.Z.1`, and {Z,Z.1,Z.2} is not a subset of {Z.1}, so entails2(datum,
    // world) was false for every one of the nine worlds `(H2A.Z)` denotes. A dead zone for EVERY clade
    // token — H2A.Z, caH2A, caH3 — not a quirk of one variant, and invisible because `compatible` went
    // on matching.
    //
    // The ignorance was fabricated: the ingester resolved the material and stored it. `classify` turns
    // that accession back into the variant it actually is, which is this project's stated rule —
    // measurements resolve by accession through protein_families, not by the depositor's token.
    //
    // `accession` STAYS NULL. Pinning it would make the datum a material claim and re-break the organism
    // ruling; narrowing only the idea-layer variant keeps the meet organism-blind and still works across
    // organisms, because the mouse accession classifies to the same variant (P0C0S6 -> H2A.Z.1).
    //
    // NARROWING ONLY, and only within what the descriptor already said: if `classify` returns a variant
    // the resolved node does not list, the descriptor is left alone. A datum may not be made to say
    // something it did not say — that is the same fabrication with the sign flipped.
    function narrowByAccession(ir, byFamily) {
      const P2 = engine();
      const reg = P2 && P2.DEFAULT_REGISTRY;
      if (!ir || !reg || typeof reg.classify !== 'function' || !byFamily || !byFamily.size) return ir;
      // Returns the SAME node when nothing narrowed, all the way up. Cloning unconditionally would be
      // correct and invisible — and would make "was this datum narrowed?" unanswerable by identity,
      // which is how the first corpus check reported 1184 narrowings out of 1184 measurements.
      const walk = (n) => {
        if (!n || typeof n !== 'object') return n;
        if (Array.isArray(n)) {
          let changed = false;
          const out = n.map((x) => { const y = walk(x); if (y !== x) changed = true; return y; });
          return changed ? out : n;
        }
        if (n.node === 'proteoform') {
          const acc = byFamily.get(n.family);
          const have = Array.isArray(n.variant) ? n.variant : (n.variant == null ? [] : [n.variant]);
          // `have.length < 2`: nothing was expanded, so there is nothing to narrow.
          if (!acc || have.length < 2) return n;
          let cls = null;
          try { cls = reg.classify(acc); } catch (e) { return n; }
          if (!cls || !cls.variant || !have.includes(cls.variant)) return n;
          return { ...n, variant: [cls.variant] };
        }
        let changed = false;
        const out = {};
        for (const k of Object.keys(n)) {
          const v = n[k];
          const w = (v && typeof v === 'object') ? walk(v) : v;
          if (w !== v) changed = true;
          out[k] = w;
        }
        return changed ? out : n;
      };
      return walk(ir);
    }

    // The family -> accession the MEASUREMENT recorded, read off its own lookup rows.
    function datumAccessions(rows) {
      const m = new Map();
      for (const r of rows || []) {
        if (r && r.family && r.uniprot_id && !m.has(r.family)) m.set(r.family, r.uniprot_id);
      }
      return m;
    }

    function datumIR(notation, taxonId, byFamily) {
      if (!notation) return null;
      // The accessions are part of the identity of the answer, so they belong in the memo key. Keyed on
      // notation alone, the first caller's narrowing would be served to every later one.
      const accKey = (byFamily && byFamily.size)
        ? [...byFamily.entries()].sort().map((e) => e[0] + ':' + e[1]).join(',') : '';
      const key = notation + '\u001f' + (taxonId == null ? '' : taxonId) + '\u001f' + accKey;
      if (!_datumIR.has(key)) {
        const P2 = engine();
        let ir = null;
        try {
          const lifted = P2 ? particleOf(P2.lift2(P2.parse(notation))) : null;
          if (lifted && typeof P2.resolve2 === 'function') {
            const ctx = taxonId == null ? {} : { taxon_id: taxonId };
            let r = null;
            try { r = P2.resolve2(lifted, ctx, P2.DEFAULT_REGISTRY, 'resolve'); } catch (e) { r = null; }
            ir = (r && r.node !== 'error' && r.node !== 'bottom') ? particleOf(r) : lifted;
          } else {
            ir = lifted;
          }
          ir = narrowByAccession(ir, byFamily);
        } catch (e) { ir = null; }
        _datumIR.set(key, ir);
      }
      return _datumIR.get(key);
    }

    // Mark axis. The reference is the SELECTED WORLD under strict (a concrete, meet-derived assembly — the
    // most specific thing we can be entailed by) and the focused unit's query IR under broaden.
    //
    // FAIL-OPEN, deliberately: an unparseable descriptor or a missing world IR returns true, keeping the
    // row the shape axis already accepted. 7 of the 247 stored notations are vocabulary gaps v1 cannot
    // parse either; silently dropping a measurement because our own parser has a hole is the failure mode
    // this whole exercise exists to prevent. Over-inclusion is visible; a drop is not.
    // The reference particle, built ONCE per (unit, IR) rather than per measurement row. It is the same
    // object every time, which is what lets the engine's species memo actually hit: `compatible2` reaches
    // `speciesOf` — two meets against every species template — through `denotes` on both arguments, and
    // rebuilding this node per row made that uncacheable. Profiled at 5.1 s in renderMeasurements on a
    // broad query, 63% of it below `speciesOf`.
    let _refCache = { ir: null, unit: null, node: null };
    function referenceParticle() {
      const ir = h.currentIR ? h.currentIR() : null;
      const unit = h.selectedUnit ? h.selectedUnit() : null;
      if (_refCache.ir !== ir || _refCache.unit !== unit) {
        // HOST ONLY — `unitIR2` is declared in shell.js, and the page is a module, so it is not on
        // `globalThis` there even though every node suite finds it. See the header.
        _refCache = { ir, unit, node: h.unitIR2 ? particleOf(h.unitIR2(unit)) : null };
      }
      return _refCache.node;
    }

    // ── THE COLUMN PREFILTER, on the query ────────────────────────────────────────────────────────
    // `materialize3` runs on the QUERY, so the columns its marks occupy are known before any row is
    // examined — and ingestion writes `aln_column` from the same alignment. So the mark axis has a cheap
    // pre-stage: a measurement whose rows sit at no column the query names cannot carry the query's
    // marks, and `entails2` would reject it after re-parsing its notation and columnizing both sides.
    //
    // STRICT ONLY, AND THIS IS THE WHOLE SOUNDNESS ARGUMENT. Strict asks `entails2(datum, query)` —
    // datum ⊑ query — so the datum must carry the query's marks, hence must have a row at the query's
    // column. Broaden asks `compatible2`, CO-SATISFIABILITY, and two descriptions are co-satisfiable
    // without sharing a position at all: `H4:K16ac` and `H3:K27M` sit happily on one particle. Applying
    // the gate there would drop exactly the combinatorial data broaden exists to surface.
    //
    // It runs PER MEASUREMENT, like the meet it precedes: a screen deposits one row per mark and the
    // measurement qualifies if ANY row lands. Filtering rows individually would drop a measurement's
    // other coordinates and then mis-render the group.
    //
    // THREE WAYS IT DECLINES TO SPEAK, each an accept:
    //   · the query names no column at all (a bare histone, or only α/ω marks);
    //   · materialize3 refused the query (no anchor, unplaceable mark) — no columns to compare;
    //   · the measurement has a row OUTSIDE the alignment, which this gate cannot judge (42,503 of
    //     208,714 lookup rows). Silently dropping those would make the prefilter a cap on relevance.
    let _qSpec = { ir: null, ctx: null, spec: null };
    function queryColumnSpec() {
      const ir = referenceParticle();
      const ctxObj = contextOverride() || {};
      const ctxKey = JSON.stringify(ctxObj || {});
      if (_qSpec.ir === ir && _qSpec.ctx === ctxKey) return _qSpec.spec;
      let spec = null;
      try {
        const P2 = engine();
        const queryColumns = fn('queryColumns');
        const queryVariants = fn('queryVariants');
        if (ir && P2 && typeof P2.materialize3 === 'function' && queryColumns) {
          const mat = P2.materialize3(ir, ctxObj, P2.DEFAULT_REGISTRY);
          const cols = queryColumns(mat);
          // COLUMNS from the materialized node — that is what the walk resolved. VARIANTS from the
          // AUTHORED node: materialize3 replaces the variant axis with a cover computed against the
          // context taxon, and gating on that drops cross-species rows the meet keeps.
          if (cols.length) spec = { columns: cols, variants: queryVariants ? queryVariants(ir, P2.DEFAULT_REGISTRY) : null };
        }
      } catch (e) { spec = null; }          // refused query → no opinion, never a rejection
      _qSpec = { ir, ctx: ctxKey, spec };
      return spec;
    }

    function columnAxisAccepts(rows) {
      if (broaden()) return true;                                // co-satisfiability shares no position
      const spec = queryColumnSpec();
      const columnGate = fn('columnGate');
      if (!spec || !columnGate) return true;
      const g = columnGate(rows, spec.columns, null, spec.variants);
      if (g.unplaceable.length) return true;                     // cannot judge → do not reject
      return g.kept.length > 0;
    }

    // ── BOTH SIDES OF THE MEET ARE MATERIALIZED HERE ──────────────────────────────────────────────
    // The relevance layer used to columnize its operands on the way into `entails2`/`compatible2`. That
    // was the on-the-fly translation materialize-before-enumerate exists to abolish, and it ran per
    // comparison across ~200k rows. Now the WORLD already carries columns (interpret3), so the DATUM and
    // the reference particle are put in the same coordinates once, here, and the meet compares raw.
    //
    // NOT inside `datumIR`: its other consumer is the CAPTION (`canonCaption(datumIR(notation))`), which
    // must print the numbers the depositor wrote. One function, two readers, two coordinate systems —
    // so the materialization belongs at the call site that needs it, which is this one.
    //
    // A refusal (no anchor, an unposable walk, an unplaceable mark) yields no node, and the caller then
    // declines to reject: an operand the engine will not place is a question this layer cannot answer.
    // The taxon the CONTEXT is set to — not `queryTaxon(ir)` in shell.js, which answers the different
    // question of which species the query itself NAMES through its accessions. Two questions, two names:
    // they were briefly one, and since index.html inlines every module into ONE scope that is a
    // redeclaration and a hard SyntaxError, which takes the whole page down.
    function contextTaxon() {
      const c = contextOverride();
      return (c && c.taxon_id != null) ? c.taxon_id : null;
    }
    // THE SAME KEY `datumIR` USES. Its own memo is keyed on notation ⧉ taxon ⧉ accessions because "the
    // accessions are part of the identity of the answer"; memoising one layer up on notation ⧉ taxon
    // alone hands the first caller's narrowing to every later one — the exact bug the lower memo exists
    // to prevent, reintroduced above it. Reviewed 2026-08-05.
    function datumMemoKey(notation, taxonId, byFamily) {
      const accKey = (byFamily && byFamily.size)
        ? [...byFamily.entries()].sort().map((e) => e[0] + ':' + e[1]).join(',') : '';
      return 'd\u001f' + notation + '\u001f' + (taxonId == null ? '' : taxonId) + '\u001f' + accKey;
    }
    const _matDatum = new Map();
    function materializedFor(ir, taxonId, memoKey) {
      if (!ir) return null;
      if (memoKey != null && _matDatum.has(memoKey)) return _matDatum.get(memoKey);
      const P2 = engine();
      let out = null;
      try {
        if (P2 && typeof P2.materialize3 === 'function') {
          const ctx = taxonId == null ? {} : { taxon_id: taxonId };
          // POSITIONS ONLY — `materializeNode`, not `materialize3`. Relevance must stay ORGANISM-BLIND:
          // a query in one organism must reach data measured in another, and the organism is displayed,
          // not filtered on. `materialize3` fills the accession axis, which pins each side to its own
          // taxon's molecules — measured, the yeast container `[H2B2:K123ub]` stopped entailing the human
          // `[H2B-K120ub]` query, because ⊤ does not entail a set. That is the very reach the container
          // exists to demonstrate, and R22's "one question read in each molecule's own numbering".
          //
          // A typed handle still pins, because the READER wrote it — an authored distinction, not a mode.
          const m = P2.materializeNode(ir, ctx, P2.DEFAULT_REGISTRY);
          // A REFUSED MEMBER IS NO OPINION, NOT A SMALLER PARTICLE. R28 drops the member and returns an
          // ordinary assembly, so `(H2A.Z:K119ub)` comes back as SEVEN copies — which `admissible2`
          // rejects, so `valid2` is false, so `compatible2`/`entails2` return null, and `!!null` is false.
          // The datum was then DROPPED from the measurements and from the has-data dots, with none of the
          // fail-open paths taken. Reviewed 2026-08-05.
          const refused = m && Array.isArray(m.refusals) && m.refusals.length > 0;
          out = (m && m.node !== 'unmaterializable' && !refused) ? particleOf(m) : null;
        }
      } catch (e) { out = null; }
      if (memoKey != null) _matDatum.set(memoKey, out);
      return out;
    }

    function markAxisAccepts(rows, selectedArrStr) {
      if (!broaden()) return entailsWorld(rows, selectedArrStr);
      const P2 = engine();
      const tax = measurementTaxon(rows);
      const accs = datumAccessions(rows);
      const dIR = materializedFor(datumIR(measurementNotation(rows), tax, accs), tax,
                                  datumMemoKey(measurementNotation(rows), tax, accs));
      const ref = materializedFor(referenceParticle(), contextTaxon(), null);
      if (!P2 || !dIR || !ref || typeof P2.compatible2 !== 'function') return true;
      // Bounds before the meet. One-sided: it only ever says "certainly not", so it can save work and
      // cannot change an answer. A datum marking a position the query's extent excludes cannot be
      // co-satisfiable with it — the meet intersects the extents and then requires every mark to sit on
      // surviving material — and this reaches that verdict without building either.
      const extentExcludes = fn('extentExcludes');
      if (extentExcludes) {
        try { if (extentExcludes(dIR, ref)) return false; } catch (e) { /* unknown → ask properly */ }
      }
      try { return !!P2.compatible2(dIR, ref); } catch (e) { return true; }
    }

    // The per-world mark axis: does this measurement's description entail the concrete world of this tile?
    // Used by the strict branch AND by the has-data dots, so a dot promises exactly what selecting the tile
    // delivers. Same fail-open rule.
    function entailsWorld(rows, arrStr) {
      const P2 = engine();
      const tax = measurementTaxon(rows);
      const accs = datumAccessions(rows);
      const dIR = materializedFor(datumIR(measurementNotation(rows), tax, accs), tax,
                                  datumMemoKey(measurementNotation(rows), tax, accs));
      const ref = arrStr ? worldFor(arrStr) : null;   // already in columns — interpret3 built it
      if (!P2 || !dIR || !ref || typeof P2.entails2 !== 'function') return true;
      try { return !!P2.entails2(dIR, ref); } catch (e) { return true; }
    }

    function measurementNotation(rows) {
      const r = rows && rows[0];
      if (!r) return null;
      const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
      return meta.notation || null;
    }

    // The organism the measurement was made in — the context its descriptor must be read under, since a
    // mnemonic handle alone does not fix a numbering (see `datumIR`). `taxon_id` rides on the measurement
    // row itself; `uniprot_id` is the fallback for a row that names its material directly.
    function measurementTaxon(rows) {
      const r = rows && rows[0];
      if (!r) return null;
      if (r.taxon_id != null) return Number(r.taxon_id);
      const P2 = engine();
      const reg = P2 && P2.DEFAULT_REGISTRY;
      return (r.uniprot_id && reg && reg.taxonOfAccession) ? reg.taxonOfAccession(r.uniprot_id) : null;
    }

    return {
      GLYPH_U,
      resetWorlds,
      tileWorld, tileGlyphIndex, tileUpSet,
      datumGlyphMask, datumUpSet, glyphRelevantRows,
      narrowByAccession, datumAccessions, datumIR,
      referenceParticle, queryColumnSpec, columnAxisAccepts,
      contextTaxon, datumMemoKey, materializedFor,
      markAxisAccepts, entailsWorld,
      measurementNotation, measurementTaxon,
    };
  }

  const api = { createRelevance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// After shell-model.js, whose `meetBench` it displays, and after notation-canon.js, whose
// `buildQueryIR`/`canonNotation` it calls. It binds two listeners at load, so it also has to be
// after the elements — which every module here is; this block sits at the foot of the body.
// docs/_includes/js/diagnostics.js
// The diagnostics drawer: the live IR inspector and the meet bench. Extracted from shell.js on
// 2026-08-15 (U5 of specs/2026-08-13-shell-seams.md).
//
// A PANEL, not a model, and the seam map calls this the file's one example of the boundary already
// working as designed: the reasoning is in `shell-model.js` (`meetBench`), and what lives here is
// the markup that displays it. Nothing was pulled apart to make this cut — it was already apart.
//
// THE HOST GIVES GETTERS AND NOTHING ELSE, WHICH IS THE POINT. `meet-bench.test.js` has always
// asserted that the bench cannot disturb the main render — it reads `currentIR` and `currentRaw` and
// writes only `#meet-out`, so that a lookup can never change because someone typed in the debugger.
// In shell.js that was a regex over the function body, and a regex is what you use when the language
// will not help you. Here the state arrives as `currentIR()` and `currentRaw()`; there is no binding
// to assign, so the guarantee is structural and the census is a backstop rather than the whole of it.
//
// The one thing it does write is the query input, and that is deliberate: `swapMeetQueries` drives
// the MAIN input so the whole page follows, which is the point of swapping rather than re-labelling
// the two sides. It arrives as `queryInput()`, named for what it is.
//
// It reaches `buildQueryIR` and `canonNotation` (notation-canon.js), `meetBench` (shell-model.js) and
// `escapeHtml` (engine-notices.js) by bare name. That is allowed and is NOT the trap docs/CLAUDE.md
// describes: each of those is exported onto `globalThis` by its own module, and a global-object
// property resolves as a bare identifier. What may never be reached that way is a name shell.js
// DECLARES — those are lexical to the page's one module scope and absent from `globalThis`.
//
// A comment came off shell.js with this block and was DELETED rather than moved: eight lines above
// `renderCanonicalIR` describing what the copy button hands over (the `·` kept, the subscripts
// spelled as ordinary digits). It documents `styleForCopy`, which moved to notation-style.js on
// 2026-08-06 and carries the same reasoning at its own definition. It had been sitting above an
// unrelated function ever since.
(function (root) {
  'use strict';

  let _h = {};
  function configureDiagnostics(host) { _h = host || {}; }
  const currentIR   = () => (_h.currentIR ? _h.currentIR() : null);
  const currentRaw  = () => (_h.currentRaw ? _h.currentRaw() : '');
  const queryInput  = () => (_h.queryInput ? _h.queryInput() : null);

  function renderCanonicalIR(raw) {
    const box = document.getElementById('debug-tree');
    const out = document.getElementById('debug-json');
    if (!box || !out) return;
    try {
      const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
      if (!raw || !raw.trim() || !P2 || typeof P2.resolve2 !== 'function') { box.hidden = true; return; }
      // The V2 IR — the one the whole engine actually reasons over. This panel used to show
      // nucleosomeParser.resolve(), the LEGACY v1 IR, whose co-brackets are a flat `pinned` field; the
      // v2 IR represents them structurally, as nested `dna: null` sub-assemblies. Showing v1 here meant
      // the inspector described a representation nothing downstream uses any more.
      // WITH the context and the registry. Called bare, resolve2 has nothing to classify against, so
      // an entity handle came back unresolved — `H2B1A` displayed as { family: null, accession:
      // ["H2B1A"] }, a raw handle sitting where a canonical accession belongs. The panel is supposed
      // to show what the engine reasons over, and that was a shape the engine never sees.
      // The SHARED object — not a fifth parse. If the inspector built its own it could agree with
      // itself and disagree with every pane, which is exactly the state this refactor ends.
      const ir = currentIR();
      if (!ir) { box.hidden = true; return; }
      // Validity in v2 is the meet's own fixpoint: valid2(A) === (meet2(A,A) !== ⊥). There is no second
      // hand-written validity walk to drift from it (validate2 was removed in Phase 0).
      const ok = (typeof P2.valid2 === 'function') ? P2.valid2(ir) : null;
      const verdict = ok === false ? 'invalid — meet2(A,A) = ⊥' : ok === true ? 'valid' : 'validity unknown';
      // Input and Canon above the tree. Input is what was typed — the panel is a diagnostic and it has
      // no business making the reader trust that it is describing their query (it once was not). Canon
      // is `emit2(canon2(ir))`: the notation the engine would write for the same idea, so a normalising
      // step is visible as a difference between two strings rather than something you must read a tree
      // to notice. emit2 REFUSES rather than approximates, so a refusal is reported as one.
      const canonLine = canonNotation(ir);        // elided since 2026-08-07 — see canonNotation
      out.textContent = '// Input: ' + raw.trim() + '\n'
                      + '// Canon: ' + canonLine + '\n'
                      + '// ' + verdict + '\n' + JSON.stringify(ir, null, 2);
      box.hidden = false;
    } catch (e) {
      out.textContent = 'resolve error: ' + (e && e.message ? e.message : String(e));
      box.hidden = false;
    }
  }

  // ── the meet bench ───────────────────────────────────────────────────────────────────────────────
  // A debugging surface below the query bar: `meet(query, other)` as canon, plus the relevance
  // verdicts. It is deliberately INERT with respect to the render loop — it reads `currentIR` and
  // writes only into `#meet-out`. Nothing here touches `lastKey`, the panes, or the lens.
  //
  // It re-runs on its own input AND whenever the main query re-renders, because half of what it
  // compares lives up there; a bench showing a verdict about a query you have since edited is worse
  // than one showing nothing.
  function renderMeetBench() {
    const sec = document.getElementById('cmp-sec');
    const box = document.getElementById('meet-out');
    const input = document.getElementById('meet-input');
    if (!box || !input) return;

    // COMPARE NEEDS SOMETHING TO COMPARE AGAINST, so the section is present exactly when there is a
    // query (BB, 2026-07-29). It used to be permanently visible and answer "Nothing to compare
    // against — the query bar is empty", which is a control explaining why it cannot work: it offers
    // an input, accepts what you type into it, and then declines. Absent is a better answer than
    // present-and-inert, and it retires that route entirely.
    //
    // The test is `currentIR`, not the raw text, so a half-typed or unparseable query hides it too —
    // there is no left-hand side to meet with, which is the same condition the old branch reported.
    const left = currentIR();
    if (sec) sec.hidden = !left;
    if (!left) { box.hidden = true; box.innerHTML = ''; return; }

    const other = input.value.trim();
    if (!other) { box.hidden = true; box.innerHTML = ''; return; }

    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    const right = buildQueryIR(other);
    // A verdict is a SENTENCE with the lattice glyph annotating it: legible without knowing ⊑, and
    // still exact for whoever reads the algebra. `label` may contain markup (the two notations are
    // bolded); `value` never does.
    // VALUE FIRST, then the sentence. The grid is `auto 1fr`, so the answers form one narrow column
    // on the left that the eye can run straight down, instead of sitting at the ragged ends of three
    // sentences of different lengths. Order here IS the visual order — the grid places children in
    // source order — so this cannot be changed from the stylesheet alone.
    const row = (label, value, cls, glyph) =>
      `<span class="mb-v ${cls || ''}">${escapeHtml(String(value))}` +
      `${glyph ? `<span class="mb-glyph">${glyph}</span>` : ''}</span>` +
      `<span class="mb-k">${label}</span>`;
    const plain = (msg, cls) => `<span class="mb-v ${cls || ''}"></span><span class="mb-k">${msg}</span>`;

    // (The `!left` route is gone: the whole section is hidden when there is no query, so this
    // function is never reached without one.)
    if (!right) { box.hidden = false; box.innerHTML = plain('That did not parse', 'mb-na'); return; }

    const r = meetBench(left, right, P2, canonNotation);
    box.hidden = false;
    if (r.error) { box.innerHTML = plain(escapeHtml(r.error), 'mb-na'); return; }

    const yn  = (v) => v == null ? 'not known' : v ? 'yes' : 'no';
    const cls = (v) => v == null ? 'mb-na' : v ? 'mb-yes' : 'mb-no';
    const A = `<b>${escapeHtml(currentRaw() || 'this query')}</b>`;
    const B = `<b>${escapeHtml(other)}</b>`;

    // The relations are NAMED — `entails`, `compatible` — with the plain reading kept as a gloss and
    // the lattice glyph as the annotation. Paraphrasing them away ("is covered by") made the panel
    // readable and stopped it teaching the two words a reader needs in order to read anything else
    // this project writes, including the Match control right above.
    // Three verdicts and the meet. The GLOSS that used to sit under them ("entails = everything the
    // first denotes…") is gone for good: a panel that re-explains its own vocabulary on every render
    // is teaching on every read rather than once, the words are the project's own, they appear on the
    // Match control directly above, and the glyph column (⊑ / ⊒ / ∧) annotates them for whoever wants
    // it exact.
    const verdicts =
        row(`${A} <b class="mb-rel">entails</b> ${B}`, yn(r.entailsAB), cls(r.entailsAB), '⊑')
      + row(`${B} <b class="mb-rel">entails</b> ${A}`, yn(r.entailsBA), cls(r.entailsBA), '⊒')
      + row(`${A} and ${B} are <b class="mb-rel">compatible</b>`,
            yn(r.compatible) + (r.compatAsymmetric ? ' (asymmetric)' : ''),
            r.compatible ? 'mb-yes' : 'mb-bot', r.compatible ? '∧ ≠ ⊥' : '∧ = ⊥');

    // ⊥ is an ANSWER, not the absence of one, and it deserves the same place a notation would take.
    //
    // "Highest floor satisfying both" (BB, 2026-07-29) — the meet is the GREATEST LOWER BOUND, and
    // that is what the label now says in words. "Together they mean" read as a summary of the two
    // queries and is wrong in the direction that matters: the meet is not their union of meanings, it
    // is the most general description that is at least as specific as each of them. A reader who took
    // the old label at face value would expect it to grow as the queries grow, when in fact it
    // narrows — and hits ⊥ when they cannot both be satisfied at all, which is exactly the case the
    // ⊥ branch reports.
    const MEET_LABEL = 'Highest floor satisfying both';
    const meetRow = r.bottom
      ? `<span class="mb-meetrow"><span>${MEET_LABEL}</span>` +
        `<span class="val mb-bot">nothing — they conflict</span></span>`
      : r.results.map((t, i) =>
          `<span class="mb-meetrow"><span>${MEET_LABEL}` +
          `${r.results.length > 1 ? ` (${i + 1} of ${r.results.length})` : ''}</span>` +
          `<span class="val">${escapeHtml(t)}</span></span>`).join('');

    box.innerHTML = verdicts + meetRow;
  }

  // Swap: the bench's notation becomes the query and vice versa. Entailment is asymmetric, so this is
  // the fastest way to see which direction holds — and it drives the MAIN input, so the whole page
  // follows, which is the point of swapping rather than just re-labelling the two sides.
  function swapMeetQueries() {
    const input = document.getElementById('meet-input');
    const q = queryInput();
    if (!input || !q) return;
    const other = input.value;
    input.value = currentRaw() || q.value || '';
    q.value = other;
    if (window.runQuery) window.runQuery();   // re-renders the page, which re-runs the bench
    renderMeetBench();
  }

  // BINDING AT LOAD IS FINE HERE AND IT WAS NOT FREE. In shell.js these two ran unguarded, because
  // shell.js is only ever executed with a DOM under it. This module is `require`d by node suites, so
  // an unguarded `document` at module scope is a ReferenceError at import — the module would be
  // untestable for the same reason it is now extractable. The guard is on `document` itself, not on
  // the elements: `getElementById` already returns null for an absent one, and the click listener is
  // delegated, so neither needs the page to be finished.
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('#meet-swap')) swapMeetQueries();
    });

    // ONE PANEL IDIOM (Task 9, 2026-09-23): routes through `openSheet('diagnostics', { toggle:
    // true })`, which closes on a second press, as this always did, and closes any other open
    // sheet — opening Diagnostics now dismisses the licence card the same way it dismisses
    // itself. `#qdiag` is a `<button>` with no `<a href>` to degrade to, so the `typeof openSheet`
    // guard below keeps a working fallback rather than leaving the button permanently inert if
    // sheet.js is ever missing — the same shape as `bindLicenceCard`'s fallback in shell.js.
    (function bindDiagnostics() {
      const btn = document.getElementById('qdiag'), panel = document.getElementById('diageditor');
      if (!btn || !panel) return;
      btn.addEventListener('click', () => {
        if (typeof openSheet === 'function') {
          openSheet('diagnostics', { toggle: true });
        } else {
          panel.hidden = !panel.hidden;
          if (document.body) document.body.classList.toggle('sheet-open', !panel.hidden);
        }
        if (!panel.hidden) { const i = document.getElementById('meet-input'); if (i) i.focus(); }
      });
    })();

    // The bench's own input: debounced like the main one, and independent of it.
    (function bindMeetBench() {
      const el = document.getElementById('meet-input');
      if (!el) return;
      let t = null;
      el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderMeetBench, 150); });
    })();
  }

  const api = { configureDiagnostics, renderCanonicalIR, renderMeetBench, swapMeetQueries };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);

// The page's one state writer — shell.js calls setPageState, so this must load before it.
// docs/_includes/js/page-state.js — THE PAGE HAS ONE STATE, AND THIS IS ITS ONLY WRITER.
//
// specs/2026-09-23-page-rebuild-query-answer.md §4. `body[data-state]` says what the page is doing:
//
//   empty    the field is blank — title, field, examples, the compose disclosure
//   answer   a query has been read — the switch, the caption, the particle, the panels
//   refused  the query did not parse — the switch, the field, the error surface
//
// CSS reads it. Nothing else writes it. A write that means "we are not answering yet" belongs here;
// a write that means "this panel found no rows" is a fact about CONTENT and stays where it is, local
// and imperative. Collapsing those two is how a panel starts hiding for the wrong reason.
'use strict';

const PAGE_STATES = ['empty', 'answer', 'refused'];

// Deliberately `const`, not `function` statements: a top-level `function` declaration hoists onto
// the global object on its own (both in Node's vm context and in a real classic script), which
// would make the `Object.assign` below look load-bearing while a deleted export line kept working
// anyway. `const` lives only in the shared lexical scope `app.js`'s concatenation creates, so
// `shell.js` still resolves these by name exactly as before, but the export is now the ONLY path
// to globalThis — which is what makes removing it a loud, test-catchable break instead of a silent
// no-op. Do not "tidy" this back to a function statement.
const setPageState = (state) => {
  if (!PAGE_STATES.includes(state)) {
    throw new Error(`setPageState: unknown state ${JSON.stringify(state)} — expected one of ` +
                    PAGE_STATES.join(', '));
  }
  if (document.body) document.body.dataset.state = state;
};

const pageState = () => (document.body && document.body.dataset.state) || 'empty';

// Through the host object, never by name: app.js concatenates every module into one classic script,
// where a top-level `const`/`function` lives in the global lexical scope and is NOT a property of
// globalThis. A consumer reaching for a declared name works in every node suite and fails on the
// page. (docs/CLAUDE.md)
Object.assign(globalThis, { setPageState, pageState, PAGE_STATES });

// WHICH SECTIONS OPEN ON A QUERY'S FIRST RENDER. `section-state.js` exports one function,
// `firstRenderOf` (plus `resetSectionState`, called only from tests) — `sectionOpen` and
// `materialOpen` were collapsed into it on 2026-09-24 and no longer exist. Same class of defect as
// the sheet.js note above and not a real ordering constraint for the same reason: `syncSection` and
// the material-card renderer read `typeof firstRenderOf === 'function'` from inside `render()`,
// which only ever runs after every include here has finished, so this block's position relative to
// shell.js cannot matter.
// docs/_includes/js/section-state.js
// HAS THIS QUERY DRAWN THIS THING BEFORE? That is the whole module.
//
// [BB 2026-09-23, specs/2026-09-23-one-layout-narrow-first.md] "default first render, user's
// choice after". The page derives a sensible opening state from the data; from then on the reader
// owns it. BB 2026-09-24: "survival is per query" — so the memo, and the state it seeds, are both
// cleared when the query key changes.
//
// ── WHY THIS IS ONE FUNCTION AND NOT THREE ──────────────────────────────────────────────────────
// It was `sectionOpen`, `materialOpen` and `firstRenderOf`, and the first two had OPPOSITE
// latching rules that each needed a paragraph to justify. That asymmetry was not a subtlety about
// defaults; it was a symptom. Sections recorded the reader's choice in `collapsedSubs` (what they
// SHUT) and materials in `openCards` (what they OPENED) — two stores with opposite meanings for
// one question — so a derived default had to behave differently depending on which one it was
// arguing with.
//
// With ONE store (`collapsedSubs`, in shell.js) a default stops being a value to return and
// reconcile. It is an act performed once: on the first render of a query, SEED the store with
// whatever should start closed. The reader's own toggle then writes to that same set, so there is
// no precedence to state and nothing to latch. All three callers now read:
//
//     if (firstRenderOf(id, key) && <should start closed>) collapsedSubs.add(id);
//
// PURE, DOM-FREE, NODE-REQUIRABLE, the same convention as the other *-model.js modules
// (docs/CLAUDE.md's testability boundary): shell.js is async, DOM-bound and DuckDB-bound, and no
// suite can load it, so the one rule worth testing lives out here.
(function (root) {
  'use strict';

  // Keyed `<queryKey> <id>`. The query key is what makes a NEW query seed afresh while a re-render
  // of the SAME one does not — which is the half that matters, because any number of things
  // re-render a standing answer (the Match toggle, a facet click, a context change) and every one
  // of them would otherwise re-close a section the reader had just opened.
  var seen = new Set();

  function resetSectionState() { seen.clear(); }

  // True exactly once per (queryKey, id); false forever after.
  //
  // It MUTATES ON READ, deliberately. A caller asking "is this the first render?" is always about
  // to act on the answer, and splitting the question from the record would give two call sites
  // that can disagree about whether the thing has now been seen. The one caller that asks without
  // wanting to act — the lone-card fallback, which claims an id precisely so that the card does
  // NOT seed itself closed — is written to look like what it is.
  function firstRenderOf(id, queryKey) {
    var k = String(queryKey) + ' ' + id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }

  var api = { firstRenderOf: firstRenderOf, resetSectionState: resetSectionState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.firstRenderOf = firstRenderOf;
    root.resetSectionState = resetSectionState;
  }
})(typeof self !== 'undefined' ? self : this);

// A top-level `function` declaration, hoisted across this one classic script, so its position
// relative to shell.js (its one caller here, in bindLicenceCard) does not matter — kept beside it
// for a reader's sake, same as sheet.js/diagnostics.js above.
// ── THE FEEDBACK MAILTO, ASSEMBLED BY SCRIPT [BB 2026-09-24] ────────────────────────────────────
// Parity with the homepage (benjbuch.github.io's _includes/social-links.html): an `email_user` /
// `email_host` split in `_config.yml`, a `<noscript>` fallback a crawler and a no-JS reader both
// get (`user ○ host`), and a script that joins the two into a `mailto:` link. Splitting the address
// defeats the naive harvester that scrapes a bare `mailto:` href straight off the page without
// defeating a normalizing one that reassembles `user` + `host` — an accepted cost, stated to BB and
// confirmed. The `bbuchmuller` alias stays, BB's explicit choice, over spelling out a full name.
//
// ONE FUNCTION, TWO CALL SITES, and the reason is where the second one runs. `/licence/` renders
// the placeholder inline and a `<script>` on that page can assemble it directly. The About drawer
// (`bindLicenceCard` in shell.js) FETCHES `/licence/` and injects the response with
// `replaceChildren`/`appendChild` — and a `<script>` parsed out of that response and moved into a
// live document NEVER executes, the same rule that keeps a `<script>` assigned through `innerHTML`
// inert. So the drawer cannot just carry a copy of the inline script inside the fetched body; it
// has to call this SAME function itself, once the content has actually landed — which is why the
// assembly is a function the caller invokes, not a bare script the browser runs on parse.
//
// `root` scopes the search: the drawer passes the subtree it just injected, so it does not re-walk
// the whole live document a second time on top of whatever the standalone page already resolved.
function assembleFeedbackContact(root) {
  (root || document).querySelectorAll('[data-email-user]').forEach((el) => {
    const user = el.dataset.emailUser, host = el.dataset.emailHost;
    if (!user || !host) return;                    // no config — leave the <noscript> fallback in place
    const a = document.createElement('a');
    a.href = 'mailto:' + user + '@' + host;
    a.textContent = user + '@' + host;
    el.replaceChildren(a);
  });
}

// docs/_includes/js/shell.js
// DOM orchestration for the worlds-first shell: query bar → empty/syntax/valid
// routing, cheap-tier syntax feedback, and region render hooks. Replaces
// main.js. Runs inside the shared <script type="module"> scope (docs/index.html),
// so it can see `db`, `lastKey`, `initDuckDB`, `tryParse`, `describe`,
// `materialsFromCanon`, `syntaxError`, etc. declared by sibling includes.

// isoStrict()/mode toggle: Task 2 removed #strict-toggle/#mode-row from the DOM.
// slots.js/query-engine.js still call isStrict(), so default it to true.
function isStrict() { return true; }

// ── Interaction ───────────────────────────────────────────────────────────

const inputEl      = document.getElementById('notation-input');

// `onboardingEl`, `atlasEl` and `menuEls` WERE HERE and are gone [2026-09-23 review]. They were six
// direct `.hidden` writes that decided what the page shows before a query; Task 7 moved that
// decision to `body[data-state]` and `docs/_sass/_state.scss`, and nothing read the three lookups
// afterwards. They were kept anyway, under a comment saying other functions still used them — which
// no longer described anything, and would have been the premise the next reader preserved them on.
// Seven `getElementById` calls at load, for nothing.
//
// The ids they named are still the rule's subject, in ONE place: `.favorites`, `.onboarding-hint`
// and `.menu-fold` (which contains `#atlas`, `#protein-sec` and the marks column, `.make-col-marks`
// — `#toppings-sec` was dropped from that element [2026-09-26 review, finding 4]: nothing read it) in
// `_state.scss`.
// `variant-atlas.test.js` watches both directions — a `.hidden` write naming any of them creeping
// back into this file, and the CSS rule being narrowed so it stops reaching them.
function showOnboarding(on) {
  // CAPTURED BEFORE THE WRITE BELOW [BB 2026-09-26 review]. `setPageState` is about to set the
  // state to 'empty' whenever `on` is true, so reading `pageState()` AFTER that call can never see
  // anything but 'empty' — the very check meant to detect a transition INTO empty would find the
  // destination already reached and fire every time. `wasEmpty` is the state the page was in before
  // this call touches it.
  const wasEmpty = pageState() === 'empty';
  // WHAT EXISTS is `body[data-state]` now (docs/_sass/_state.scss) — setPageState is the only write
  // here that decides visibility. It replaced six direct `.hidden` writes; their lookups are gone
  // too (see the note above this function).
  setPageState(on ? 'empty' : 'answer');
  // GOING EMPTY CLOSES ANY OPEN SHEET, BUT ONLY ON A REAL TRANSITION [BB 2026-09-26 review,
  // corrects the 2026-09-23 version of this comment]. `setEmpty()` runs on every render while the
  // field is empty, not only when it first goes empty — so `onQueryContextChanged` → `rerender()`
  // after picking a species in the Read-as sheet re-enters here with `on` already true, and the old
  // unconditional close swallowed the panel the reader had just used, along with the "Read as
  // applied" confirmation `applyContext()` writes right before its own re-render. `wasEmpty` makes
  // this fire only for empty→non-empty→empty, i.e. the reader actually putting the page down; an
  // empty→empty re-render is not a transition and must leave an open sheet alone (`sheet.js`'s
  // `opts.toggle` note: picking a species and reopening the panel must land on an open panel).
  // Belongs HERE, not in `setPageState`: `page-state.test.js` asserts `setPageState` writes nothing
  // but `body.dataset.state`, and that assertion is load-bearing.
  if (on && !wasEmpty && typeof closeSheet === 'function') closeSheet();
  // STICKY IS SCOPED TO THE MENU [BB 2026-08-25]. The page is tall while the menu is open, so the
  // bar would otherwise scroll away from the dial feeding it; over an answer the existing
  // hide-on-scroll behaviour takes back over, untouched.
  // `document.body` is guarded because the render suites drive this file against a STUB DOM that
  // has none. It went unnoticed while `showOnboarding` was only ever reached through `onInput`,
  // which those suites do not call; declaring the menu state at boot reaches it at import.
  if (document.body) document.body.classList.toggle('menu-open', !!on);
  // …and the example strip reads that class to decide whether to tuck, so it is re-synced HERE
  // rather than by the callers. Doing it the other way round is a race with a wrong answer: every
  // run path calls syncChips BEFORE onInput, which is what eventually lands here, so the strip
  // would be deciding against the previous query's state.
  if (window.syncChips) window.syncChips();
}
// THE STICKY QUERY BAR PINS BELOW THE HEADER, and the header's height is not a number the
// stylesheet can know: it is the topbar's own padding plus the site title's line box, and it CHANGES
// when that bar wraps on a narrow window. `--header-height` in _base.scss says 52px while the bar
// renders at 46 — a 6px strip of the page would slide through the gap.
//
// So it is measured and published, with _shell.scss carrying a static fallback so the page still
// holds together without this. The observer is what makes it survive a resize; without it the
// offset is right only at the width the page happened to load at.
// GUARDED DOWN TO `setProperty` ITSELF, and not out of caution: the render suites drive this file
// against a stub DOM whose documentElement has no style object, so an unguarded call throws AT LOAD
// and takes the whole module scope with it — which is the one failure `page-consumers` names first.
(function publishHeaderHeight() {
  const bar = document.querySelector('.topbar');
  const root = document.documentElement;
  if (!bar || !root || !root.style || typeof root.style.setProperty !== 'function') return;
  // FRACTIONAL, AND ROUNDED DOWN. `offsetHeight` is an INTEGER and the bar does not render at one:
  // measured, it is 45.75px, which offsetHeight reports as 46 — so the query bar pinned at 46 sat a
  // quarter-pixel BELOW the header and the page slid through the slot. The same drift this block was
  // written to remove, an order of magnitude smaller and therefore harder to see than the 52-vs-46
  // it caught first.
  //
  // FLOOR RATHER THAN ROUND, because the two errors are not equal. Too small and the bar tucks under
  // a header that paints over it (z-index 40 over 39) and nothing shows; too large and there is a
  // gap, which is the bug. A sub-pixel overlap costs a sliver of the bar's own 15px top padding.
  //
  // GUARDED THE SAME WAY `setProperty` IS, and for the same reason: the render suites drive this
  // file against a Proxy stub that answers every unknown property with `undefined`, so calling
  // `getBoundingClientRect()` unguarded throws AT LOAD and takes the whole module scope with it —
  // the failure `page-consumers` names first, three lines above.
  const put = () => {
    const r = typeof bar.getBoundingClientRect === 'function' ? bar.getBoundingClientRect() : null;
    const h = (r && r.height) || bar.offsetHeight || 46;
    root.style.setProperty('--topbar-h', Math.floor(h) + 'px');
  };
  put();
  if (typeof ResizeObserver === 'function') new ResizeObserver(put).observe(bar);
})();

const qfieldEl      = document.querySelector('.qfield');

// ── Test affordances (visual-diff harness; inert without URL params) ─────────
// `?theme=` stamps data-theme on :root (the CSS currently themes via
// prefers-color-scheme, so this is a forward-looking hook; the screenshot
// harness drives the actual theme via emulated media). `?q=` pre-fills the
// query at boot (see the boot block below). markReady() flips window.__ready so
// the harness knows a render has settled. None of this alters default,
// no-param behavior.
const _harnessParams = new URLSearchParams(location.search);
(function stampThemeParam() {
  const t = _harnessParams.get('theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
})();
function markReady() { window.__ready = true; }

// Tile selection (arrangements panel) → materials world-split (Task 4).
// selectedWorld: the world IR for the selected tile (interpret3's worlds[i], flip applied)
// tile, or null when no tile is selected (family-level default view).
// currentRender: the parsed/info/key of the most recent rendered query, so
// the #facets click handler can re-invoke renderMaterials() without redoing
// the parse.
let selectedWorld = null;
// The selected tile's arrangement string (data-arr), persisted so the selection
// survives a re-render that rebuilds the tiles (a port/context switch). Reset
// only on a genuine query-text change; re-applied in renderArrangements.
let selectedArr = null;
// Whether the user has interacted with the arrangement tiles for THIS query
// (selected or deselected one). Reset on a genuine new query. Guards the default
// selection: a fresh query auto-selects the first world, but once the user has
// touched the tiles — including a deliberate deselect to the family-level view —
// same-query re-renders (port/context apply) must not re-impose the default.
let arrTouched = false;
// Index into unitList(parsed) of the unit currently focused in the units bar.
// Reset to 0 alongside selectedWorld/selectedArr on a genuine new query (so a
// same-query re-lens — port/context switch — keeps the user's unit focus, same
// treatment as the tile selection above). Clamped defensively in renderUnitBar
// whenever a re-render produces fewer units than the persisted index.
let selectedUnit = 0;
// Per-unit arrangement memory (array members): unitIndex → { arr, touched }.
// selectedArr/selectedWorld/arrTouched above are the CURRENTLY-focused unit's
// live values; this map preserves each other member's chosen arrangement so
// switching between array members doesn't reset them to the default C2. Absent =
// never touched → re-default. Cleared on a genuinely new query.
let unitArr = new Map();
// The canonical query text of the last actual render. Distinguishes a genuine
// new query (reset selection/pins) from a same-query re-lens (port/context
// switch, which nulls lastKey to force a re-render but keeps the canonical).
let lastQueryKey = null;
let currentRender = { parsed: null, key: null };
// The RAW query text of the current render. The v2 stack must be fed THIS, never describe().canonical:
// the v1 serializer flattens co-brackets — `[H2A@H2B]0@[H2A@H2B]1` round-trips as
// `[H2A]0@[H2B]0@[H2A]@[H2B]` — which silently drops the statement that those two histones form one
// dimer. Enumerating the flattened form admits worlds with H2A on one face and H2B on the other (two
// free-floating monomers, not a dimer), because co-location lives in the GROUPING and meet2's pairing
// rule is a count invariant that 1-and-1 satisfies either way.
let currentRaw = '';
// The whole-query parse tree behind the units bar. currentRender.parsed is
// re-pointed at the FOCUSED subtree by renderFocusedPanes, so the delegated
// #facets handler reads this to rebuild the correct unit list for the cartoon.
let topParsed = null;

// Monotonic generation token for renderMaterials()/buildMaterialCard() (Task 4
// review fix). `key !== lastKey` only guards against QUERY changes; tile clicks
// re-invoke renderMaterials() with the *same* key, so two overlapping clicks can
// race their async continuations against each other and interleave DOM writes.
// Bumping `materialsToken` on every renderMaterials() call and checking it after
// each await lets a newer render (from a later click OR a new query) abort all
// older in-flight continuations before they touch the DOM.
let materialsToken = 0;

// Which material cards are expanded, keyed by family|variant. renderMaterials
// rebuilds every card from scratch, so without this the .su.open foldout state
// is lost on every re-render (a port switch, a tile click). Persist it here and
// restore it in buildMaterialCard so open cards stay open across re-renders.
// (`openCards` is GONE [BB 2026-09-24]. It held what the reader had OPENED while `collapsedSubs`
// held what they had SHUT — two stores with opposite meanings for one question, which is why the
// CSS had `.su.open .su-body { display: block }` against `.secthd.collapsed + .sectbody { display:
// none }`, and why `section-state.js` needed two memos with opposite latching. A material card is
// a `.sect` now and uses the one store, keyed `mat|<cardKey>`.)

// DOES THE QUERY MARK THIS MATERIAL? One predicate, because the rule [BB 2026-09-23: "Collapsed if
// they are not modified"] is asked in TWO places — by each card as it is built, and by the
// lone-card fallback before any card exists — and the first render is what seeds the default, so
// whichever asks FIRST decides. Two spellings of "marked" would therefore not merely disagree; the
// earlier one would win and the later one would be dead code that looks live.
//
// A NEGATED mark does not count. `H3:!K27me3` asserts an absence, and opening a card to show what
// is not there inverts the rule's whole purpose — the marks are what the reader came to look at.
//
// TWO SPELLINGS OF THE SUBSTITUTION, AND IT HAS TO KNOW BOTH. `worldView`'s mods call it
// `substitution`; `toParseMod` renames it to `variant` on the way into the card. So the same mark
// reads one way to this function's first caller and the other way to its second. Checking only
// `variant` is not a half-measure — it answers "unmarked" for every world-path material in
// silence, which made the fallback fire alongside the rule and open an unmarked card beside the
// marked one. (docs/CLAUDE.md's terminology row names this pair: a modification's swapped residue
// is `substitution` in the data layer, from the parse-tree field `mod.variant`.)
// THE CURRENT QUERY'S KEY, READ SAFELY. `lastKey` is declared in index.html's own script block and
// NOT in this file (docs/CLAUDE.md: "a name shell.js declares is not a global" — this is the mirror
// case, a name shell.js does NOT declare and reads anyway). A bare reference resolves on the page
// and throws wherever shell.js is evaluated without the page around it, which is how
// `measurement-render` and `datum-specificity` run it in a vm.
//
// Every caller here is a per-query MEMO key, so `null` is a safe answer: an un-keyed render shares
// one entry and applies its default once, which is what it wants anyway.
function queryKeyOrNull() {
  return (typeof lastKey !== 'undefined') ? lastKey : null;
}

function materialIsMarked(mods) {
  return (mods || []).some((x) => (x.variant || x.substitution || x.modification) && !x.negated);
}

// ONE caret markup, declared once. Every collapsible head — L1 `.secthd` and L2 `.subhd` alike —
// ends with this exact span; four sites used to hand-type the string, which is how the material
// card's head drifted to `class="caret"` (no rotation rule, so its toggle worked and its own
// indicator never turned) while the other three agreed by coincidence. `.sub-caret` is the one
// class carrying the rotation rules (`_shell.scss`, "Disclosure caret").
const CARET_HTML = '<span class="sub-caret" aria-hidden="true"></span>';

// Collapsible in-card sections (Mass, AlphaMissense). Sections are OPEN by default;
// only ids the user has collapsed live here, so the state survives re-renders. The
// caret is the shared disclosure glyph (Font APEX \f0da, from CSS) at the RIGHT edge: open → collapsed.
const collapsedSubs = new Set();
function collapsibleSubhd(id, label) {
  const c = collapsedSubs.has(id) ? ' collapsed' : '';
  return `<div class="subhd sub-toggle${c}" data-sub="${id}">${label}${CARET_HTML}</div>`;
}

// SEEDS `id` INTO `collapsedSubs` ON THE QUERY'S FIRST RENDER, UNLESS THE QUERY MARKS THIS CARD —
// "collapsed if not modified" [BB 2026-09-23]. Pulled out of `buildMaterialCard`'s body into its own
// name [2026-09-26 review, finding 2] so it can be called directly: `buildMaterialCard` awaits
// `resolveContext` (a DuckDB round-trip) before it reaches this line, so no node harness can drive
// this rule by calling the card builder — `page-consumers.test.js` stubs the whole function out, and
// the seeding assertions that used to sit against that stub were vacuously true (the reviewer
// inverted the rule below and the suite stayed green). The assertions now call THIS function
// directly, which is the exact code `buildMaterialCard` runs, not a copy of it.
function seedMaterialCollapse(id, marked) {
  if (typeof firstRenderOf === 'function' && firstRenderOf(id, queryKeyOrNull()) && !marked) {
    collapsedSubs.add(id);
  }
}
// One delegated toggle for every collapsible head — card sections (.subhd.sub-toggle)
// AND right-panel heads (.phd.sub-toggle). Clicks on interactive controls inside a head
// (e.g. the Measurements "match" button) don't collapse it.
document.addEventListener('click', (e) => {
  if (e.target.closest('button, a, input, textarea, select')) return;
  const h = e.target.closest('.sub-toggle');
  if (!h || h.classList.contains('is-empty')) return;   // empty panel header doesn't open
  const id = h.dataset.sub;
  if (collapsedSubs.has(id)) collapsedSubs.delete(id); else collapsedSubs.add(id);
  h.classList.toggle('collapsed');
});

// Realization resolution (specs/2026-07-14-realization-fluid-family-design.md).
// Maps `family|variant` → { uniprot_id, taxon_id } for a realization slot whose
// token pinned a specific material (a UniProt accession / protein name). The
// resolution pass in onInput fills it; buildMaterialCard prefers it as a
// call-level override to resolveContext, so the token's material wins over the
// species lens (precedence #1). Empty for any query without a pinned material —
// non-realization queries never read it, so they flow exactly as today.

// Absence model for the current query (specs/2026-07-16-absence-representation-design.md).
// Derived from the v2 IR (seats + classify2) and consumed by the
// render loop to draw the four kinds of "absence":
//   { absentKeys: Set("family|variant") fully-absent units → ghost cards }
// (Per-tile holes are no longer sourced here: tileEl reads ∅ from each world's
//  own arrangement string — specs/2026-07-16-world-enumeration-design.md.)
// null whenever resolve throws, errors, or the query has no absence — the render
// then flows exactly as it did before this wiring (robustness-first).
let absenceModel = null;

// Build the absence model from the resolved canonical Assembly. Never throws:
// any error / unexpected shape returns null so the caller falls back cleanly.
function computeAbsenceModel(ir) {
  try {
    const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
    if (!P2 || !ir || ir.node === 'error' || ir.node === 'bottom') return null;
    const node = particleOf(ir);          // the engine's unwrap, not a second spelling of it
    if (!node || node.dna == null) return null;          // absence is a statement about a PARTICLE

    // `seats()` already answers this. A particle has all eight seats and `lift2` has consumed the
    // `count: 0` members into exclusions, so an absent family is simply one whose seats went
    // unfilled — the same fact the cartoon ghosts and `classify2` names. Deriving it a second time
    // from a second engine is what this port removes.
    // The atlas is passed even though this reads only OCCUPANCY, which the copy→seat permutation
    // cannot change: one rule ("every seats() call passes the atlas") is worth more than an
    // exception that a later reader has to re-derive is safe.
    const sm = seats(node, P2, beadAtlas);
    const absentKeys = new Set();
    ['H3', 'H4', 'H2A', 'H2B'].forEach((f) => {
      const st1 = sm.seats[f + ':1'], st2 = sm.seats[f + ':2'];
      if (st1 && st2 && !st1.occupied && !st2.occupied) absentKeys.add(f + '|');
    });

    // `composition` lived here too — `classify2` narrowed to hexasome|tetrasome|null. Its one
    // consumer (the arrangements counts line) now calls `classify2` itself, and going through this
    // model cost it every DNA-free class, because absence is a statement about a particle and this
    // function returns null above when `dna == null`. Removed 2026-08-05; absence is absence.
    return { absentKeys };
  } catch (e) {
    return null;
  }
}

// `escapeHtml` moved to engine-notices.js (2026-08-15, U2) and is exported onto globalThis from
// there. It had to: that module loads BEFORE this file and must not depend on it, and a private
// copy would be a second HTML escape on a page that should have exactly one. The ~23 calls left in
// this file resolve to that export.

// `realizationSlots` / `resolveRealizations` / `realizationPins` lived here (removed 2026-07-26).
// They walked the v1-shaped tree for a bare accession or gene handle, asked DuckDB what it was, and
// wrote the answer back onto the slot so the downstream view-models could key on `slot.family`.
// `resolve2` does all of it synchronously, against the same tables frozen into the registry, and the
// view-models now read the IR rather than the slot. `showRealizationError` went with them: an
// unresolvable handle is a resolve2 error, which the validity gate already reports.

// Hide both right-column panels (arrangements + measurements). Used only for the
// no-query and error states, where the whole stage is cleared.
// THE STATIC SECTIONS GO AWAY ONLY WHEN THERE IS NO ANSWER AT ALL. Within an answer a section is
// never absent — it shows its count and collapses (see syncSection below). This is the other
// case: an empty or refused query, where there is nothing for any of them to be about.
//
// 'publications' JOINED THIS LIST [BB 2026-09-24, SUPERSEDES the special case this function used
// to carry]. The literature used to have "no section of its own to hide" — `#furtherbody` was a
// bare host rendering its own `.sect`s, so this function cleared its innerHTML by hand instead of
// hiding it. Now `#sect-publications` is a static section exactly like the other three, so it
// hides the same way they do; `#furtherbody` still gets emptied below it, same as `#measbody` and
// `#arraybody` are not emptied by this pass (they simply sit under a hidden section) — the
// literature keeps the explicit clear because the `refused` state does NOT hide `.answer`
// (docs/CLAUDE.md — the refusal card renders into `#unitbar`, inside it), so leaving stale rows in
// a hidden section would surface again the moment a later query re-opens it without re-rendering.
const SPINE_SECTIONS = ['arrsel', 'arrays', 'nucleosomes', 'publications'];
function hideSpineSections() {
  for (const t of SPINE_SECTIONS) {
    const el = document.getElementById('sect-' + t);
    if (el) el.hidden = true;
  }
  const fb = document.getElementById('furtherbody');
  if (fb) fb.innerHTML = '';
}

// ── A SECTION IS NEVER ABSENT [BB 2026-09-23] ───────────────────────────────────────────────────
// specs/2026-09-23-one-layout-narrow-first.md. This replaced `syncPanelState(panelId, subId,
// empty)`, whose contract was "show the panel, and collapse its header when it is empty". The
// contract is different now, not just the ids: a section SHOWS ITS COUNT. BB ruled it explicitly
// for Arrays, which are rare enough that most queries now carry a collapsed `Arrays 0` — "the
// users who do not know array data exists are the ones who most need to see that the axis does."
//
// So this never hides. It unhides, writes the count, and sets the collapsed class.
//
// WHICH IS OPEN IS SEEDED, NOT DECIDED HERE [BB 2026-09-24]. On the query's first render this adds
// the section to `collapsedSubs` if it should start closed; after that it only READS that set, and
// so does the reader's own toggle. One store, so there is no precedence to state — which is what
// let `section-state.js` shrink from three functions with opposite latching rules to one.
// `noun` NAMES WHAT IS BEING COUNTED [BB 2026-09-24: "NUCLEOSOMES 59 measurements"]. A bare number
// on the L1 head answered only "how many"; the count now carries what it counts, the same move §7
// made on the assay-type heads below it. Optional and singular-aware — `arrsel` counts
// arrangements and is not a place this noun belongs, so it is omitted there and the slot keeps its
// bare number, unchanged.
function syncSection(token, count, noun, hasContent) {
  const sect = document.getElementById('sect-' + token);
  if (!sect) return;
  sect.hidden = false;
  const head = sect.querySelector('.secthd.sub-toggle');
  if (!head) return;
  const slot = head.querySelector('.sect-count');
  if (slot) {
    slot.textContent = noun
      ? `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
      : String(count);
  }
  const subId = 'sect|' + token;
  // A SECTION WITH SOMETHING TO SAY IS NOT EMPTY, WHATEVER ITS ROW COUNT [BB 2026-09-24 ruling on
  // the literature panel]. `count` is still the true row count — the head keeps stating `0` — but
  // `hasContent` (the literature's coverage note, its "No papers under this filter", a load error,
  // the "Finding papers…" progress line) tells this function there is prose inside worth opening
  // for. Without it, all four of those wrote through `count === 0` and got BOTH `is-empty` (which
  // the delegated toggle below refuses to open) and a collapsed seed on first render — so a reader
  // could never reach any of them; the section was seeded shut over a message, not over nothing.
  const empty = count === 0 && !hasContent;
  // THE ARRANGEMENT SELECTOR'S RULE IS ITS OWN: BB — "collapsed by default, otherwise open, so the
  // user sees their choices." One arrangement is not a choice, so it starts closed and the axis is
  // still named. Every other section starts closed when it has nothing in it (and nothing to say).
  const startsClosed = token === 'arrsel' ? !(count > 1) : empty;
  if (typeof firstRenderOf === 'function' && firstRenderOf(subId, queryKeyOrNull()) && startsClosed) {
    collapsedSubs.add(subId);
  }
  // AN EMPTY SECTION IS NOT REACTIVE [BB 2026-09-24: "Arrays 0 present collapsed, but must not be
  // reactive (currently expands)"]. `Arrays 0` stays on screen to name the axis; a head that opens
  // onto nothing turns that into a promise the section cannot keep, and the reader who takes it up
  // learns only that the control is broken. The delegated toggle already bails on `.is-empty` —
  // this is the class it has been looking for, which `syncPanelState` used to set and this did not.
  head.classList.toggle('is-empty', empty);
  head.classList.toggle('collapsed', empty || collapsedSubs.has(subId));
}

// Error surface. The units pane is the query's first abstract level; when the
// query can't form units — a syntax slip, a physically-invalid assembly, or an
// unresolvable realization token — the reason is shown HERE, in place of the
// unit cartoons, and the stage behind it is cleared. `kind` is 'syntax' |
// 'physics' (drives the accent).
function renderUnitError(kind, html) {
  const bar = document.getElementById('unitbar');
  const vt = document.getElementById('viewtoggle'); if (vt) vt.hidden = true;
  answerOnScreen = false;               // an error card is not an answer — keep self-revealing
  selectedUnit = 0;
  bar.hidden = false;
  bar.className = 'unitbar unitbar-error';
  // THE ELEMENT STOPS BEING A LISTBOX WHEN IT STOPS HOLDING A LIST [BB 2026-08-11]. #unitbar is
  // declared `role="listbox" aria-label="Units in the query"`, and that is CORRECT while it holds
  // units — each `.unit` carries role="option" and aria-selected. An error card is not a list of
  // anything, so a screen-reader user met one while being told they were in a listbox called "Units
  // in the query" whose sole option was `Unexpected "Z" after "H9:"`.
  //
  // ROLE FIRST, CONTENT SECOND: `alert` is a live region, and the announcement is of what lands in it.
  //
  // AND NO aria-label. A named alert can have its name announced INSTEAD of its contents, which is
  // the whole of what the reader needs here — the same trap as #qdiag, where a short label hid the
  // explanation. The card's head, body and hint are the announcement.
  bar.setAttribute('role', 'alert');
  bar.removeAttribute('aria-label');
  bar.innerHTML = `<div class="uniterr errcard ${kind}">${html}</div>`;
  hideSpineSections();
  document.getElementById('subunits').innerHTML = '';
}


// Live canonical-IR inspector: resolve() + validateResolved for the current query,
// shown in the (formerly dead) #debug-tree panel. Fully contained — a throw here
// never touches the main render.
// ── THE ONE OBJECT (Phase 4b) ────────────────────────────────────────────────────────────────
// The query string used to be re-parsed FIVE times per render, and the consumers stopped at four
// different depths: the inspector resolved, arrangements and measurements lifted, and the materials
// pane read the raw parse tree. So the panes were not views of one thing — they were four separate
// readings that agreed only when nothing needed resolving.
//
// That is not a tidiness complaint, it is where `H2B1A:K121ub` broke. resolve2 translates K121 on
// H2B1A to idea position 120; the materials pane never saw it, re-derived 121 from the tree, and
// reported "no H2B sequence can carry ub at 121 — the residue there is Y". Truthful about a question
// nobody asked, which is the same failure as the stale inspector one layer down.
//
// So: build it ONCE, here, and hand it to everything. Consumers migrate onto it one at a time (the
// tree is still threaded alongside until each is ported), and the inspector becomes a VIEW of the
// object rather than the only thing that builds it correctly.
let currentIR = null;

// THE QUERY IR AND THE CANONICAL STRING LIVE IN `notation-canon.js` (U3+U4, 2026-08-15).
// `buildQueryIR`, the four IR readers, `queryTaxon`, and the `emitCanon` -> `canonNotation` stack
// moved out together — see that file's header for why they could not be cut apart. There is nothing
// to wire: it reads the query lens straight from `species-lens.js`, which exports it. It took an
// installer from here for one day, while `contextOverrideForQuery` was still declared in this file.

// THE DIAGNOSTICS DRAWER LIVES IN `diagnostics.js` (U5, 2026-08-15) — the IR inspector, the meet
// bench and the swap. It is a debugging surface that must never disturb the render, so it gets the
// page's state as GETTERS: with no binding to assign, that guarantee stops being a regex over a
// function body and starts being a property of the seam.
configureDiagnostics({
  currentIR:  () => currentIR,
  currentRaw: () => currentRaw,
  queryInput: () => inputEl,
});


// THE caption — one per query, under the unit bar.
//
// It used to be one caption per bead, drawn inside each unit. Three reasons it is now single:
// the canon is a statement about the whole query (an array's linkers live BETWEEN particles and no
// per-unit caption could ever show them); per-unit captions repeated the family fills once per bead;
// and only a whole-query string is something the user can take away.
//
// COPY hands over the caption with the dot kept and the subscripts spelled as ordinary digits —
// see `captionForCopy` for why the two characters are treated differently. Both spellings parse,
// and `canon-caption.test.js` re-parses BOTH across the corpus and checks each canonicalises to
// the same string, so the promise is a test rather than a hope.
function renderCanonCaption(ir) {
  const box = document.getElementById('canoncap');
  const out = document.getElementById('canoncap-text');
  if (!box || !out) return;
  const cap = ir ? styleNotation(ir) : null;
  if (!cap) { box.hidden = true; out.textContent = ''; return; }
  out.textContent = cap;                    // textContent, not innerHTML — the caption is data
  box.hidden = false;
}

// ONE COPY HANDLER, delegated once at load. `data-copy-from` names the element whose `textContent`
// is copied — so a second copy button is markup, not another listener that drifts from this one.
// Copies textContent because that is the characters the reader is looking at.
//
// `data-copy-transform="caption"` opts into the subscript rewrite: the caption is NOTATION, and
// pasting U+2080-U+2089 where someone will retype ASCII defeats the point of handing it to them.
// The semantic representation is not notation — it is a diagnostic dump — so it copies verbatim.
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-copy-from]');
  if (!btn) return;
  const src = document.getElementById(btn.dataset.copyFrom);
  if (!src || !src.textContent) return;
  const text = btn.dataset.copyTransform === 'caption'
    ? styleForCopy(src.textContent)
    : src.textContent;
  const done = () => { btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => {});
  }
});


function setEmpty() {
  inputEl.className = '';
  clearTimeout(_errReveal);             // a cleared bar withdraws the pending reveal too
  answerOnScreen = false;
  showOnboarding(true); lastKey = null; absenceModel = null;
  setValidity(null);
  document.getElementById('subunits').innerHTML = '';
  hideSpineSections();
  const bar = document.getElementById('unitbar');
  if (bar) { bar.hidden = true; bar.className = 'unitbar'; bar.innerHTML = ''; }
  const vt = document.getElementById('viewtoggle'); if (vt) vt.hidden = true;
  renderCanonCaption(null);
  const dbg = document.getElementById('debug-tree'); if (dbg) dbg.hidden = true;
  // AN EMPTIED BAR HAS NO IR. `currentIR` was only ever assigned on the input path below, which
  // returns here before reaching it — so clearing the query left the PREVIOUS query's IR standing,
  // and anything reading it afterwards was describing something the user had deleted. Harmless
  // while every consumer happened to run on the render path; not harmless now that the Compare
  // section's visibility is derived from it.
  currentIR = null;
  renderMeetBench();                                    // …which hides Compare, there being nothing to compare
  markReady();                                          // empty state is settled
}

function setValidity(state) {
  qfieldEl.classList.remove('bad');
  if (!state) return;                                  // valid: renderUnitBar repaints the units pane
  if (state.kind === 'syntax') {                       // cheap tier — border flash + reason
    void qfieldEl.offsetWidth; qfieldEl.classList.add('bad');
    // THE HEADLINE IS THE REASON, when there is one (BB, 2026-08-06). "Unrecognized notation" is a
    // restatement of the red frame — the reader can already see the query was not accepted, and the
    // one thing they came to the card for was WHERE. `syntaxError` always names that ("unexpected
    // end of input", `unexpected "X"`), so it is the headline and the generic line is the fallback
    // for a throw that arrives without one.
    //
    // The two fixed strings come from copy/messages.yaml (via the generated messages.js), like
    // the group labels below — the wording of this card is editable in one file, not three.
    const M = ((typeof MESSAGES !== 'undefined' && MESSAGES) || {}).syntax_error || {};
    const head = state.message
      ? state.message.charAt(0).toUpperCase() + state.message.slice(1)
      : M.headline_fallback;
    // A LIST, not a sentence. `state.groups` collapses Peggy's thirty-odd alternatives into the
    // handful of KINDS of thing that would fit here — see `groupExpected` for why the enumeration
    // itself is not shown. `state.expected` (the flat list) is still produced and still exported;
    // nothing on the page reads it any more.
    //
    // The group labels are MARKUP (the typeable characters are bolded inside them) and any token
    // interpolated into one is escaped at the source in `groupExpected`, so they are not escaped
    // again here. `head` is escaped: it quotes the character the user actually typed.
    const groups = state.groups || [];
    // A NAMED CASE, ABOVE THE GENERAL ONE (2026-08-11). `H3:X27M` is refused by a REVIEWED ruling —
    // X is a wildcard for the substituted residue only — and the card said "an amino acid would fit
    // here", which is true and tells the reader nothing about what they got wrong. Unlike
    // `nothing_fits` this does not replace the list: the note names the likely intent, the list
    // underneath is still an honest account of what else would fit.
    const note = state.xInWildType && M.x_in_wild_type ? `<p>${M.x_in_wild_type}</p>` : '';
    renderUnitError('syntax',
      `<div class="errhd">${escapeHtml(head)}</div>` + note +
      (groups.length
        ? `<p>${escapeHtml(M.lead || '')}</p>` +
          `<ul class="errlist">${groups.map(g => `<li>${g}</li>`).join('')}</ul>`
        // Nothing would fit, but the end of the query would have — the query was already complete
        // and the rest is a stray. Its own sentence, in place of the lead and the list, because it
        // is not a kind of thing that fits and listing it as one named no edit.
        //
        // NOT escaped, like the group labels beside it and unlike `head`. All three came from the
        // same place — this one was escaped anyway until 2026-08-07, so the `<b>` the catalogue's
        // own header promises would render literally, and the sentence could not bold the `@` it
        // tells the reader to type. Nothing is interpolated into it; `head` is escaped because it
        // quotes the character the reader actually typed, which is the only untrusted string here.
        : state.nothingFits ? `<p>${nothingFitsText()}</p>` : ''));
    return;
  }
  // The `{ kind: 'physics', info }` branch that stood here is GONE. It rendered v1 `normalize`'s
  // verdict, and that gate was removed once `valid2` was measured to reject a superset of it; the
  // physics error is now written where it is decided, in onInput's valid2 branch. Nothing calls
  // setValidity with an `info` any more.
}

// ── Units bar (Task 7) ──────────────────────────────────────────────────────
// Renders the physical-unit selector (units-bar.js's unitList()) above the
// stage and scopes the materials/arrangements/measurements panes to whichever
// unit is focused. The cartoon itself is rendered by particle-scene.js (IR node -> SVG) and the
// unit list by units-bar.js; this file only does DOM + the pane splice.

// The baked sprite atlas (build/sprite-atlas.json, served as data/sprite-atlas.json). It replaces
// the runtime-fetched <svg> holder appended to <body> AND the getBBox() geometry that needed it —
// see scripts/build_sprite_atlas.js. Nothing is measured in the browser any more, which is what
// makes the renderer testable in Node at all.
// TWO PROJECTIONS, ONE CACHE PER PROJECTION (BB, 2026-08-07). `beadAtlas` stays the name everything
// draws from — it is simply whichever view is current — so no render site learns about the toggle.
// Switching views is therefore "load if needed, then repaint", and nothing else.
// The bead cache — see `beadsHtml`. Keyed on the NODE's identity, so `beadKey` hands each node a
// stable id the first time it is seen. A WeakMap, so a superseded query's nodes are collectable.
const _beadIds = new WeakMap();
let _beadIdN = 0;
function beadKey(node) {
  if (!node || typeof node !== 'object') return '0';
  let id = _beadIds.get(node);
  if (!id) { id = String(++_beadIdN); _beadIds.set(node, id); }
  return id;
}
let _beadCache = new Map();

let spriteView = 'top';
const beadAtlases = { top: null, side: null };
const beadAtlasPromises = { top: null, side: null };
const ATLAS_URL_FOR = { top: (typeof ATLAS_URL !== 'undefined') ? ATLAS_URL : '',
                        side: (typeof ATLAS_URL_SIDE !== 'undefined') ? ATLAS_URL_SIDE : '' };
let beadAtlas = null;
function ensureBeadDefs(view) {
  view = view || spriteView;
  if (beadAtlases[view]) { if (view === spriteView) beadAtlas = beadAtlases[view];
                           return Promise.resolve(beadAtlases[view]); }
  if (beadAtlasPromises[view]) return beadAtlasPromises[view];
  beadAtlasPromises[view] = fetch(ATLAS_URL_FOR[view]).then(r => r.json()).then(a => {
      beadAtlases[view] = a;
      if (view === spriteView) beadAtlas = a;
      return a;
    })
    // A MISSING ATLAS IS AN ERROR, not a fallback. The old path caught its fetch failure and handed
    // back `{holder: null}`, which rendered an empty <svg> — a bead-shaped hole that looked like a
    // rendering choice. renderParticle throws on an empty atlas; here we simply leave it null and
    // let the caller draw nothing rather than draw a lie.
    .catch(() => { beadAtlases[view] = null; if (view === spriteView) beadAtlas = null; return null; });
  return beadAtlasPromises[view];
}

// The last arguments `renderUnitBar` was called with, so the projection toggle can redraw the same
// answer. Kept rather than recomputed: the query has not changed, and re-entering the render loop to
// swap a picture would re-run everything the picture is drawn from.
let lastBarArgs = null;
function repaintUnitBar() {
  if (lastBarArgs) renderUnitBar(lastBarArgs.parsed, lastBarArgs.key);
}

// Switch projection: load that view's atlas if it is not already in hand, point `beadAtlas` at it,
// and repaint the bar. `lastKey` is NOT cleared — the ANSWER has not changed, only the drawing of
// it, and clearing it would re-run the whole query pipeline to redraw eight beads.
function setSpriteView(view) {
  if (view !== 'top' && view !== 'side') return;
  if (view === spriteView) return;
  spriteView = view;
  // THE BUTTON-STATE SYNC IS PART OF THE WITHDRAWN CONTROL, NOT THE CAPABILITY [BB 2026-09-26]:
  // `#viewtoggle .vtb` no longer exists in live markup (commented out in answer.html), so this
  // querySelectorAll always found nothing anyway — commented here too so it does not read as a
  // live DOM query over an element the page no longer offers.
  // document.querySelectorAll('#viewtoggle .vtb').forEach((b) => {
  //   const on = b.dataset.view === view;
  //   b.classList.toggle('on', on);
  //   b.setAttribute('aria-pressed', String(on));
  // });
  const paint = () => { beadAtlas = beadAtlases[spriteView]; repaintUnitBar(); };
  if (beadAtlases[view]) paint(); else ensureBeadDefs(view).then(paint);
}

// ── THE PROJECTION TOGGLE IS WITHDRAWN [BB 2026-09-26] ───────────────────────────────────────────
// "the cartoon always renders the top view." Kept as code rather than deleted because it is to be
// REIMPLEMENTED — see TODO.md. `#viewtoggle`'s markup is commented out in answer.html, so this
// listener would fire on nothing; commented here too so it does not read as live wiring for a
// control that no longer exists. `setSpriteView` itself, `ensureBeadDefs` and the two atlases
// (`beadAtlases.top`/`.side`) are UNTOUCHED — that is the side-view CAPABILITY, not the control,
// and `spriteView` simply never leaves its `'top'` default while nothing calls `setSpriteView`.
//
// document.addEventListener('click', (e) => {
//   const b = e.target.closest && e.target.closest('#viewtoggle .vtb');
//   if (b) setSpriteView(b.dataset.view);
// });


// The arrangement world a unit's cartoon should mirror: the focused unit's live
// selection; another array member's saved selection; or — if that member was
// never visited — its OWN default lowest-C2 arrangement, so every member's
// cartoon shows its ground C2 (not the query-level fallback). null when the unit
// isn't an enumerable nucleosome (dimer/…) or the focused unit is deselected.
// Selected-tile → its concrete world IR (interpret3().worlds[i], aligned to .octamers[i]). This is the
// meet-derived world the shell consumes for materials (worldView) and matching, so it never re-derives a
// world from the lossy arrangement string. Rebuilt per query from the interpretation; empty when the
// query doesn't enumerate (bare histone / array).
let worldIRByArr = new Map();
// The query's glyph set C — the UP-SET of everything the query permits over the fixed universe G.
//
// Read off the QUERY IR, never off the enumerated worlds. Two reasons, one historical and one
// structural. Point glyphs were wrong because a world's glyph renders an unmarked copy as P ("carries no
// mark"), a claim a query that never mentioned the family has not made — the 83 dropped measurements.
// And deriving C from the world list at all ties relevance to enumeration, which must be bounded
// (18,974,736 candidates for a ten-mark query): any cap on the draw would silently become a cap on
// relevance. `specFromIR` gives the same set in O(families), verified equal to the union over worlds
// across the corpus in glyph-universe.test.js.
// Tiles DRAWN. A rendering choice only — enumeration (complete or sampled) has finished before this
// applies, and the relevance set C never reads the tile list. `tileLimit` is raised by "Show more".
const TILE_CAP = 24;
let tileLimit = TILE_CAP;
let currentInterp = null;   // the live interpretation, so the tile controls need not re-enumerate
let currentGlyphC = new Set();
// The two copy signatures of each family, out of an arrangement string. This is NOT a symmetry
// derivation — the point group and the orientation label come from the engine's `arrangements`
// record below, and re-deriving THOSE from the string is what was removed when
// `parseArrangement` stood here until 2026-08-05. It split an arrangement key into
// `{fam: [copy0, copy1]}` — the shape `selectedWorld` used to be. Its own comment said it "should
// become the world IR itself … recorded in TODO.md"; it now is, so the accessor and the second
// representation are both gone. `selectedArr` (the key) stays: identifying WHICH tile is a different
// job from saying what the tile contains.

// ── ORIENTATION: WHICH OF THE TWO MIRRORS IS ON SCREEN ──────────────────────────────────────────
// A C1 arrangement is one octamer with TWO orientations — the same eight molecules with the DNA
// running the other way — and the tile shows one of them. Clicking the tile again shows the other:
// the two faces exchange, so the rows swap and every mark moves between copy 1 and copy 2.
//
// ONLY WHEN THE READER DID NOT SAY [BB 2026-08-05]. If the descriptor states `+` or `-`, the engine
// already keeps that orientation and no other, so there is nothing to flip to and the affordance is
// not offered. A C2 tile is likewise unflippable: it IS its own mirror.
//
// Keyed by arrangement string per unit, so flipping one tile does not disturb another, and cleared
// when the query changes — an orientation is a fact about a world, and a new query has new worlds.
let flippedArr = new Map();                        // unitIndex → Set(arrStr)
function isFlipped(index, arrStr) {
  const s = flippedArr.get(index);
  return !!(s && s.has(arrStr));
}
// A FLIP NEEDS TWO FACES TO EXCHANGE, and the record says so directly: `slots !== mirror` means the
// dyad flip lands on a different arrangement. That WAS `symmetry === 'C1'` — identical for a
// two-faced world, since C2 is defined as `slots === mirror` — but one-faced worlds now report a real
// point group (2026-08-05) and a one-faced C1 has no second face, so the old test would offer the
// control on a dimer and a lone molecule. The flip spec's own rule: never present a control that does
// nothing.
function canFlip(arrStr) {
  const a = arrOf(arrStr);
  return !!(a && a.slots !== a.mirror && currentInterp && currentInterp.polarity == null);
}
function toggleFlip(index, arrStr) {
  if (!flippedArr.has(index)) flippedArr.set(index, new Set());
  const s = flippedArr.get(index);
  if (s.has(arrStr)) s.delete(arrStr); else s.add(arrStr);
}
// The same world with its two faces exchanged. Every member carries `face`, so the mirror is that
// field inverted — nothing else about the world changes, which is what makes it the SAME octamer.
// `flipSelectedWorld` stood here — the same dyad swap as `flipWorldIR`, over the parsed
// copy-signature pair, kept in step with it by hand. Two flips for one selection; the click handler
// re-derives through `worldIRFor` now, which applies the swap once.

function flipWorldIR(w) {
  if (!w || typeof w !== 'object') return w;
  const out = Array.isArray(w) ? [] : {};
  for (const k in w) out[k] = w[k];
  // Faces are 1 and 2 — the copy numbers themselves (grammar/interpret2.js worldIR).
  if (out.face === 1) out.face = 2; else if (out.face === 2) out.face = 1;
  if (Array.isArray(w.members)) out.members = w.members.map(flipWorldIR);
  return out;
}

// arrStr → the engine's arrangement record {slots, mirror, symmetry, sign, mirrorSign, label}.
// The point group and the orientation label are READ from here, never re-derived from the arrangement
// string. `arrangements-model.js` used to re-parse that string to answer "C1 or C2?", which made the
// tile's label and the tile's sort two independent derivations of one fact — the same shape that
// produced three implementations of the dyad flip.
let arrByStr = new Map();
function arrOf(arrStr) { return arrByStr.get(arrStr) || null; }
function symOf(arrStr) { const a = arrOf(arrStr); return a ? a.symmetry : 'C1'; }
function labelOf(arrStr, index) {
  const a = arrOf(arrStr);
  if (!a) return 'C1';
  if (index != null && isFlipped(index, arrStr)) return a.symmetry + (a.mirrorSign || '');
  return a.label;
}

function indexWorldIRs(interp, queryIR) {
  worldIRByArr = new Map(); currentGlyphC = new Set(); arrByStr = new Map();
  // …AND THE TILE UP-SET MEMO, which depends on the map rebuilt above and must die with it. The key
  // is not unique across queries: `stateSig` embeds an identity's INDEX into a per-interpretation
  // list, so one string can denote different worlds in two queries, and the strict measurement
  // filter would read the previous one's answer. Reviewed 2026-08-05; the memo itself now lives in
  // relevance-model.js, so this is a stated call rather than a reach into a private Map.
  relevance.resetWorlds();
  if (interp && interp.node === 'interpretation' && Array.isArray(interp.arrangements)) {
    interp.octamers.forEach((arr, i) => { if (interp.arrangements[i]) arrByStr.set(arr, interp.arrangements[i]); });
  }
  if (interp && interp.node === 'interpretation' && Array.isArray(interp.worlds)) {
    // worldIRByArr stays on the DRAWN tiles: only a rendered tile can be selected.
    interp.octamers.forEach((arr, i) => { if (interp.worlds[i]) worldIRByArr.set(arr, interp.worlds[i]); });
  }
  const ir = queryIR || particleOf(unitIR2(selectedUnit));
  if (ir && typeof irUpSet === 'function') {
    try { irUpSet(ir, relevance.GLYPH_U).forEach(g => currentGlyphC.add(g)); } catch (e) { /* leave C empty */ }
  }
}

// ── The relevance layer lives in relevance-model.js ─────────────────────────────────────────────
// Extracted 2026-08-15 (U1, specs/2026-08-13-shell-seams.md). It reads five things that MUTATE
// between renders, and they arrive as GETTERS: a value captured here would freeze the answer to
// whatever was true when this line ran.
//
// WHAT IS WIRED AND WHAT IS NOT. The glyph-universe helpers, the measurements-model gates,
// `extentExcludes` and the engine are NOT here: those modules end with `Object.assign(globalThis,
// api)`, so the model finds them itself.
//
// `unitIR2` IS here, and it has to be. It is declared in THIS file, index.html inlines it into a
// `<script type="module">`, and a module's top-level declarations are not properties of
// `globalThis` — so the model cannot reach it by name on the page, even though every node suite
// (which runs this file as a classic script) would say it can. Wiring `unitIR2` was skipped once;
// the page failed open and showed six measurement sections for a query that admits one, with
// `make test` green throughout.
//
// `contextOverrideForQuery` IS STILL WIRED, BUT NOT FOR THE REASON ABOVE (U7, 2026-08-15). It moved
// to `species-lens.js`, which exports it, so it is now a `globalThis` property and the model COULD
// find it by name like the glyph-universe helpers. It stays hosted because `relevance-model.js`
// reads `h.contextOverride` with no global fallback — deliberately, since U1's rule is that the
// model resolves nothing by name and its suite asserts exactly that. Unwiring it would not fall
// back; it would return null and drop the species lens out of every relevance decision, silently.
// So: hosted for uniformity now, not out of necessity, and this line is the one that says which.
const relevance = createRelevance({
  broaden:         () => broaden,
  worldFor:        (arrStr) => worldIRByArr.get(arrStr) || null,
  glyphC:          () => currentGlyphC,
  currentIR:       () => currentIR,
  selectedUnit:    () => selectedUnit,
  unitIR2:         (unit) => unitIR2(unit),
  contextOverride: () => (typeof contextOverrideForQuery === 'function' ? contextOverrideForQuery() : null),
});

// AN ARRAY OF ONE IS THAT ONE. Both sides of the relation must sit at the SAME level of the IR —
// meet2 bottoms out on a node-type mismatch, so handing it an array-of-one datum against an assembly
// query silently rejects everything. A lone particle lifts to an array of one; unwrap it.
//
// The engine's, since 2026-08-05. This sentence was written six times across the repo (census §2).
function particleOf(ir) {
  return nucleosomeParser2.particleOf(ir);
}

// World enumeration — v2 (interpret2, meet-derived/faithful) is the source of truth for the tiles.
// Same return shape as v1 interpret() ({node:'interpretation', octamers, nucleosomes, counts, capped,
// total}), and BOTH stacks encode variants as \x1f-prefixed tokens in the arrangement string, so every
// downstream consumer (lowestC2, c2First, tileEl, counts) is unchanged. If parse2
// can't take a canonical form v1 could (a coverage gap), fall back to v1 with a console warning rather
// than collapse the panel — the gap stays visible without regressing the live UI.
// Which enumeration engine is actually live, reported in the build stamp. A stale cached parser2.js
// against a freshly-inlined shell is invisible otherwise: the v1 fallback below still renders, just
// with different (wrong) worlds. Checked once at load.
// The bundle's modules register in file order, so WHICH symbols are present says exactly how far
// execution got before something threw. Ordered as concatenated by the Makefile.

function interpretWorlds(str) {
  try {
    // An IR node passes straight through — that is how the faithful path avoids re-serialising
    // through v1 (see unitIR2 / currentRaw).
    // MATERIALIZE, THEN ENUMERATE. The query is put into registry coordinates ONCE — positions become
    // alignment columns, the accession set becomes the molecules that survive the walk — and the
    // worlds are enumerated over THAT. Everything downstream reads what materialize3 concluded
    // instead of re-deriving it: six implementations of "stated number → site" disagreed on this page
    // before, and `H2A:K7ac` had its verdicts computed on one column and its mark drawn on another.
    //
    // An IR node still passes through without re-parsing (the faithful path); it is materialized
    // here rather than at the caller so there is one place that decides the coordinate system.
    const P2 = nucleosomeParser2;
    const ctx = (typeof contextOverrideForQuery === 'function') ? contextOverrideForQuery() : {};
    const ir = (str && typeof str === 'object') ? str : P2.lift2(P2.parse(str));
    return P2.interpret3(P2.materialize3(ir, ctx, P2.DEFAULT_REGISTRY), ctx, P2.DEFAULT_REGISTRY);
  } catch (e) {
    // NO v1 FALLBACK (Phase 5, item 2). It existed while interpret2 was being brought up, and a
    // fallback whose failure mode is "the previous engine quietly answers instead" is exactly the
    // shape that let the parse2 switch ship inert. The alarm still fires; the caller gets null and
    // renders an empty arrangements panel, which is visible, rather than v1's answer, which is not.
    console.warn('interpret3 failed for:', str, '—', e.message);
    reportEngineFallback(str, e);
    return null;
  }
}
// The build stamp and the page alarm, painted HERE — at the point the stampEngine IIFE used to run.
// The function moved to engine-notices.js (U2) but WHEN it fires did not, because moving the module
// earlier in the include list would otherwise have moved the paint too, and a refactor that also
// changes boot order is two changes wearing one diff.
stampEngine();

// The v2 IR for one unit of the CURRENT query, taken from the raw text. An array lifts to an array
// node whose members are its particles in order, so unit i is member i — the same order unitList()
// walks. Returns null when the raw text can't be lifted, so callers fall back to the old string path
// rather than losing the panel.
function unitIR2(unitIndex) {
  // The SHARED object (Phase 4b), not a re-parse — and split into units by the SAME function the bar
  // uses (`unitNodes`), so a repeated particle like `(H3)3` cannot be three beads in the bar and one
  // node here.
  const ir = currentIR;
  if (!ir || ir.node === 'error' || ir.node === 'bottom') return null;
  const nodes = unitNodes(ir);
  return nodes.length ? (nodes[unitIndex] || nodes[0]) : ir;
}

// The concrete world IR behind an arrangement string, for one unit. A LOOKUP, not a re-derivation:
// interpret2 emits `worlds` aligned index-for-index with `octamers`, so the string the tile carries
// selects the node directly. (particle-scene.test.js proves seats(worldIR) equals the old
// worldDeco(parseArrangement(str)) for every world of the corpus, which is what licenses this.)
function worldIRFor(index, arrStr) {
  if (!arrStr) return null;
  try {
    const interp = interpretWorlds(unitIR2(index));
    if (!interp || interp.node !== 'interpretation') return null;
    const i = (interp.octamers || []).indexOf(arrStr);
    const w = i >= 0 ? ((interp.worlds || [])[i] || null) : null;
    return (w && isFlipped(index, arrStr)) ? flipWorldIR(w) : w;
  } catch (e) { return null; }
}

// Which world a unit's cartoon shows: the focused unit's live selection; another array member's
// saved choice; or — never visited — its own default lowest C2. Returns an IR NODE, so the cartoon
// and the materials pane consume the same object.
function unitWorld(u, index, sel) {
  let arr = null;
  if (sel) arr = selectedArr;
  else {
    const saved = unitArr.get(index);
    if (saved) arr = saved.arr;
    else try {
      const interp = interpretWorlds(unitIR2(index));
      if (interp && interp.node === 'interpretation') arr = lowestC2(interp);   // the RECORD, not just the strings
    } catch (e) { /* not enumerable */ }
  }
  return worldIRFor(index, arr);
}

// The bead markup for a unit: ONE call into the IR renderer.
//
// This used to branch — worldDeco when a tile was selected, fallbackDeco (a walk over the v1 parse
// subtree) when not — two sources for one picture, only one of which could be right about a
// partially stated query. A world IS an IR node, so both are `renderParticle(node)` and the branch
// is now only about WHICH node: the selected world if there is one, else the query itself.
// A copy of a node with every mark removed. Used ONLY where materialize3 failed outright: the bar
// still draws the particle, but a mark whose column nobody computed must not be placed by its
// authored number, because the scene now reads every number as a column. Nothing, not something
// wrong.
function stripMarks(n) {
  if (!n || typeof n !== 'object') return n;
  const out = {};
  for (const k in n) out[k] = n[k];
  if (n.node === 'proteoform') out.modifications = [];
  if (n.members) out.members = n.members.map(stripMarks);
  return out;
}

// The unit's own IR, MATERIALIZED — positions are alignment columns, the accession set is the
// molecules that survived the walk. Memoised per (query, unit, context) the way `referenceParticle`
// is, and for the same reason: it is called per unit per render and materialize3 runs the walk.
let _matUnit = { ir: null, unit: null, ctx: null, node: null };
function materializedUnit(index) {
  const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
  const raw = unitIR2(index);
  if (!P2 || !raw) return raw;
  const ctx = (typeof contextOverrideForQuery === 'function') ? contextOverrideForQuery() : {};
  const ck = JSON.stringify(ctx || {});
  if (_matUnit.ir !== currentIR || _matUnit.unit !== index || _matUnit.ctx !== ck) {
    let node = null;
    try { node = P2.materialize3(raw, ctx, P2.DEFAULT_REGISTRY); } catch (e) { node = null; }
    _matUnit = { ir: currentIR, unit: index, ctx: ck, node: node };
  }
  return _matUnit.node;
}

function beadsHtml(u, sel, index) {
  if (!beadAtlas) return '';                       // not loaded yet — renderUnitBar repaints on ready
  // ONE COORDINATE SYSTEM. This used to hand the scene either a world (interpret3, so alignment
  // COLUMNS) or the raw query IR (authored numbers), and declare which with a flag — so every
  // query that does not enumerate drew its marks in a second coordinate system, and the scene had
  // to carry a mode for it. `materialize3` answers for both: a world already is materialized, and a
  // non-enumerable unit becomes one here. The flag is gone from the scene.
  //
  // WHAT CHANGES ON SCREEN, and it is the point rather than a side effect: an UNPOSABLE query
  // (`(H2A.Z:K119ub)` — no H2A.Z carries K at that site) had its mark drawn at authored 119 on
  // whatever chain the bead held, which asserts a placement the engine had just refused.
  // `materialize3` drops the mark and records the refusal, so the particle draws with no dot and
  // the pane below says why.
  //
  // `materializedUnit` returns null only if materialize3 THREW, which is not a routine outcome —
  // a refusal is a node with `refusals`, not an exception. The raw IR is used then so the bar still
  // draws something, and its marks are dropped rather than placed in the wrong numbering.
  const world = unitWorld(u, index, sel);
  const mat = world || materializedUnit(index);
  const node = mat || stripMarks(unitIR2(index));
  if (!node) return '';
  // ONE OPINION ABOUT ARRAY-NESS, and it is the unit list's (BB, 2026-08-06). This asked the IR
  // directly — `members.length > 1` — while `unitNodes` had ALREADY decided how many units there
  // are, and the two disagree exactly where a particle carries its own count: `(H3)2` is one member
  // with count 2, so this said "not an array" and the bar drew two unjoined beads, while `(H3)(H3)`
  // is two members and drew them linked. Same object, two pictures, because the cartoon was reading
  // the IR a second way instead of reading the units it was about to draw.
  //
  // `unitList` is the single source: more than one unit on the bar IS an array, however the
  // repetition was spelled.
  const arrayMember = unitList(currentIR, nucleosomeParser2).length > 1;
  const leadingLinker = !(arrayMember && index === 0);  // nothing joins on the first member's left

  // ── ONE RENDER PER DISTINCT PICTURE (BB, 2026-08-07) ──────────────────────────────────────────
  // `unitNodes` expands a particle's count by pushing the SAME node object once per unit, so `(H4)20`
  // is twenty units over ONE node — and this drew it twenty times: 475 KB of identical SVG, 2.4 MB at
  // `(H4)100`, and twice over, because renderUnitBar paints once and repaints when the atlas lands.
  //
  // Everything the picture depends on is in the key, which is why this is a cache and not a guess:
  // the node's IDENTITY (repeats share it; a new query allocates fresh nodes), whether it is drawn in
  // the array frame, whether it carries a leading linker, and which projection is current. `(H4)20`
  // therefore renders TWICE — index 0 has no leading linker, the rest do — rather than twenty times.
  //
  // Keyed on identity rather than on a canonical string on purpose: two units that are `meet`-equal
  // but distinct objects (`(H3)(H3)` after a per-member arrangement choice) must be free to differ,
  // and identity is exactly that question.
  // EXACTLY ONE BEAD ANIMATES: the selected one. `index` here is the same unit index every
  // caller already passes (unitEl's own `i`, or `selectedUnit` from repaintSelectedBead), so
  // comparing it to the module-level `selectedUnit` says "is this the selected bead" without a
  // fifth thing to keep in sync — `sel` already means something else (unitWorld's world choice)
  // and repurposing it would make that call ambiguous again.
  // EVERY BEAD CARRIES THE ANIMATION; PLAYBACK IS A DOM STATE, NOT A MARKUP STATE [BB 2026-08-11].
  // This used to emit the animation only for the selected bead, which made the markup depend on
  // selection and put `animate` in the cache key. It now emits for all of them and `syncBeadClocks`
  // decides which one is running — so selecting a bead is `unpauseAnimations()` rather than a
  // re-render, a bead FREEZES where it stood instead of snapping to a pose, and the key gets
  // shorter rather than longer.
  const animate = true;
  // The former note, kept because the trap it describes is real if `animate` ever varies again: a
  // the selected bead can share a node (e.g. selecting a repeated unit), and without this the
  // first render of that node wins the cache for every later bead that reuses it — a still bead
  // starts animating, or the selected bead goes still, depending only on paint order.
  const key = beadKey(node) + '|' + (arrayMember ? 1 : 0) + '|' + (leadingLinker ? 1 : 0) + '|' + spriteView;
  const hit = _beadCache.get(key);
  if (hit !== undefined) return hit;

  const html = renderParticle(node, {
    atlas: beadAtlas, deps: nucleosomeParser2,
    arrayMember,
    leadingLinker,
    animate,
  });
  _beadCache.set(key, html);
  return html;
}

// One unit's markup.
//
// THE `'other'` BRANCH IS GONE (BB, 2026-08-06). It drew "no canonical particle" for a composition
// `classify2` could not name — two H2A–H2B dimers with no H3/H4, say — and was the honest answer in
// 2026-07-25, when such a query reached the renderer. It cannot any more: the `valid2` gate added
// since refuses those assemblies in `onInput`, and they get the physics error card instead. Measured
// before removing — 1,463 particles built from the core families and co-brackets, 879 of them
// valid2-passing, and NOT ONE classified as 'other'. A branch that cannot run is a claim about the
// engine that nobody can check.
function unitEl(u, i, sel) {
  const linker = u.linkerAfter
    ? `<span class="linker"><span class="bp">${u.linkerAfter.bp} bp</span></span>`
    : '';
  const head = `<div class="unit" role="option" `
             + `tabindex="${sel ? 0 : -1}" aria-selected="${sel}" data-i="${i}">`;
  // The state dot, BELOW the bead. Every unit gets one, not just the selected one: the row then says
  // "these are the choices, this is the active one", which is also the only thing on the bar that
  // says the beads can be clicked.
  //
  // ALWAYS EMITTED, even for a mononucleosome that has no choice to express. It is hidden there
  // rather than omitted (`.unitbar-single`, which renderUnitBar sets) so the row still takes its
  // height: dropping the element moved the whole cartoon up by a dot's worth the moment a query went
  // from an array to a single particle, which reads as the page twitching. Reserving the band costs
  // 12px of empty space and buys a bar that does not jump. (BB, 2026-07-31)
  //
  // `aria-hidden` because `.unit` already carries role="option" + aria-selected — the dot is a
  // visual echo of state a screen reader is given properly, and announcing it twice is worse than
  // not at all. It goes LAST because `.unit` is a centred flex column: order in the markup is order
  // on screen.
  const dot = '<span class="unit-dot" aria-hidden="true"></span>';
  return head + `<span class="bead-wrap">${beadsHtml(u, sel, i)}</span>` + dot + '</div>' + linker;
}

// HOW FAR THE PARTICLE SITS FROM THE CENTRE OF ITS OWN FRAME, as a multiple of the bead's height.
//
// An array member is drawn in the full frame, which carries a linker margin on its LEFT — so the
// core's centre is not the frame's centre. For the shipped atlas the core sits at 67.9% of the
// width, which means every bead in the row is drawn a quarter of a bead-height right of where its
// layout box says it is. Everything that aims at a bead therefore misses by the same amount: the
// state dot pointed between two beads, the keyboard focus ring circled empty space beside one, and
// the whole row sat right of the caption that is centred under it.
//
// One number fixes all of them, because it is one error. `.unit` and `.linker` are translated by it
// (see `--bead-shift`), which moves bead, dot, focus ring and "N bp" label together and leaves the
// layout — and therefore the linkers' joining — untouched.
//
// Returned as a UNITLESS ratio of the bead HEIGHT, not a percentage: `.linker` is a zero-width
// element, and a percentage against zero is zero. Multiplied by `--bead-h` in CSS.
//
// MEASURED FROM THE OCTAMER, NOT FROM `coreViewBox` (BB, 2026-07-31). The obvious source is that
// field, and it is wrong for this by ~3px: it bounds the DRAWING, and the drawing includes the DNA
// gyre, which is not symmetric about the particle. Its centre is therefore not the particle's.
//
// The mean of the eight subunit centroids is. Two independent things in the atlas agree on it — the
// centroid mean lands at x=38.32 and the `#selector` disc, which was authored as a disc centred on
// the particle, at x=38.28, against `coreViewBox`'s 39.57. Centroids are used because they are
// structured data; the disc would have to be regexed out of markup.
//
// Coordinates are pre-`groupTransform`, so the translate is applied before comparing to the viewBox.
//
// APPROXIMATE IN ONE CASE: the full frame is used only when the member has DNA, so a DNA-less unit
// (a tetramer) is drawn in the core frame and needs no shift. This is applied per BAR, not per unit,
// so a mixed array would nudge its tetramers. An array is a chain of nucleosomes, so that is not
// reachable today; stated because the day it is, this is the line to split.
function beadCoreOffsetRatio() {
  const vb = beadAtlas && beadAtlas.viewBox ? String(beadAtlas.viewBox).trim().split(/\s+/).map(Number) : null;
  const cs = beadAtlas && beadAtlas.centroids ? Object.keys(beadAtlas.centroids).map(k => beadAtlas.centroids[k]) : null;
  if (!vb || vb.length < 4 || !vb[3] || !isFinite(vb[3])) return null;
  if (!cs || !cs.length) return null;
  const xs = cs.map(c => c && c.x).filter(x => typeof x === 'number' && isFinite(x));
  if (!xs.length) return null;
  const tm = /translate\(\s*(-?[\d.]+)/.exec(String(beadAtlas.groupTransform || ''));
  const tx = tm ? parseFloat(tm[1]) : 0;
  const particleCentre = xs.reduce((a, b) => a + b, 0) / xs.length + tx;
  const boxCentre = vb[0] + vb[2] / 2;
  return ((particleCentre - boxCentre) / vb[3]).toFixed(5);
}

// Renders the bar from unitList(parsed). Hides it (0 units — shouldn't happen
// for a valid query, but defensive) and repaints the selection ring/tabindex
// on every call, including from selectUnit().
function renderUnitBar(parsed, key) {
  const bar = document.getElementById('unitbar');
  const units = unitList(currentIR, nucleosomeParser2);
  bar.className = 'unitbar';                       // clear any prior error surface
  // …and the ROLE with it: renderUnitError turns this element into an alert, so every path back to
  // units has to turn it into a listbox again. Restored here, before the no-units early return, so
  // an empty bar is not left announcing itself as the last error.
  bar.setAttribute('role', 'listbox');
  bar.setAttribute('aria-label', 'Units in the query');
  // The projection toggle rides with the bar: it is a control over the CARTOON, so it appears
  // exactly when there is one and never over an error card.
  lastBarArgs = { parsed, key };
  const vt = document.getElementById('viewtoggle');
  if (!units.length) { bar.hidden = true; bar.innerHTML = ''; if (vt) vt.hidden = true; return units; }
  bar.hidden = false;
  if (vt) vt.hidden = false;
  if (selectedUnit >= units.length) selectedUnit = 0;
  // A state dot is only MEANINGFUL when there's a choice, but it is emitted either way and hidden
  // here — see unitEl. The class goes on the bar rather than the unit because it is a fact about the
  // query, not about any one particle.
  const multi = units.length > 1;
  bar.classList.toggle('unitbar-single', !multi);
  // Only array members are drawn in the linker-margin frame, so only they are off-centre in it.
  // Cleared otherwise rather than set to 0, so the CSS fallback is the single source of "no shift".
  //
  // `multi`, NOT a second reading of the IR (BB, 2026-08-06). This was the same
  // `members.length > 1` expression `beadsHtml` carried, and it is wrong the same way: `(H3)2` is
  // ONE member with count 2, so it said "not an array", left the offset cleared, and drew the bead
  // unshifted inside the WIDE linker viewBox that `arrayMember` had just selected — which is why
  // the unit-dot looked misaligned under it while `(H3)(H3)` looked right. The dot was never the
  // problem; the bead above it was.
  //
  // Two consumers, one question, one answer: the number of units, which `unitList` already gave us.
  const ratio = multi ? beadCoreOffsetRatio() : null;
  if (ratio) bar.style.setProperty('--bead-core-offset', ratio);
  else bar.style.removeProperty('--bead-core-offset');
  rememberBeadClocks();
  bar.innerHTML = units.map((u, i) => unitEl(u, i, i === selectedUnit)).join('');
  syncBeadClocks();
  bar.querySelectorAll('.unit').forEach(el => {
    el.addEventListener('click', () => selectUnit(+el.dataset.i, parsed, key));
    el.addEventListener('keydown', e => onUnitKey(e, el, parsed, key));
  });
  if (!beadAtlas) ensureBeadDefs().then(() => {
    const live = document.getElementById('unitbar');
    if (live !== bar || bar.classList.contains('unitbar-error') || bar.hidden) return;
    bar.innerHTML = units.map((u, idx) => unitEl(u, idx, idx === selectedUnit)).join('');
    bar.querySelectorAll('.unit').forEach(el => {
      el.addEventListener('click', () => selectUnit(+el.dataset.i, parsed, key));
      el.addEventListener('keydown', e => onUnitKey(e, el, parsed, key));
    });
  });
  return units;
}

async function selectUnit(i, parsed, key) {
  if (i === selectedUnit) return;                              // already focused — no-op
  // Save the outgoing unit's arrangement, then restore the incoming unit's (or a
  // fresh state → renderFocusedPanes re-defaults it to the lowest C2).
  unitArr.set(selectedUnit, { arr: selectedArr, touched: arrTouched });
  selectedUnit = i;
  const saved = unitArr.get(i);
  selectedArr = saved ? saved.arr : null;
  arrTouched = saved ? saved.touched : false;
  selectedWorld = selectedArr ? worldIRFor(selectedUnit, selectedArr) : null;
  renderUnitBar(parsed, key);        // repaint selection ring/tabindex
  await renderFocusedPanes(parsed, key);   // scope the two panes to this unit
}

// Repaint only the selected unit's bead so it mirrors the current selectedWorld
// (dots + variant fill). renderUnitBar runs BEFORE the default world is chosen
// (and a tile click changes the world without re-listing units), so the cartoon
// is refreshed here rather than by a full bar rebuild.
// ── THE BEAD CLOCKS ─────────────────────────────────────────────────────────────────────────────
//
// Every bead's markup carries the full animation and every bead's `<svg>` has its own SMIL timeline.
// What differs between beads is only WHERE that timeline sits and whether it is running:
//
//   * the selected bead runs;
//   * every other bead is PAUSED WHERE IT STOOD, so losing focus freezes a particle mid-motion
//     rather than snapping it to a canonical pose;
//   * a bead the reader has never selected sits at `data-phase`, a hash of its own identity scaled
//     across the cycle — so an array reads as an ensemble of conformations at rest, which is what
//     the per-bead frame used to buy by re-rendering.
//
// RE-RENDERING DESTROYS A TIMELINE. Beads reach the DOM as HTML strings (`bar.innerHTML = …`), so
// every repaint builds a NEW `<svg>` whose clock starts at 0 — a world switch would otherwise jerk
// every bead back to the top of the loop. `_beadClock` carries the position across the replacement,
// keyed by unit index, and `syncBeadClocks` restores it. The bead cache is not involved: it caches
// markup, and a clock belongs to an element.
const _beadClock = new Map();

// The DECISION — which position each bead holds and which one runs — is `beadClockPlan` in
// shell-model.js, with its own suite. What is left here is the wiring: read the clocks off the DOM
// before a repaint destroys them, and apply the plan after.
function rememberBeadClocks() {
  document.querySelectorAll('#unitbar .unit').forEach((el) => {
    const svg = el.querySelector('svg.bead');
    if (!svg || typeof svg.getCurrentTime !== 'function') return;
    _beadClock.set(String(el.dataset.i), svg.getCurrentTime());
  });
}

function syncBeadClocks() {
  const els = Array.from(document.querySelectorAll('#unitbar .unit'));
  const beads = els.map((el) => {
    const svg = el.querySelector('svg.bead');
    return { slot: el.dataset.i, phase: svg ? svg.getAttribute('data-phase') : null, el, svg };
  });
  beadClockPlan(beads, _beadClock, selectedUnit).forEach((p, i) => {
    const svg = beads[i].svg;
    // `pauseAnimations` and friends are SVGSVGElement methods: a stub DOM has none of them, and a
    // bead whose atlas carried no frames has no timeline worth driving. Both degrade to a still
    // picture rather than throwing.
    if (!svg || typeof svg.pauseAnimations !== 'function') return;
    try { svg.setCurrentTime(p.time); } catch (e) { /* no timeline yet — leave it where it is */ }
    if (p.running) svg.unpauseAnimations(); else svg.pauseAnimations();
  });
}

function repaintSelectedBead(parsed) {
  const bar = document.getElementById('unitbar');
  if (!bar || bar.hidden) return;
  const units = unitList(currentIR, nucleosomeParser2);
  const u = units[selectedUnit];
  if (!u) return;
  const wrap = bar.querySelector('.unit[data-i="' + selectedUnit + '"] .bead-wrap');
  // THREE arguments. The fourth was `units.length > 1` — the very question `beadsHtml` now asks
  // `unitList` itself, left behind when `arrayMember` moved inside. Harmless, and one edit away from
  // becoming a parameter again and re-opening the divergence this pass closed.
  if (wrap) { rememberBeadClocks(); wrap.innerHTML = beadsHtml(u, true, selectedUnit); syncBeadClocks(); }
}

// Roving tabindex: ←/→ move DOM focus (a -1-tabindex element still accepts a
// programmatic .focus()); Enter/Space actually selects.
function onUnitKey(e, el, parsed, key) {
  const units = [...document.querySelectorAll('#unitbar .unit')];
  let i = units.indexOf(el);
  if (e.key === 'ArrowRight') { i = Math.min(i + 1, units.length - 1); units[i].focus(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { i = Math.max(i - 1, 0); units[i].focus(); e.preventDefault(); }
  else if (e.key === 'Enter' || e.key === ' ') { selectUnit(+el.dataset.i, parsed, key); e.preventDefault(); }
}

// A loose-monomer unit (one bare slot out of a loose bare list, e.g. focusing
// "H4:S1C" in "H3:K27M @ H4:S1C") isn't a particle: nothing to enumerate and
// nothing to measure, so both right panels simply stay hidden.
function clearArrangements() {
  document.getElementById('facets').innerHTML = '';
  clearArrangementCounts();
  document.getElementById('measbody').innerHTML = '';
  const ab = document.getElementById('arraybody'); if (ab) ab.innerHTML = '';
  const fb = document.getElementById('furtherbody'); if (fb) fb.innerHTML = '';
  syncSection('arrsel', 0);
  syncSection('nucleosomes', 0, 'measurement');
  syncSection('arrays', 0, 'measurement');
  syncSection('publications', 0);
}

// Scopes the materials/arrangements/measurements panes to the focused unit
// (unitList(parsed)[selectedUnit]).
//
// INVARIANT: for a single-unit query (one nucleosome, one histone, one bracket
// group — anything where unitList returns exactly one item), that item's
// .subtree IS `parsed` itself (units-bar.js's unitList() `else` branch), so
// this reproduces today's exact renderMaterials/renderArrangements/
// renderMeasurements calls, same world0/selectedWorld, same stale-guards, same
// materialsToken generation (all inside renderMaterials/renderArrangements,
// untouched by this function). Only when there are MULTIPLE units (an array's
// nucleosomes, or a loose bare list's slots) does this scope to a subtree
// smaller than the whole query — a nucleosome subtree still enumerates its own
// arrangements; a loose-monomer subtree isn't a particle, so arrangements are
// cleared instead of calling renderArrangements with a non-particle canonical.
async function renderFocusedPanes(parsed, key, queryInfo) {
  const units = unitList(currentIR, nucleosomeParser2);
  const u = units[selectedUnit] || units[0];
  const focus = u ? u.subtree : parsed;   // defensive: unitList() only returns [] for a null parsed
  // `describe()` is GONE (Phase 5, step 4). Its last consumer was the render-key fallback above;
  // before that the materials pane, which now reads canon's members. What it produced — a display
  // class, a physics error, a canonical string — all have v2 owners: classify2, valid2, emit2.
  // The #facets tile-click handler and renderArrangements() both read
  // currentRender.{parsed,info,key} — point it at the FOCUSED subtree so a
  // tile click re-invokes renderMaterials() scoped to this unit, not the
  // whole query.
  currentRender = { parsed: focus, key };
  // A single-unit query is always a particle from the top-level query's own
  // point of view (renderArrangements() itself shows the "wrap in ( )"/engine-
  // error placeholder when it isn't enumerable — that's today's behavior,
  // unchanged). Only a MULTI-unit query can produce a genuinely non-particle
  // focus: a loose bare-list slot, which carries no DNA.
  //
  // The test is `focus.dna != null` — a PARTICLE is the thing DNA is wrapped around, the same field
  // `classify2` reads to tell a tetramer from a tetrasome. It used to be `focus.level ===
  // 'nucleosome'`, which was a field of the v1 parse tree. `unitList` started returning v2 IR NODES
  // as `.subtree` in 535d337 (stage 3, 2026-07-25) and IR nodes have no `level`, so the test was
  // silently false for EVERY multi-unit query: `(H3K27M)(H3K36M)` cleared its own arrangements
  // panel, no world was ever selected, and the cartoon had nothing to mirror.
  const isParticle = units.length <= 1 || (focus && focus.dna != null);
  // Enumerate arrangements ONCE, up front, so a fresh query can pre-select a
  // default world BEFORE the panes render — avoiding a second interpret() and a
  // double materials paint. interp is handed to renderArrangements below, which
  // then skips its own interpret.
  let interp = null;
  if (isParticle) {
    const qIR = particleOf(unitIR2(selectedUnit));
    // The NODE, never a canonical string. `interpretWorlds` accepts either, and the string path
    // re-parses to recover exactly the node we are holding — a second derivation whose only possible
    // contribution is to disagree. If there is no node there is nothing to enumerate.
    try { interp = qIR ? interpretWorlds(qIR) : null; } catch (e) { interp = null; }
    currentInterp = interp;  // so "show more tiles" / "enumerate anyway" can re-render without re-work
    indexWorldIRs(interp, qIR);   // arr-string → world IR (tiles) + the query's glyph set C (relevance)
    // A world is ALWAYS selected for an enumerable particle — tiles are not deselectable (BB,
    // 2026-07-24). Without a world the panes fall back to the QUERY-level materials, which for a
    // partially-stated query like (H2A.Z@H2A.X) lists only the stated H2A copies while the cartoon
    // still draws a full octamer — the two disagreed. Selecting always keeps them in step.
    //
    // Default is the LOWEST C2 configuration — the least-modified dyad-symmetric world, so every
    // default stage (cartoon, arrangements, materials, measurements) opens on the same canonical
    // ground arrangement; falls back to the first enumerated world when the query has no C2
    // (inherently asymmetric, e.g. two different marks on one family). A persisted selection that no
    // longer exists among this query's tiles (a port/context switch rebuilds them) is re-defaulted
    // here rather than dropped, so the no-world state stays unreachable.
    if (interp && interp.node === 'interpretation') {
      const octs = interp.octamers || [];
      if (selectedArr && !octs.includes(selectedArr)) { selectedArr = null; selectedWorld = null; }
      if (selectedWorld == null) {
        const first = lowestC2(interp);
        if (first) { selectedArr = first; selectedWorld = worldIRFor(selectedUnit, first); }
      }
    }
  }
  const world0 = selectedWorld;         // persisted or just-defaulted selection
  // The selected octamer's cartoon mirrors the chosen world; the world is only
  // known now (renderUnitBar painted before this default), so refresh its bead.
  repaintSelectedBead(parsed);
  await renderMaterials(focus, key, world0);
  if (key !== lastKey) return;          // a newer query superseded us — don't paint stale arrangements
  if (isParticle) {
    await renderArrangements(particleOf(unitIR2(selectedUnit)), interp);   // re-applies .sel; fetches candidates
    if (key !== lastKey) return;                        // a newer query superseded us while candidates were fetching
    currentMeasurementsWorld = world0;
    renderMeasurements(world0);
    // Arrays are query-level, not tile-level: the WHOLE query's IR, since a focused unit is one
    // nucleosome and would gate every multi-particle datum out at Tier 0.
    await renderArrays(currentIR, currentRender.materials, key);
    // TWO OPERANDS, AND THE SECOND IS THE BEAD THE READER PICKED [BB 2026-08-31]. The array protects
    // the literature that matches it AS A WHOLE; the selected particle is the only one decomposed.
    // The trigger for element N is the one `componentsOf` deliberately left to the caller, and this
    // is it. Without it an array query descends into member 0 and stops: measured on
    // `({H3:K27M})-50-({H4:K16ac})`, `H4:K16ac` reached nothing and neither substrate reached at all.
    // Over the shipped universe: bead 0 → 32 descriptors, bead 1 → 21, DISJOINT, and the array
    // itself → 0, since no paper in the corpus measured that dinucleosome.
    //
    // `withoutLinker` is the engine's own, the one `unitNodes` already uses for repeated copies: the
    // unit node carries the gap to its RIGHT, and a stated linker blocks the rung-0 match against a
    // linker-free descriptor. Measured, unit 0 of that query reaches `({H3:K27M})` only once the
    // 50 bp is dropped. Dropping it here rather than in `unitNodes` keeps the bar's spacing intact.
    await renderFurtherReading(currentIR, key, unitQueryNode());
  } else {
    clearArrangements();
  }
}

// ── TYPING IS NOT AN ERROR (BB, 2026-07-25) ──────────────────────────────────────────────────────
// Every partial query is an invalid query: `(H3:K27` is on the way to `(H3:K27M)`. Blowing the stage
// away on each keystroke meant the answer you were reading vanished while you extended the thing
// that produced it, and came back a moment later — the page flickering between an answer and a
// complaint.
//
// So an invalid query REPORTS ITSELF IN THE FIELD (red frame) and otherwise changes nothing: the
// last correct response stays on screen. The error card is shown only when the user ASKS for it, by
// pressing Return — an explicit "I am done, tell me what is wrong". Any further edit withdraws the
// request, because the input is in motion again.
//
// This is a display rule, not a validity rule: the query is exactly as invalid either way, and
// `lastKey` is still cleared so that editing back to a previously-valid query re-renders.
let errorRequested = false;

// …EXCEPT WHEN THERE IS NOTHING TO PROTECT (BB, 2026-08-06). The rule above is a bargain: you lose
// the error card, and in exchange the answer you are reading survives your next keystroke. On a
// blank page there is no answer, so the bargain costs the reader everything and returns nothing —
// a first-time visitor types something wrong, gets a red frame and no reason, and has to guess that
// Return is what asks. So when the stage is empty the card reveals ITSELF, after a pause long
// enough that it is not commenting on a half-typed token.
//
// `answerOnScreen` is the test, and it is the literal question: is a rendered answer standing? Set
// where an answer is drawn and cleared where the stage is emptied — not derived from `lastQueryKey`,
// which survives an emptied query bar and would have called the blank page occupied.
let answerOnScreen = false;
const ERR_REVEAL_MS = 900;
let _errReveal = null;

// `commit` does the destructive part (error card, cleared stage); it runs only when asked.
function failSoft(raw, commit) {
  if (inputEl.value !== raw) return;                     // superseded by a newer keystroke
  inputEl.className = 'invalid';                         // the red frame, always
  lastKey = null;                                        // so re-typing a good query re-renders
  clearTimeout(_errReveal);
  // REFUSED IS ITS OWN STATE, and `showOnboarding(false)` cannot set it: that function answers one
  // question — is the field empty — and a non-empty field means 'answer' to it. It is still the
  // right call to make, because it also closes the menu and re-syncs the chip strip, which a
  // refusal wants. So the state is corrected immediately afterwards. Until 2026-09-23 it was not,
  // and a refused query sat in 'answer' with the examples hidden and a caption claiming to have read
  // it.
  const show = () => {
    showOnboarding(false);
    setPageState('refused');
    renderCanonCaption(null);
    commit();
  };
  if (errorRequested) show();
  else if (!answerOnScreen) _errReveal = setTimeout(() => {
    if (inputEl.value !== raw) return;                   // still superseded-safe on the far side
    show();
  }, ERR_REVEAL_MS);
  markReady();
}

async function onInput() {
  // The alarms this input raises are about THIS input. Cleared first, before anything can raise one,
  // so a query that now succeeds does not sit under the last one's failure. Build-scoped notices
  // (stale bundle, missing interpret3) are untouched — see engineNotice.
  clearQueryNotices();
  const raw = inputEl.value;
  if (!raw.trim()) { setEmpty(); return; }
  // FIRST, and unconditionally. This used to run at the end of a successful render, after every
  // error branch had already returned — so a rejected query left the previous query's IR on screen,
  // an inspector confidently describing something the user was not looking at. It is also the one
  // panel that can say something useful about an input the v1 gate rejects, since it reads parse2:
  // BB's `H3:K27M|K,K36ac` is refused above and fully representable here. Self-contained (parses
  // `raw` itself, try/catch inside), so calling it early costs nothing and removes the whole
  // staleness class rather than one instance of it.
  let ir = buildQueryIR(raw);
  // AN ACCESSION MOVES THE SPECIES LENS, and `adoptTaxon` is where that is decided — it owns the
  // maps and the two codes. What stays here is the consequence: the lens is an INPUT to resolve2
  // (variant sets and numbering frames are per-taxon), so if it moved, this IR answers the question
  // as it was asked BEFORE the move and has to be built again.
  const wantTaxon = queryTaxon(ir);
  if (adoptTaxon(wantTaxon)) ir = buildQueryIR(raw);
  currentIR = ir;
  // …and the text it came from, in the same breath. These are one fact — what was typed, and what
  // it means — and they were set ~50 lines apart, with every error branch returning in between. The
  // bench labels its left-hand side with `currentRaw`, so running it here while this still held the
  // PREVIOUS query would have printed a verdict about one query under the name of another.
  currentRaw = raw.trim();
  // The IR inspector stays unconditional — it is a DIAGNOSTIC, and the one panel that can say
  // something useful about an input everything else rejects. The caption is not: it names the answer
  // on screen, so it moves with the answer (below, on the valid path) and not with the keystroke.
  renderCanonicalIR(raw);
  // UNCONDITIONAL, for the same reason and by the same argument. The bench used to be re-run only
  // on the successful render path, so every error branch below returned with the previous query's
  // verdicts still on screen; now that the section's VISIBILITY is derived from `currentIR` too, a
  // rejected query would additionally have left Compare open over an IR that no longer exists.
  // Cheap: it reads `currentIR` and its own input, and returns immediately when either is missing.
  renderMeetBench();
  const parsed = ir;                                   // the panes take the IR now; the name stays
  if (!parsed) {                                       // the grammar threw → syntax
    // The error comes from the grammar that now GATES input (parse2). The "not usable here yet"
    // state this replaces is gone: after the 4a switch there is no longer a class of notation the
    // engine accepts and the views cannot render.
    // Re-parse purely to recover the grammar's own message. No v1 fallback: with the v1 bundle no
    // longer served, naming it here would have thrown ReferenceError on the one branch where the v2
    // bundle is missing — a crash reachable only when the page is already broken.
    let e = {};
    try { nucleosomeParser2.parse(raw.trim()); }
    catch (err) { e = err; }
    failSoft(raw, () => setValidity(Object.assign({ kind: 'syntax' }, syntaxError(e, raw.trim()))));
    return;
  }
  // THE REALIZATION PASS IS GONE (Phase 5, step 5). It round-tripped a bare accession or gene handle
  // through DuckDB to recover its family/variant and pin the material — work `resolve2` already does
  // synchronously, against the same tables frozen into the registry. Its only surviving product was
  // the accession pin, and `irAccessionFor` reads that straight off the IR (and already WON where the
  // two disagreed: an entry name shared across species, which the DuckDB lookup deliberately leaves
  // open). An unresolvable handle is now a resolve2 error, caught by the validity gate below.

  // A RESOLUTION ERROR names the thing that could not be resolved. It is not a physics failure, and
  // saying "not a stable assembly" about a token that names nothing would send the reader looking for
  // the wrong problem. (`currentRaw` is now set above, beside `currentIR`.) This restores what the
  // deleted realization pass used to report, from the place
  // that now decides identity.
  if (currentIR && currentIR.node === 'error') {
    // THE COPY LIVES IN copy/messages.yaml (2026-08-11), and the branching with it. This was six
    // HTML literals and a nested ternary on `r.reason`, rendering into the very card `physicsError`
    // was already feeding from the catalogue — so the page chose between eleven refusal sentences,
    // five of them editable in one file and six of them here, with nothing marking the difference.
    //
    // Three faults went with the move, all of them things a string literal makes easy to miss:
    // the residual printed `r.reason` verbatim (`position-out-of-range` as a reader-facing sentence);
    // the framed branch printed the engine's frame key, which can name an equivalence (`caH2A|H2A.1`)
    // that is not notation; and the headline named `r.mark`, which carries its own position, so
    // "No H2A can carry 130ac" stuttered against a body about residue 130.
    const card = resolveError(currentIR, currentRaw || raw.trim());
    failSoft(raw, () => renderUnitError('physics',
      `<div class="errhd">${card.head}</div>`
      + (card.body ? `<p>${card.body}</p>` : '')
      + (card.hint ? `<p class="errhint">${card.hint}</p>` : '')));
    return;
  }

  // THE PHYSICS GATE, from v2's own fixpoint: valid2(A) === (meet2(A,A) ≠ ⊥). This runs BEFORE the
  // v1 `describe().error` gate below, because the two do not agree — v1 has no notion of a repeated
  // free assembly, so `[H2A@H2B]2` reached the renderer and drew as a single dimer, quietly
  // discarding the "2". Two free H2A–H2B dimers are not one object: nothing holds them together
  // without the (H3–H4)₂ tetramer, and meet now says so (BB, 2026-07-25).
  if (currentIR && typeof nucleosomeParser2.valid2 === 'function'
      && nucleosomeParser2.valid2(currentIR) === false) {
    failSoft(raw, () => {
      // Two different refusals, and telling them apart is the difference between a usable message and
      // a shrug. A SUB-COMPLEX refusal means the molecules are fine and the GROUPING is the false
      // part, so the fix is to drop a bracket — worth saying, because the reader cannot otherwise tell
      // which of the things they wrote the engine objected to.
      // THE PAGE'S CONTEXT, PASSED (2026-08-08). This called `refusalReason(currentIR)` with none,
      // so the spoken reason was computed over every organism while the materials pane beside it
      // was computed in the reader's. It looked right only because `realize` privately substituted
      // 9606 when handed nothing; with an absent taxon now honestly ⊤, `H2A:130ac` reaches yeast
      // and worm H2A.Z under ⊤ and nothing under human — so a human reader got an empty pane and
      // no sentence explaining it.
      const why = (typeof nucleosomeParser2.refusalReason === 'function')
        ? nucleosomeParser2.refusalReason(currentIR, contextOverrideForQuery()) : null;
      // ONE CARD BUILDER, AND THE COPY LIVES IN copy/messages.yaml (2026-08-08). This was a
      // ternary over two HTML literals: `sub-complex` got its own card and EVERY other refusal got
      // "Not a stable assembly — the parts are individually fine". For an impossible MARK both
      // halves are false, and that is what the page said for `H3:K27Mme3` until `refusalReason`
      // learned to surface the chemistry verdict `residueStateError` had been computing all along.
      const card = physicsError(why);
      renderUnitError('physics',
        `<div class="errhd">${card.head}</div>`
        + (card.body ? `<p>${card.body}</p>` : '')
        + (card.hint ? `<p class="errhint">${card.hint}</p>` : ''));
      clearArrangementCounts();
    });
    return;
  }

  // Physics gate (RC3): the notation parsed, but normalize() rejected the
  // assembly (bad pairing/arity/copies/partner/tetramer/range). Route to the
  // physics-error state — the reason surfaces in the units pane (setValidity →
  // renderUnitError, which also clears the stage) — and do NOT fall through to
  // green + material cards as if valid.
  // The v1 `describe().error` gate that stood here is GONE (Phase 5). It ran v1's `normalize` on a
  // re-serialisation of the query; measured over tests/parser_cases.yaml it rejected NOTHING the
  // `valid2` gate above does not, and valid2 additionally catches an unresolvable token. Keeping it
  // meant a second physics opinion that could only ever disagree by being wrong.
  inputEl.className = 'valid';
  errorRequested = false;              // a good query settles the question the last Return asked
  clearTimeout(_errReveal);            // …and withdraws any pending self-reveal
  answerOnScreen = true;               // from here the fail-soft bargain has something to protect
  renderCanonCaption(ir);        // the caption names THIS answer, now that there is one
  // (renderMeetBench moved above, to run on EVERY input rather than only a valid one.)

  // THE FRESHNESS KEY IS THE CANON (Phase 5, item 1). Every async branch guards
  // `if (key !== lastKey) return` against this string, so it decides whether what is on screen is
  // still about what was typed. It used to be `describe().canonical` — v1's normalisation — which
  // meant the freshness of a page whose CONTENT comes from v2 was decided by the engine we are
  // retiring: two authorities, agreeing today, free to diverge on any grammar edit.
  //
  // `canonNotation` is the same string the caption and the inspector's Canon line show, so a
  // re-render is triggered by exactly what a reader would call a different query — including a
  // context switch, since canon is emitted through `abstract2` under the current context.
  //
  // Falls back to v1's canonical only when emit2 REFUSES (a construct it cannot write faithfully).
  // That is a real, narrow case rather than a silent catch-all, and it is logged.
  // `canonNotation` now returns NULL for the refusals it used to spell out as prose, so the three
  // substring sniffs that stood here are gone with them — a null is the same question asked once.
  // The key is the ELIDED canon, which is safe because the elision proves it re-canonicalises to the
  // same thing: two queries sharing an elided string share a canon.
  const canonKey = canonNotation(ir);
  const usableCanon = !!canonKey;
  // When emit2 REFUSES there is no canonical string to key on, and the honest fallback is what was
  // typed. It was `describe().canonical` — a v1 re-serialisation — which made the last consumer of
  // `describe()` a construct emit2 could not write. Raw text keys wider (two spellings of one query
  // re-render), which is the safe direction: a redundant repaint, never a stale view.
  if (!usableCanon) console.warn('render key: canon unavailable, keying on the raw text for', raw);
  const key = usableCanon ? canonKey : raw.trim();
  if (key === lastKey) return;
  lastKey = key;
  _beadCache = new Map();      // a new answer means new nodes; the old entries can only accumulate
  // …and the bead clocks with them: slot 0 of a new query is a different particle, and resuming it
  // at the previous one's position would be continuity between two unrelated pictures.
  _beadClock.clear();
  // A genuine new query (canonical text changed) resets the tile selection; a
  // same-query re-lens (port/context switch — lastKey was nulled but the
  // canonical is unchanged) keeps it, so the selected world survives.
  const newQuery = key !== lastQueryKey;
  lastQueryKey = key;
  showOnboarding(false);
  setValidity(null);
  if (newQuery) {
    selectedWorld = null; selectedArr = null; selectedUnit = 0; arrTouched = false;
    unitArr.clear();                                   // drop per-member arrangement memory
    flippedArr.clear();                                // …and which way round each tile was shown:
                                                       // an orientation is a fact about a WORLD, and
                                                       // a new query has new worlds
    expandedSecs.clear();                              // a new query re-caps its sections
    // A COLLAPSE DIES WITH ITS QUERY [BB 2026-09-24: "no; survival is per query"].
    //
    // `collapsedSubs` had no lifecycle — it was the one piece of per-query state with no reset —
    // so once a reader collapsed `Nucleosomes` it rendered collapsed for every query after it, and
    // the seeding never ran for that section again for the rest of the
    // session. The ruling is "the default applies on the FIRST render of a query; the user's
    // choice governs afterwards", and afterwards ends where the query does.
    //
    // It also clears the seeded defaults (the assay sections add their own id here on first
    // render), which is exactly right: the new query seeds its own.
    //
    // `collapsedSubs` and `section-state.js`'s `seen` memo are ONE piece of state in two stores —
    // the memo decides WHETHER a query re-seeds, `collapsedSubs` IS what gets seeded — and clearing
    // only the first meant a query revisited after another one in between (`seen` still marked it
    // "already rendered") never re-seeded at all: every section, every L2 group and every unmarked
    // material card rendered EXPANDED, against "collapsed by default". They are cleared together,
    // here, on purpose.
    collapsedSubs.clear();
    if (typeof resetSectionState === 'function') resetSectionState();
    tileLimit = TILE_CAP;                              // …and re-caps its arrangement tiles
    clearLatch(); clearSeqLatch();                     // drop measurement/sequence-highlight latches
  }
  currentRender = { parsed, key };
  // Absence model (from resolve, try/catch inside). Computed once per render and
  // read by renderMaterials/tileEl/renderArrangementCounts. null → no absence,
  // so every consumer flows exactly as before.
  absenceModel = computeAbsenceModel(currentIR);
  if (!db) { document.getElementById('subunits').innerHTML = '<p class="loading">Loading data…</p>'; return; }
  // Units bar (Task 7): renders the physical-unit selector for this query and
  // scopes the two panes to the focused unit. renderFocusedPanes() reproduces
  // today's exact renderMaterials/renderArrangements/renderMeasurements flow
  // when the query IS one unit (unitList returns a single item whose .subtree
  // is the whole query) — see renderFocusedPanes below for the invariant.
  topParsed = parsed;
  renderUnitBar(parsed, key);
  await renderFocusedPanes(parsed, key);
  markReady();                                   // valid query fully rendered — settled
}

// ── Measurements panel: native fixture + tile-coupled exact rows ───────────
// Mirrors specs/mockups/2026-07-13-shell-materials-arrangements.html's
// renderMeasurements(world)/NATIVE/EXACT block, wired to the real
// per-tile candidates (currentRender.candidates/.materials, Task 2) and the
// two-axis relevance decided here (glyph prefilter + meet2 — see glyphRelevantRows /
// markAxisAccepts) instead of the mockup's placeholder EXACT array. The v1 matcher this panel used
// to call (relevance-model.js) is retired to tests/js/fixtures/ as the oracle's v1 side.

// Query-level union of all asserted modifications across materials, in the
// {family, position, mod_value} shape entails.js expects. A native/population
// datum attaches to the whole query, so it's gated against THIS set (not a
// single tile's mods). Also the shape the has-data dots build (renderArrangements).
function queryUnionMods(materials) {
  const mods = [];
  (materials || []).forEach(m => {
    (m.mods || []).forEach(md => {
      // THE LETTER TRAVELS WITH THE MARK, and so does the token. Under R5 the wild-type letter is
      // what IDENTIFIES the column — without it `markLookup` falls to the all-twenty residue set and
      // `H2A:S139ph` answers column 154 instead of γH2A.X's 177. `queryLayers` was fixed for exactly
      // this; these two consumers — the Arrays pane and the arrangement has-data dots — were not, so
      // one card could show the right AlphaMissense rows beside dotless tiles.
      mods.push({ family: m.family, position: md.position, frame: m.frame ?? null,
                  variant: m.variant ?? null, residue: md.residue ?? null,
                  modification: md.modification ?? null,
                  mod_value: md.substitution ?? md.variant ?? md.modification ?? null });
    });
  });
  return mods;
}

// Tracks the world last passed to renderMeasurements(), so the delegated
// #measbody click handler can re-render without needing the triggering
// event to carry the current tile selection.
let currentMeasurementsWorld = null;
// Measurement groups by id for the current render, so the highlight handlers can
// re-derive a row's overlay without re-querying. Rebuilt every renderMeasurements.
let measGroups = new Map();
function registerMeasGroups(groups) {
  measGroups = new Map((groups || []).map(g => [String(g.mid), g]));
}
function measGroupById(mid) { return measGroups.get(String(mid)) || null; }
// Match mode. `broaden` true → compatible2; false → entails2 (see markAxisAccepts / entailsWorld).
// DEFAULT is compatible (discovery): a family-open query like
// ([H3:K27M]2) is variant-open, so under strict entails it could not reach a
// variant-specific measurement ([H33-K27M]) — the query is LESS specific than the
// datum, so it entails nothing, hiding real data. Compatible (meet ≠ ⊥) shows every
// measurement consistent with the query and still rejects mutually-exclusive marks
// (K27ac, S28ph). entails is the opt-in tightening. (compatible = discovery default,
// entails = opt-in — per the material-layer matching decision, 2026-07-18.)
let broaden = true;

// THE PANEL'S MODEL HALF IS IN `measurements-model.js` (U8, 2026-08-15): `effectBar`, `condOf`,
// `condGloss`, `makeGroup`, `measMarks` — and `measConfident`/`measRank` below. What stays here is
// the markup that shows a reader their answers. The panel genuinely cuts across the model boundary;
// moving it whole would have carried the untested judgements and the text-sliced markup together.
// The measurement's material as a DESCRIPTOR — the same thing the cartoon caption shows, produced
// the same way: `canonCaption(relevance.datumIR(notation))`, i.e. emit2 over the canonical IR.
//
// It used to be a REGEX over the stored string:
//
//     const groups = notation.match(/\[[^\]]*\]\d*/g);
//     const marked = groups.filter(s => /[-:]/.test(s));   // keep only marked subunits
//     if (marked.length) return `(${marked.join('')})`;
//
// which was a fourth opinion about how to write a particle down, next to emit2, the caption and the
// panel — the very shape the caption's own note (see `canonCaption`) records removing. Two costs:
// two containers spelling one idea differently rendered differently, since nothing normalised; and
// the elision was UNGUARDED, so dropping the unmarked subunits could rename the particle. A
// penta-acetyl octamer came out `([H2B…]2)`, which read as notation names a particle of two H2B and
// nothing else — in a span whose whole premise is that it is canonical.
//
// `canonCaption` elides too, but conditionally: never when an absence is stated, and never when
// nothing informative would survive. So the row stays short without ever naming a different thing.
//
// The parse is already paid for — `datumIR` is memoised and every one of these notations is lifted
// anyway to decide relevance via entails2. Only canon2+emit2 are new, hence the memo here.
// MATERIAL, NOT ABSTRACTED (BB, 2026-07-29). This used to route the datum through `abstract2`, which
// restated it on the idea layer — for the yeast container that turned the measured K123 into K120,
// i.e. printed a residue number the experiment was not performed at, under a token naming a class
// rather than the molecule. A measured datum is displayed on its own material; the query's frame has
// no business rewriting it. Relevance is unaffected — that is decided from the same IR on idea
// coordinates by `entails2`, one layer away from anything shown here.
const _measDescriptor = new Map();
function measMarkCanonical(g) {
  const notation = g.meta && g.meta.notation;
  if (!notation) return measMarks(g);
  // Keyed by (notation, taxon): the same descriptor read under a different organism resolves to a
  // different molecule and therefore to a different material spelling.
  const taxon = relevance.measurementTaxon(g.rows);
  const memo = notation + '\u001f' + (taxon == null ? '' : taxon);
  if (!_measDescriptor.has(memo)) {
    let d = null;
    try {
      const ir = relevance.datumIR(notation, taxon);
      d = ir ? styleNotation(ir, { material: true }) : null;
    } catch (e) { d = null; }
    // A refusal falls back to the DEPOSITED string, not to nothing: the stored notation is still
    // true, merely unnormalised, and 7 of the 247 stored descriptors are vocabulary gaps the parser
    // cannot take. Showing the raw spelling beats showing a mark list that drops the composition.
    _measDescriptor.set(memo, d || notation);
  }
  return _measDescriptor.get(memo);
}

// One measurement row: [kind] · Mark · Condition · Effect bar (+value) · Std.err · Source.
// `sec` carries the shared section axis: maxAbs (bar scale), and subjectHoisted/unitHoisted
// (enzyme + unit shown once in the section head when uniform, so the row stays lean).
function measRowHtml(g, sec) {
  sec = sec || {};
  const meta = g.meta, r0 = g.rows[0], est = +r0.estimate, unit = r0.unit;
  const native = g.certainty === 'native';
  const canon = measMarkCanonical(g) || meta.notation || meta.entry_key || '&mdash;';
  // Hover carries the DEPOSITED notation — the machine-truthful spelling, unelided. The visible
  // descriptor is for reading; this is what the datum actually says, and it is the form you can type
  // back into the bar: the styler prints `([H2A]₂[H2B]₂…)`, and subscripts cannot be typed.
  //
  // …EXCEPT WHERE THE TWO ARE THE SAME STRING [BB 2026-08-11]. Measured over the 294 distinct
  // notations in the shipped table, 279 differ from their styled form and 15 do not — for those the
  // tooltip was `(H2A.Z)-30-(H2A.Z)` hovering to `(H2A.Z)-30-(H2A.Z)`. The audit read one of the 15
  // and concluded the tooltip always repeated itself; it earns its place on the other 279.
  const deposited = meta.notation ?? measMarks(g);
  const repeats = String(deposited) === String(canon).replace(/<[^>]*>/g, '');
  // THE DESCRIPTOR IS THE ROW'S IDENTITY LINE [BB 2026-09-23], not its first column. It is by far
  // the longest thing in a measurement row — a whole canonical particle — and as a 31%-wide cell
  // under `table-layout: fixed` it was clipped mid-token on a phone with nothing to say so.
  const markIdent = `<span class="descriptor descriptor--cell meas-canon"`
    + `${repeats ? '' : ` title="${deposited}"`}>${canon}</span>`;
  // THE ENZYME PREFIXES THE MATERIAL, IT DOES NOT SOURCE IT [BB 2026-09-24: "The name of the
  // enzyme in measurement tables (remodelers) should not end up in the source column, perhaps
  // prefixed to the material: `ACF · (H3)2`"]. `meta.subject` is who ran the assay on the
  // material, not where the row was published — that is `meta.pmid`, `.msource`'s own fact — so
  // the two were sharing a column for no reason but proximity. `sec.subjectHoisted` is the same
  // gate `.msource` already used: a section where every row agrees drops the value from every row
  // and states it once in the section head, so repeating it here would be the column it just left.
  const subjectPrefix = sec.subjectHoisted ? null : meta.subject;
  // Condition is its own clipped column (e.g. ATP+/ATP−) ONLY WHERE IT VARIES. A section whose rows
  // all read ATP+ was spending a column of every row restating the section, which is what the
  // subject and unit hoists already avoid — same idiom, third axis.
  const cond = condOf(meta);
  // THE TOOLTIP SAYS WHAT THE WORD MEANS, or there is none [BB 2026-08-11]. It was `title="${cond}"`
  // on a cell whose whole content is `cond` — `ATP+` hovering to `ATP+`, which is the shape that
  // teaches readers tooltips are not worth opening. The glosses live in copy/messages.yaml under
  // `conditions:`; a value with no gloss gets no tooltip, because containers name their own arms and
  // this list cannot be complete.
  const condTip = condGloss(meta);
  const condTd = sec.condHoisted ? ''
    : `<td class="mcond"${condTip ? ` title="${condTip}"` : ''}>${cond || '&mdash;'}</td>`;
  const bar = effectBar(est, sec.maxAbs, { lfsr: meta.lfsr, se: meta.std_error, unit, unitHoisted: sec.unitHoisted });
  // Mock data carries pmid "mock". It is NOT a measurement and must never read as one, so the
  // citation slot becomes an explicit badge rather than the word "mock" sitting where a PMID goes.
  //
  // THE BADGE NAMES NO HOME [BB 2026-08-11]. It said "design fixture (tests/fixtures/future-datasets)", which
  // stopped being true when the three data/MOCK-* containers declared their citation and started
  // badging — a third of the badged rows do not live there. Two sources, one badge, one sentence.
  //
  // AND THE SENTENCE STAYS, rather than the badge standing alone. "Mock" is a term of art in this
  // field — mock IP, mock-treated, mock transfection are all real controls — so a bare `mock` beside
  // an effect size reads as a mock-treated SAMPLE, which is data, exactly where it must read as
  // fabricated numbers, which are not. The one misreading the badge exists to prevent is the one the
  // word alone invites.
  const isMock = String(meta.pmid ?? '').toLowerCase() === 'mock';
  const source = [isMock ? null : meta.pmid].filter(Boolean).join(' · ');
  const mockBadge = isMock
    ? `<span class="mockbadge" title="fabricated data — not a measurement">mock</span>`
    : '';
  // A FILE PATH IS NOT USER COPY [BB 2026-08-11]. This hovered to
  // `PMID28767641-ACF/fitted_l2fc-PTM.csv · BC011` — the container-relative CSV the row was parsed
  // from, on all 1,233 rows that carry one. The reader cannot open it, and the cell already says
  // the citation (the enzyme moved to the identity line, above); the only part they can use is the
  // barcode, which names WHICH SAMPLE in a library the effect came from.
  //
  // Measured: 1,193 of the 1,233 have a barcode. The 40 that do not are the tests/fixtures/future-datasets
  // fixtures, which are badged `mock` anyway — so they lose a tooltip that was telling them the name
  // of a file inside this repository.
  const srcTitle = meta.sample_barcode ? `Sample ${meta.sample_barcode}` : '';
  const src = `<td class="msource"${srcTitle ? ` title="${srcTitle}"` : ''}>${source || (isMock ? '' : '&mdash;')}${mockBadge}</td>`;
  const rowCls = [native ? 'ensemble' : null, isMock ? 'mockrow' : null].filter(Boolean).join(' ');
  // THE CLASSES GO ON THE GROUP AND `data-id` ON THE DATA ROW. `.ensemble` and `.mockrow` describe
  // the DATUM, so they tint both of its lines; `data-id` is what `#measbody tr[data-id]` addresses
  // for hover and `.meas-xref` banding, and moving it off a `<tr>` would stop every one of those
  // selectors matching with no error to say so.
  const cells = `${condTd}<td class="meas-effect">${bar}</td>${src}`;
  return rowPair(identityLine(markIdent, null, null, subjectPrefix), cells, sec.condHoisted ? 2 : 3,
                 { cls: rowCls, rowAttrs: ` data-id="${g.mid}"` });
}

// One assay-type section: a collapsible subhead + its own table (each table's rows share
// one axis). The head hoists the shared axis definition (enzyme · unit) when uniform,
// leaving the rows lean; the table reuses renderLayerTable so it wears the SAME chrome
// (colgroup alignment, sticky cool header) as the mass/AM tables in the left column.
// ── Render cap ──────────────────────────────────────────────────────────────────────────────────
// A mark-less query is ⊤ on the mark axis, so "(H3)" legitimately denotes every nucleosome we hold —
// the correct answer is ~1,200 measurements, which is a correct answer nobody can read. The cap is a
// RENDER limit only: the relevance set is complete, and the section header always states the true
// total, because a silent truncation reads as "that is all there is" (the same failure as the display
// cap that once truncated the glyph set C).
const SECTION_CAP = 25;
// Sections the user has expanded, by assay-type token. Survives re-renders within a query.
const expandedSecs = new Set();

// `ALPHA`, `measConfident` and `measRank` moved with the rest of the model half (U8). The ranking
// rule is a claim about which measurements can be trusted, which is not a question about markup.
// `scope` IS PART OF A SECTION'S IDENTITY [2026-09-24 review], and it did not use to be. Arrays and
// Nucleosomes render the SAME assay types through this one builder, so `meas|ptm` named two
// different sections — collapsing "PTM deposition" under Nucleosomes collapsed it under Arrays on
// the next render, and "Show more" expanded both. That was invisible while the two lived in
// separate cards one above the other; the spine renders them as visible peers, so it is now a
// section closing itself in front of the reader.
//
// Defaulted, because `measurement-render.test.js` drives this builder directly and the scope is a
// fact about WHERE it is being rendered, not about the section.
function renderTypeSection(sec, scope) {
  scope = scope || 'nuc';
  const rank = (xs) => [...xs].sort(measRank);
  const all = [...rank(sec.native), ...rank(sec.exact)];
  const secKey = scope + '|' + sec.token;
  const expanded = expandedSecs.has(secKey);
  const groups = expanded ? all : all.slice(0, SECTION_CAP);
  const hidden = all.length - groups.length;
  let maxAbs = 0; const subjects = new Set(), units = new Set(), conds = new Set();
  // The effect-bar scale is normalised over the WHOLE section, not the rendered slice — otherwise
  // expanding would silently rescale every bar already on screen.
  for (const g of all) {
    const v = Math.abs(+g.rows[0].estimate);
    if (isFinite(v)) maxAbs = Math.max(maxAbs, v);
    if (g.meta.subject) subjects.add(g.meta.subject);
    if (g.rows[0].unit) units.add(g.rows[0].unit);
    conds.add(condOf(g.meta));
  }
  const subjectHoisted = subjects.size === 1 ? [...subjects][0] : null;
  const unitHoisted    = units.size === 1 ? [...units][0] : null;
  // Hoisted only when every row agrees AND there is something to say: a section where no row states
  // a condition hoists nothing (there is no fact), but it still drops the column, because a column
  // of em-dashes is the emptiest thing a table can hold.
  const condHoisted    = conds.size === 1 ? [...conds][0] : null;
  const condColumn     = conds.size > 1;
  const secCtx = { maxAbs: maxAbs || 1, subjectHoisted, unitHoisted, condHoisted: !condColumn };
  const body = groups.map(g => measRowHtml(g, secCtx)).join('');

  const subId = 'meas|' + secKey;
  // COLLAPSED BY DEFAULT [BB 2026-09-24]: "since these are quite extensive, I'd have measurements
  // collapsed by default". A section can hold hundreds of rows, and several sections stacked open
  // put the materials and the literature below them out of reach on a phone.
  //
  // SEEDED, like every other default on the spine: add the id to `collapsedSubs` on the query's
  // first render. `firstRenderOf` is what makes it once — seeding every render would re-collapse a
  // section the reader had just opened.
  if (typeof firstRenderOf === 'function' && firstRenderOf(subId, queryKeyOrNull())) {
    collapsedSubs.add(subId);
  }
  const collapsed = (typeof collapsedSubs !== 'undefined' && collapsedSubs.has(subId)) ? ' collapsed' : '';
  // THE HEAD AND ITS TABLE HEADER ARE ONE OBJECT [BB 2026-09-25, `specs/2026-09-25-one-object-heads.md`
  // Ruling 1, SUPERSEDES the 2026-09-24 ruling below]. BB, reading the served page: "it would be
  // clearer for the user if the heading and the header column were merged, so clicking on the header
  // doesn't use the toggle, but vertical stretch/unrolling of the element. This also allows the first
  // header column to carry all information upon unfolding such as 'log2 fold-change' and the 'Show
  // all/show fewer' as necessary." The `<h4>` stays — it is the only structural outline this page has
  // — but the head now carries only what decides whether to open: the name and the count. The axis
  // meta and `Show all`/`Show fewer` move DOWN into the table's own header band (built below), which
  // is revealed with the body when the section unfolds — nothing here is rewritten on toggle, the
  // band is simply part of the collapsible region.
  const metaBits = [subjectHoisted, unitHoisted, condHoisted].filter(Boolean).join(' · ');
  // COUNT STAYS IN THE HEAD [BB 2026-09-25]: "the count STAYS there — it is how a reader decides
  // whether to open." `.meas-sec-foot` and the 2026-09-24 single-line-head argument that preceded
  // this are moot; see the head assembly below for what remains.
  //
  // SINGULAR AT 1 [BB]: "PTM deposition 1 measurement", not "1 measurements".
  //
  // THREE ROWS, AND EACH ANSWERS ONE QUESTION [BB 2026-09-25, SUPERSEDES the shown-of-total that
  // stood in this head until now]: "Row 1 should say 'XXX measurements', then row 2: '(metadata) ·
  // 25 of XXXX shown (show all)', then the header + table."
  //
  // So the HEAD states how much there IS — the fact a reader decides whether to open on, and it
  // does not change when they press `Show all`. The BAND states how much is DRAWN, next to the
  // control that changes it, because that is the number the control moves. Carrying the drawn count
  // in the head made the two read as one fact and put a number that changes under a press in the
  // one line that must stay still while the section is shut.
  const truncatedOrExpanded = hidden > 0 || expanded;
  const totalHtml = `${all.length.toLocaleString('en-US')} measurement${all.length === 1 ? '' : 's'}`;
  const shownHtml = truncatedOrExpanded
    ? `<span class="meas-sec-shown">${groups.length.toLocaleString('en-US')} of `
      + `${all.length.toLocaleString('en-US')} shown</span>`
    : '';
  // THE DEFECT THAT MOVED THIS CONTROL [BB 2026-09-25]: "a user could click 'show all' and nothing
  // happened when the column was not shown." In the head this button was visible and pressable while
  // the section was COLLAPSED, and its entire effect was to draw more rows into a hidden body — the
  // press was accepted and did nothing, the worst answer a control can give. Built here, alongside
  // `metaBits`, and handed to `renderLayerTable` as an extra header row (`extraHeadRow`) that sits
  // INSIDE the table — the same object the section's collapse rule (`.sub-toggle.collapsed + *`)
  // already hides wholesale, so the state where a press does nothing cannot be reached.
  const moreBtn = (hidden > 0)
    ? `<button type="button" class="meas-more" data-sec="${secKey}">Show all</button>`
    : (expanded && all.length > SECTION_CAP)
      ? `<button type="button" class="meas-more" data-sec="${secKey}">Show fewer</button>` : '';
  const head = `<div class="subhd sub-toggle${collapsed}" data-sub="${subId}">`
    + `<h4 class="meas-sec-label">${sec.label}</h4>`
    + `<span class="meas-sec-total"><span class="meas-sec-count">${totalHtml}</span></span>`
    + `${CARET_HTML}</div>`;

  // Fixed widths so Mark / Condition / Effect / Source align vertically across every section table.
  // Condition is CONDITIONAL, so the widths are stated per case rather than as one list with a hole
  // in it: two tables in one panel that disagree about which column is which would be worse than
  // either width.
  // The leading kind-glyph column is GONE (BB, 2026-07-30). It spent 22px on every row to say
  // "defined" — which is the ordinary case and therefore no information — so that the rare native
  // row could be told apart. That distinction still holds without a column of its own: a native row
  // is tinted (`tr.ensemble`), being the whole-query baseline rather than something you attach or detach.
  // MATERIAL, not "Mark" [BB 2026-08-06]. The cell holds `measMarkCanonical` — the canonical
  // descriptor of the thing measured, `([H2A]2[H2B]2[H3]2[H4:K16ac]2)` and not `K16ac` — so "Mark"
  // named the axis the row was FOUND on rather than what the column shows. A datum with no mark at
  // all (a linker series, an unmodified control) has a descriptor and no mark, and read as a blank
  // under the old heading.
  //
  // The widths are `measFrame`'s (render.js), shared with the Arrays card below this panel.
  const columns = measFrame(condColumn ? 'Condition' : null);
  // THE HEADER BAND'S OWN FULL-WIDTH ROW [BB 2026-09-25]: the axis meta and the show/hide control,
  // spanning every column — the same full-width-cell idiom `identityLine`/`rowPair` already use one
  // row down, so the table's header reads as the same kind of thing as its body. Empty when a
  // section hoists nothing and holds nothing back (the ordinary Publications case), so the plain
  // mass/AM/literature shape is unchanged.
  const axisCell = [metaBits ? `<span class="meas-sec-meta">${metaBits}</span>` : '', shownHtml, moreBtn]
    .filter(Boolean).join('');
  // THE FLEX GOES ON A WRAPPER, NEVER ON THE `<th>` [BB 2026-09-25: "the second metadata column
  // should span the entire table"]. `display: flex` on a table cell takes it OUT of table layout —
  // it stops being a cell, so `colspan` is ignored and the box shrinks to its content. Measured on
  // the served page: the band drew 445px wide inside a full-width table, with the header ground
  // showing past its right edge, while the markup's colspan was correct the whole time (and
  // `table-shape.test.js` rule 5b says so). The cell stays a cell; the row inside it does the flex.
  const axisRow = axisCell
    ? `<tr class="meas-axis-row"><th colspan="${columns.length}">`
      + `<span class="meas-axis-inner">${axisCell}</span></th></tr>`
    : '';
  return `<div class="meas-section">${head}${renderLayerTable(columns, body, { extraHeadRow: axisRow })}</div>`;
}

function groupByMeasurement(rows) {
  const byMid = new Map();
  for (const r of rows) {
    const mid = String(r.measurement_id);
    if (!byMid.has(mid)) byMid.set(mid, []);
    byMid.get(mid).push(r);
  }
  return byMid;
}

// world: the selected tile's world IR, or null.
// Measurements are grouped into assay-type SECTIONS (data/SCHEMA.md §1); within a
// section, exact rows are matched to the selected arrangement on both axes (glyph prefilter →
// meet2 verify), native rows attach whole-query. No fake fixture — only real deposited data flows here.
function renderMeasurements(world) {
  currentMeasurementsWorld = world;
  const measbody = document.getElementById('measbody');

  const groups = [];
  const seen = new Set();

  let onThisWorld = 0;
  if (world && currentRender.candidates) {
    // Shape axis, then mark axis (see glyphRelevantRows / markAxisAccepts). The meet runs ONCE PER
    // MEASUREMENT, not per lookup row — a screen deposits one row per mark, and they all share the one
    // descriptor whose IR the relation actually consumes.
    const entailed = relevance.glyphRelevantRows(currentRender.candidates, selectedArr);
    for (const [mid, rows] of groupByMeasurement(entailed)) {
      if (seen.has(String(mid))) continue;
      if (!relevance.columnAxisAccepts(rows)) continue;      // cheap pre-stage for the meet below (strict only)
      if (!relevance.markAxisAccepts(rows, selectedArr)) continue;
      groups.push(makeGroup(mid, rows));
      seen.add(String(mid));
      onThisWorld++;
    }
  }

  // Record the flat group list so hover/latch can re-derive a row's overlay.
  registerMeasGroups(groups);

  // The measurements panel reveals itself only when it has assay sections to
  // show; with none, it stays hidden rather than displaying an empty box (the
  // assay-type sections carry their own headings, so there is no panel header).
  const sections = groupMeasurementsByType(groups);
  // An empty measurement set clears the body but must NOT hide the section — an empty scope header
  // stays and shows 0 [BB 2026-09-23], and the arrangement selector above it is meaningful either
  // way.
  // An ARROW, not a bare reference: `map` passes (item, index, array), so `sections.map(
  // renderTypeSection)` would hand the index in as `scope` and every section after the first would
  // be keyed `1|ptm`, `2|ptm`, … — a fresh identity on every render.
  measbody.innerHTML = sections.length
    ? sections.map((sec) => renderTypeSection(sec, 'nuc')).join('') : '';
  // THE SECTION IS `hidden` IN THE MARKUP UNTIL SOMETHING UNHIDES IT, and this is the only place
  // that can: `#sect-nucleosomes` ships hidden so it cannot flash before the first query settles.
  // Without this call the measurements rendered into a box nobody ever showed — the panel was
  // simply absent, with no error anywhere. The COUNT is groups, not sections: a reader counts
  // measurements, and the assay-type split is how they are arranged rather than how many there are.
  syncSection('nucleosomes', groups.length, 'measurement');

  // A latched sequence highlight (seqSel) must survive a #measbody rebuild — the
  // innerHTML reset above wiped its .meas-xref bands. Mirror the measSel guard in
  // renderMaterials. (repaintSeq re-derives from the fresh measGroups.)
  if (seqSel.size || seqHover != null) repaintSeq();
}

// ── Arrays ──────────────────────────────────────────────────────────────────────────
// Measurements whose datum spans MORE THAN ONE particle (particle_count >= 2). These can never attach
// to an arrangement tile: a tile is one nucleosome's shape and an array datum carries an EMPTY
// glyph_mask, so the glyph matcher rejects it by construction. They are retrieved instead by the
// particle_count-aware three-tier query — Tier 0 gates on q.pc >= d.pc — which is the path array data
// needed all along (queryThreeTier had been written and left unwired).
//
// The IR handed in is the WHOLE query, not the focused unit: an array datum only survives Tier 0 when
// the query itself spans >= 2 particles, and the focused unit is a single nucleosome (pc 1).
let arraysToken = 0;
// The groups from the last SUCCESSFUL fetch, so `.meas-more` (below) can redraw the card without a
// round trip — the cap toggle is a display decision, not a new question [2026-09-26 review, finding
// 2]. `renderMeasurements` never needed this because it already re-derives from `currentRender.
// candidates`, which the query keeps in memory; Arrays has no such in-memory candidate set (it is
// fetched by particle_count, not by glyph match), so this is its equivalent.
let lastArrayGroups = [];
async function renderArrays(queryNode, materials, key) {
  const host = document.getElementById('arraybody');
  if (!host) return;
  const gen = ++arraysToken;
  const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
  let groups = [], failure = null;
  if (P && queryNode) {
    try {
      // The SHARED object, handed in. It used to take a canonical STRING and re-parse it when
      // `currentIR` happened to be unset — a path that could only ever produce a second opinion
      // about the same query.
      const queryIR = queryNode;
      // Tier 0 is q.pc >= d.pc and an array datum has d.pc >= 2, so a single-particle query can never
      // admit one. Asking anyway is not merely wasteful, it is the whole cost: the query then reduces
      // to "every measurement with particle_count <= 1", i.e. the entire material layer.
      const qpc = (typeof queryParticleCount === 'function') ? queryParticleCount(queryIR) : 2;
      if (qpc < 2) { lastArrayGroups = []; host.innerHTML = ''; syncSection('arrays', 0, 'measurement'); return; }
      groups = await queryThreeTier(queryIR, queryUnionMods(materials || []),
                                    { mode: broaden ? 'compatible' : 'entails', minParticleCount: 2 });
    } catch (e) {
      // Surfaced, not swallowed: an empty Arrays card and a BROKEN Arrays card look identical
      // otherwise — the same silence that hid the Firefox engine failure for a whole session.
      groups = []; failure = (e && e.message) || String(e);
    }
  }
  if (failure) {
    // A BROKEN CARD AND AN ABSENT ONE MUST NOT LOOK ALIKE — the same rule `pubSync` states above:
    // "Surfaced, never swallowed: an empty card and a broken card look identical otherwise."
    // `hasContent=true` is what keeps `count===0` from reading as `is-empty` and refusing to open.
    lastArrayGroups = [];
    syncSection('arrays', 0, 'measurement', true);
    host.innerHTML = `<p class="al-meta">Could not load array measurements: ${escapeHtml(failure)}</p>`;
    return;
  }
  if (key !== lastKey || gen !== arraysToken) return;        // stale-guard, same discipline as the rest
  lastArrayGroups = groups;
  renderArraysBody(groups);
}

// ── IT IS ANOTHER #measbody [BB 2026-08-06] ───────────────────────────────────────────────────
// "each measurement on arrays should be constructed the same way as it is constructed for
// arrangements… just replicate another measbody under arraypanel."
//
// So this card no longer builds a table. It runs the SAME three steps the measurements panel runs
// — makeGroup, groupMeasurementsByType, renderTypeSection — and everything those already do comes
// with them: the assay-type subsection head, the count, the subject/unit/condition hoists, the
// confidence ranking, the effect bar normalised over the whole section, the mock badge, and the
// column frame. "Arrays" is the PANEL head; each assay type gets its own subsection under it.
//
// What this replaced was a hand-built table that had drifted on every one of those: its own
// widths, its own two extra columns, its own scale notation in a column header, and no hoist at
// all — so a 29-character unit was printed once per row and the table ran off the panel sideways.
// A second table pretending to be the first is how that happens; there is now only the first.
//
// NOT registered with `registerMeasGroups` — that is `#measbody`'s own datum-row bookkeeping
// (hover/xref highlighting), which this panel does not need. `.meas-more` IS built by
// `renderTypeSection('arr', …)` exactly as it is for `#measbody`, and IS wired below — see the
// delegated handler after this function [2026-09-26 review, finding 6, corrects the paragraph
// this replaces]. That paragraph asserted "no `.meas-more`" on the strength of the shipped array
// data staying under `SECTION_CAP` (25); it is true of today's ~10 rows and was never true of the
// markup, which emits the button unconditionally once `hidden > 0`. Without its own handler an
// array section that DID cross the cap shipped exactly the defect this week's work removed: a
// visible, pressable "Show all" whose click landed nowhere, because the only `.meas-more` listener
// was bound to `#measbody`, a sibling container the click never bubbles into.
//
// SPLIT OUT OF `renderArrays` [2026-09-26 review, finding 2] so `.meas-more` (below) can redraw the
// card from GROUPS ALREADY FETCHED, the same way `#measbody`'s twin re-renders from
// `currentMeasurementsWorld` instead of re-deriving its candidate set. `renderArrays` itself still
// calls this once its fetch lands; it is the only caller that may pass anything other than
// `lastArrayGroups`.
function renderArraysBody(groups) {
  const host = document.getElementById('arraybody');
  if (!host) return;
  const arrays = groups.filter(g => (Number(g.particle_count) || 0) >= 2);
  if (!arrays.length) { host.innerHTML = ''; syncSection('arrays', 0, 'measurement'); return; }
  const sections = groupMeasurementsByType(arrays.map(g => makeGroup(g.measurement_id, g.rows)));
  host.innerHTML = sections.map((sec) => renderTypeSection(sec, 'arr')).join('');
  syncSection('arrays', arrays.length, 'measurement');
}

// THE ARRAYS PANEL'S OWN `.meas-more` HANDLER [2026-09-26 review, finding 6]. `renderTypeSection`
// builds the SAME button markup for both hosts (`data-sec` carries the `arr|`/`nuc|` scope already
// — see the note above `renderTypeSection` on why scope is part of a section's identity), but the
// `#measbody` listener below only ever re-renders `#measbody`; a click on an array section's button
// toggled `expandedSecs` (the one shared store) and then rendered nothing new, because the array
// card was never told to redraw. This mirrors that handler exactly, scoped to `#arraybody` —
// EXCEPT for what it calls to redraw: `renderArrays` re-issues the whole `queryThreeTier` round trip
// for a display-cap toggle, and its result can DIFFER from what is on screen if `broaden` or the
// query context moved in the meantime — surfacing "Could not load array measurements:" in answer to
// a press that only asked for more rows [2026-09-26 review, finding 2]. `renderArraysBody` redraws
// from the groups that fetch already returned, exactly as `#measbody`'s handler redraws from
// `currentMeasurementsWorld` rather than re-querying.
document.getElementById('arraybody').addEventListener('click', (e) => {
  const more = e.target.closest('.meas-more');
  if (!more) return;
  const tok = more.dataset.sec;
  if (expandedSecs.has(tok)) expandedSecs.delete(tok); else expandedSecs.add(tok);
  renderArraysBody(lastArrayGroups);
});

// ── FURTHER READING ──────────────────────────────────────────────────────────────────────────────
// The literature pointer. Unlike every other card on this page it shows nothing MEASURED: a row says
// a paper mentions the query's object, and nothing about what it found.
// specs/2026-08-15-tier1-corpus-sweep.md
//
// Relevance is COMPUTED, not enumerated — the meet decides which stored descriptors a query reaches,
// so the box needs no list of "queries this paper answers". The descriptor universe is BOTH tables:
// mentions hold what a paper NAMES, papers hold what it was measured ON, and a particle does not
// entail a bare proteoform — so a nucleosome query matches only the substrate column.
let furtherToken = 0;
let furtherUniverse = null;                 // the distinct descriptors, fetched once
let furtherKeyIndex = null;                 // descriptor -> family:column keys, the fast prefilter
let furtherFilter = 'all';                  // the data-availability toggle [BB 2026-08-16]
// The selected bead as a standalone particle: the unit node with the linker that trails it dropped.
//
// A LONE PARTICLE COSTS NOTHING, and it is the common case, so it must not double the reach. Two
// guards, and they catch different shapes: `u === currentIR` catches a bare proteoform, where
// `unitNodes` hands back the very node it was given; an array-of-one (`({H3:K27M})`) is NOT caught
// here — the unit is the member and the query is the wrapper — and is deduped a step later, on the
// canonical STRING, which the two spell identically. Measured: `({H3:K27M})`, `H3:K27M` and `(H3)3`
// each collapse to one operand; only a genuine multi-particle query pays for the second.
function unitQueryNode() {
  try {
    const u = unitIR2(selectedUnit);
    if (!u || u === currentIR) return null;
    const P = nucleosomeParser2;
    const bare = (typeof P.withoutLinker === 'function') ? P.withoutLinker(u) : u;
    return particleOf(bare) || null;
  } catch (e) { return null; }
}

let furtherLast = null;                     // {queryNode, unitNode} so the toggle can re-run the query

// ONE MODEL INSTANCE FOR THE SESSION. It was built fresh inside every render, which threw away the
// descriptor→IR cache on each query — and with it the engine's own memos, which are WeakMap-keyed on
// node identity and so can only hit while the nodes survive. The instance holds only derived state
// (the IR cache, the relevance memo, the key index, all keyed by descriptor STRING), so it cannot go
// stale against a query, and `loadKeyIndex` is re-applied per render anyway.
//
// WHAT IT DOES AND DOES NOT BUY, measured over the shipped 3,686-descriptor universe. It removes the
// parse (777ms of a cold `({H3:K27M})`) and the memo misses under it, and it makes a repeated query
// free. It does NOT make the next particle query fast: `({H3:K27me3})` still costs 2,259ms and
// `({H4:K16ac})` 3,134ms on a warm instance, because the cost is `reach2` and it is paid per
// (datum, query) pair. Bare proteoform queries are 8ms — their prefilter keeps a small set.
// See the note on `relevantDescriptorsAsync` for where the 2.5s actually goes; it is eight datums.
let furtherModelInstance = null;
function furtherModel() {
  // A GETTER, NOT A CAPTURED VALUE. The model reads its host as `host[name] !== undefined ? … : root`,
  // and `null !== undefined` — so passing a literal null once would pin a null engine for the life of
  // the session, and the box would silently show nothing forever. Per-render construction used to
  // recover on the next query; caching the instance is what made a first-render null permanent.
  // Returning `undefined` instead lets the model fall through to the global, and it is re-read every
  // time rather than frozen at construction.
  if (!furtherModelInstance) {
    furtherModelInstance = createFurtherReading({
      get nucleosomeParser2() {
        return (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : undefined;
      },
    });
  }
  return furtherModelInstance;
}

// The universe AND its column keys, fetched once. The keys are the fast prefilter: without them the
// meet ran over all 540 descriptors on every query — 3,432ms for `({H3:K27M})`, which is the delay
// that showed on screen.
async function furtherDescriptorUniverse(conn, model) {
  if (furtherUniverse) return furtherUniverse;
  // `span_mask` IS NAMED HERE OR IT DOES NOT ARRIVE. The column ships in the parquet automatically,
  // but this SELECT is explicit, so a new index column is inert on the page until it is listed —
  // and an inert prefilter input looks exactly like one that is working.
  // The three literature files are fetched once here, on first use, and every SQL below reads the
  // registered buffers by URL (duckdb.js ensureLiterature).
  if (typeof ensureLiterature === 'function') await ensureLiterature();
  const rows = await conn.query(
    `SELECT descriptor, col_keys, span_mask FROM read_parquet('${TIER1_DESCRIPTORS_URL}')`);
  const idx = rows.toArray().map(r => ({ descriptor: r.descriptor, col_keys: r.col_keys,
                                         span_mask: r.span_mask }));
  furtherUniverse = idx.map(r => r.descriptor).filter(Boolean);
  furtherKeyIndex = idx;
  return furtherUniverse;
}

// Reading effort behind the literature artifact. Returns '' when the numbers were not inlined,
// because a half-stated coverage claim is worse than none.
function furtherCoverageNote() {
  if (typeof LITERATURE_COVERAGE === 'undefined' || !LITERATURE_COVERAGE) return '';
  const c = LITERATURE_COVERAGE;
  if (!c.publications) return '';
  const n = (x) => Number(x).toLocaleString('en-US');
  // "OF" WOULD BE A CLAIM THE NUMERATOR CANNOT MAKE. `fullText` counts records in papers/, which
  // may include papers the search never admitted (specs/2026-09-01-out-of-query-papers.md), while
  // `publications` counts the corpus. Reading them as numerator and denominator was true only for
  // as long as every curated paper happened to be in the corpus. Semicolon, and the search states
  // its own size.
  return '<p class="fr-note fr-coverage">Data curation has not found any records yet ' +
    `(${n(c.fullText)} full-text, ${n(c.abstracts)} abstract reads; the search indexed ` +
    `${n(c.publications)} publications ${c.from}\u2013${c.to}).</p>`;
}

async function renderFurtherReading(queryNode, key, unitNode) {
  const host = document.getElementById('furtherbody');
  if (!host) return;
  const gen = ++furtherToken;

  // PUBLICATIONS IS A SPINE SECTION NOW [BB 2026-09-24, SUPERSEDES the 2026-09-23 ruling below]:
  // "the Further reading CONTAINER is dropped; its two tables become sections in the stream" gave
  // `#furtherpanel`'s job to `#furtherbody`, a bare host with no head of its own to show or hide.
  // A container earns its keep back because THIS one carries a count and a scope line rather than
  // repeating a label the heads inside it already state — `PUBLICATIONS 20 of 867`, summed over
  // its own children (see `pubSync` below). So `#sect-publications` is a static spine section like
  // Arrays and Nucleosomes, synced with `syncSection` the same way, and `#furtherbody` is only its
  // body host.
  // `hasContent`: the row count stays the honest `n` (often 0), but a fourth argument tells
  // `syncSection` there is prose in the box — see the call sites below and the ruling at
  // `syncSection`'s own definition.
  const pubSync = (n, total, hasContent) => {
    syncSection('publications', n, undefined, hasContent);
    const el = document.querySelector('#sect-publications .sect-count');
    if (el) el.textContent = (total && total > n) ? `${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : n.toLocaleString('en-US');
  };
  // THE PANEL MAY NOT TAKE DOWN THE RENDER LOOP. These constants are declared in index.html, so a
  // deploy that ships shell.js without them would throw HERE and abort every pane after it — the
  // measurements table included. A missing dependency hides this card and nothing else.
  if (!queryNode || typeof createFurtherReading !== 'function' ||
      typeof TIER1_MENTIONS_URL === 'undefined' || typeof TIER1_PAPERS_URL === 'undefined' ||
      typeof TIER1_DESCRIPTORS_URL === 'undefined' ||
      typeof dbConnect !== 'function') { host.innerHTML = ''; pubSync(0); return; }
  furtherLast = { queryNode, unitNode };

  const M = furtherModel();
  const urls = { mentionsUrl: TIER1_MENTIONS_URL, papersUrl: TIER1_PAPERS_URL };
  // `reached` is hoisted to the render scope on purpose: the Material column shows what made a paper
  // relevant, so the renderer needs the SAME descriptor list the SQL was built from. Recomputing it
  // down there would be a second notion of relevance in the one card that exists to display the first.
  let rows = [], sel = null, buckets = null, failure = null, reached = [];
  try {
    // canonNotation, not a hand-built string: this is the INTERFACE spelling, the one that is keyed
    // and compared, and building a second one here is how a second display path starts.
    const q = (typeof canonNotation === 'function') ? canonNotation(queryNode) : null;
    if (!q) { host.innerHTML = ''; pubSync(0); return; }
    // The unit goes through the SAME spelling. A hand-built string here would be a second display
    // path into the one relation both operands are judged by; `canonNotation` is what `q` already
    // uses. A unit that will not canonicalise is dropped rather than guessed at — the query operand
    // still answers, so the box degrades to what it showed before this existed.
    const qu = (unitNode && typeof canonNotation === 'function') ? canonNotation(unitNode) : null;
    // TWO OPERANDS, TWO DEPTHS [BB 2026-08-31]. The array is asked ONLY whether a datum matches it
    // as a whole; the SELECTED particle is the one that gets decomposed. So clicking bead 1 shows
    // the array's own literature and bead 1's, and not bead 2's K120ub papers — those are about a
    // different particle. `queryList` keeps the more permissive reading of a repeated spelling, so
    // a single-particle query — where `q` and `qu` are the same string — collapses to the FULL
    // operand and loses nothing.
    const operands = qu ? [{ descriptor: q, exact: true }, { descriptor: qu }] : [q];
    const conn = await dbConnect();
    try {
      const universe = await furtherDescriptorUniverse(conn, M);
      if (furtherKeyIndex) M.loadKeyIndex(furtherKeyIndex);
      // THE PANEL SAYS IT IS WORKING BEFORE IT BLOCKS. Relevance is up to ~3s of computation on a
      // cold instance, and until now that ran with the card showing the PREVIOUS query's papers —
      // stale rows that read as the answer. Painted only when the work is actually going to be
      // long-running is a distinction the page cannot make in advance, so it is painted always: the
      // card is replaced wholesale a moment later either way.
      // WHAT WAS ON SCREEN, so the abort path can put it back. `failSoft` clears `lastKey` on every
      // INVALID keystroke without touching the stage — the whole point of TYPING IS NOT AN ERROR is
      // that the answer you are reading survives the next character. That rule and this placeholder
      // met badly: type one more character into a valid query while the box is computing, the abort
      // fires, and the card was left saying "Finding papers…" for good, because nothing newer was
      // coming to repaint it. The placeholder is a promise to repaint, so it has to be undoable.
      const wasShowing = host.innerHTML;
      if (key === lastKey && gen === furtherToken) {
        // CONTENT, NOT EMPTINESS -- the section must actually open onto this line rather than
        // sit collapsed-and-`is-empty` over it, which is what a bare `count === 0` used to mean
        // (CRITICAL 1, review-findings 2026-09-24).
        pubSync(0, undefined, true);
        host.innerHTML = '<p class="al-meta">Finding papers\u2026</p>';
      }
      // ASYNC BECAUSE IT COMPUTES, NOT BECAUSE IT WAITS. The loop hands the page back every few
      // milliseconds so a keystroke is not swallowed, and `shouldAbort` is the SAME stale-guard the
      // paint below uses — so a superseded query stops immediately instead of burning its full
      // 3 seconds to produce an answer that is then discarded. `null` is the abort signal, which is
      // why it is tested separately from the empty answer directly beneath it.
      const rel = await M.relevantDescriptorsAsync(operands, universe,
        { shouldAbort: () => key !== lastKey || gen !== furtherToken });
      // ABORTED. A NEWER RENDER REPAINTS; A CLEARED KEY DOES NOT, and only `gen` can tell them
      // apart — `furtherToken` moves when another `renderFurtherReading` starts, while `lastKey`
      // also moves when the query merely became unparseable. So: still the owner of the card means
      // nobody is coming, and the previous answer goes back.
      if (!rel) {
        if (gen === furtherToken) host.innerHTML = wasShowing;
        return;
      }
      reached = rel;
      // NO RELEVANT DESCRIPTOR IS THE MOST IMPORTANT EMPTY STATE, not a reason to hide the card:
      // it is the case where nobody has written about this site at all, and hiding it leaves the
      // reader unable to tell "nothing found" from "this panel does not apply here". Show the
      // coverage note instead — that is the whole point of it. Falls back to hiding only when the
      // numbers were not inlined, since an empty card says less than no card.
      if (!rel.length) {
        if (key === lastKey && gen === furtherToken) {
          // Compute the note FIRST — whether the section has content is a fact about the note,
          // not about the row count, which stays 0 either way (CRITICAL 1).
          const note = furtherCoverageNote();
          pubSync(0, undefined, !!note);
          host.innerHTML = note || '';
        }
        return;
      }
      if (typeof ensureLiterature === 'function') await ensureLiterature();
      const b = await conn.query(M.bucketCountSQL(rel, urls));
      buckets = { ...b.toArray()[0] };
      const total = Number(buckets['n_' + furtherFilter] || 0);
      sel = M.selectivity(total);
      if (total > 0) {
        const res = await conn.query(M.furtherReadingSQL(rel, { ...urls, limit: sel.shown, filter: furtherFilter }));
        rows = res.toArray().map(r => ({ ...r }));
      }
    } finally { await conn.close(); }
  } catch (e) {
    // Surfaced, never swallowed: an empty card and a broken card look identical otherwise.
    failure = (e && e.message) || String(e);
  }
  if (key !== lastKey || gen !== furtherToken) return;       // stale-guard, same discipline as the rest
  if (failure) {
    // A BROKEN PANEL AND AN ABSENT ONE MUST NOT LOOK ALIKE (CRITICAL 1). This branch used to call
    // no `pubSync` at all, so on a first query `#sect-publications` was still `hidden` straight
    // from the markup and the error painted into a box nobody had opened.
    pubSync(0, undefined, true);
    host.innerHTML = `<p class="al-meta">Could not load further reading: ${escapeHtml(failure)}</p>`;
    return;
  }

  // ── THE DATA-AVAILABILITY FILTER IS WITHDRAWN [BB 2026-09-24] ─────────────────────────────────
  // "Remove all fr-filter content (defer to TODO as reimplementation; i.e., comment out code,
  // don't discard)". Kept as code rather than deleted because it is to be REIMPLEMENTED, and the
  // bucket counts and the FILTERS table it reads are the part that took the thinking. See TODO.md.
  //
  // `furtherFilter` stays at its 'all' default and is still read by the two queries below, so the
  // card behaves exactly as it does with the All button pressed — which is what it always opened
  // on. Nothing about the SQL or the selectivity changes; only the control is gone.
  //
  // const filterBar = '<div class="fr-filter" role="group" aria-label="Data availability">' +
  //   M.FILTERS.map(f => {
  //     const n = Number((buckets && buckets['n_' + f.key]) || 0);
  //     const on = f.key === furtherFilter;
  //     return `<button type="button" class="vtb${on ? ' on' : ''}" data-frfilter="${f.key}"` +
  //            ` aria-pressed="${on}"${n === 0 && !on ? ' disabled' : ''}>` +
  //            `${escapeHtml(f.label)} <span class="fr-fn">${n}</span></button>`;
  //   }).join('') + '</div>';
  const filterBar = '';

  // THE COUNT IS `N of TOTAL` [BB 2026-09-24: "Original research 19 of 25,749"]. The rows on
  // screen are a SELECTION — `M.selectivity` caps what is fetched — so a bare `19` reads as the
  // whole of the literature on this site and is off by three orders of magnitude. The total is
  // the bucket count for the current filter, i.e. the corpus this query reached, and it is
  // thousands-separated because a six-figure number without separators is not read, it is
  // skimmed past. ONE FIGURE, shared by every subsection AND by the L1 head: `bucketCountSQL`
  // counts over all types together, not per type, so `18 of 867` and `2 of 867` (and the L1's
  // own `20 of 867`) all divide the same corpus reach.
  //
  // `toLocaleString('en-US')` and not the visitor's locale: the page states numbers one way
  // throughout, and a separator that changes with the browser makes two readers see different
  // text for the same fact.
  const grandTotal = Number((buckets && buckets['n_' + furtherFilter]) || 0);
  const countText = (n) => grandTotal > n
    ? `${n.toLocaleString('en-US')} of ${grandTotal.toLocaleString('en-US')}`
    : n.toLocaleString('en-US');

  if (!rows.length) {
    // AN EMPTY CARD IS NOT A CLAIM ABOUT THE LITERATURE, and without saying so it reads as one.
    // The corpus is a query result over titles and abstracts, so "no records" means "nothing found
    // in what has been read" — and the size of that is the only thing that makes the difference
    // legible. Shown on the empty state ONLY: when there are rows, the rows are the answer.
    // "No papers under this filter." is always painted below, so this section always has content
    // (CRITICAL 1) — never `is-empty`, whatever the row count.
    pubSync(0, grandTotal, true);
    host.innerHTML = filterBar + '<p class="fr-note">No papers under this filter.</p>' +
      furtherCoverageNote();
    return;
  }

  // THE SAME TOOLCHAIN AS THE MEASUREMENT TABLES [BB 2026-08-16]: `.meas-section` + a `subhd`
  // sub-toggle head + renderLayerTable, so indentation, rules, type scale and the caret all come
  // from one place. A parallel table is how two cards in one panel start disagreeing about which
  // column is which — the Arrays card was rebuilt for exactly that reason.
  // The frame comes from render.js, never from here: layout-constants.test.js forbids shell.js
  // stating a measurement-table column width, because a caller that can disagree eventually does.
  const frame = furtherFrame();
  const section = (label, token, list) => {
    if (!list.length) return '';
    const subId = 'sect|further-' + token;
    // COLLAPSED BY DEFAULT [BB 2026-09-24], for the reason the assay sections are: `Original
    // research 19 of 25,749` is at least as extensive as `PTM deposition 255`, and several
    // sections standing open put everything below them out of reach on a phone. Seeded the same
    // way, into the same store.
    if (typeof firstRenderOf === 'function' && firstRenderOf(subId, queryKeyOrNull())) {
      collapsedSubs.add(subId);
    }
    const collapsed = collapsedSubs.has(subId) ? ' collapsed' : '';
    // AN L2 UNDER PUBLICATIONS NOW [BB 2026-09-24, SUPERSEDES the 2026-09-23 shape below]: "original
    // research and review don't extend to the full spine" put these THREE on the spine as their own
    // L1 `.sect`s. That is overturned — `PUBLICATIONS` is the L1 (see the static section in
    // answer.html) and these are its L2 groups, so they use the SAME `.meas-section` + `.subhd`
    // toolchain the assay-type sections do rather than a second `.secthd` head one level too high.
    const head = `<div class="subhd sub-toggle${collapsed}" data-sub="${subId}">`
      + `<h4 class="meas-sec-label">${escapeHtml(label)}</h4>`
      + `<span class="meas-sec-total"><span class="meas-sec-count">${countText(list.length)}</span></span>`
      + `${CARET_HTML}</div>`;
    // ONE <tr> PER PAPER. It was two rows joined by rowspan and a suppressed border, which is what
    // made the title and its metadata drift apart: they were separate table rows being asked to look
    // like one. A paper is ONE row whose Paper cell stacks two blocks — the title, then the
    // reference line. The table keeps the columns; the cell keeps the typography.
    const body = list.map(r => {
      const mat = M.materialOf(r, reached);
      // styleNotation is the ONE display call — it consumes canonNotation, so page code never picks
      // between them (docs/CLAUDE.md).
      const matHtml = mat.text && typeof styleNotation === 'function'
        ? styleNotation(mat.text) : escapeHtml(mat.text || '—');
      // ── fr-rung IS WITHDRAWN [BB 2026-09-26] ───────────────────────────────────────────────────
      // "comment out code, don't discard" — see TODO.md. The row loses the digit that said WHICH
      // RUNG reached it: a rung-1 row (the material the query is made of, or is assembled into)
      // used to be marked as such; now every row's Material column looks like an exact hit, whether
      // it is one or not. `mat.rung` itself is untouched (further-reading-model.js still computes
      // and tests it) — only the badge built FROM it is out, because nothing else in this row
      // reads `mat.rung`.
      //
      // const RUNG_TITLE = ['the entity you asked about',
      //                     'the material it is made of, or is assembled into'];
      // const rungHtml = (mat.rung === 0 || mat.rung === 1)
      //   ? `<span class="fr-rung fr-rung-${mat.rung}" title="${escapeHtml(RUNG_TITLE[mat.rung])}">${mat.rung}</span>`
      //   : '';
      const rungHtml = '';
      // ── fr-cert IS WITHDRAWN [BB 2026-09-26] ───────────────────────────────────────────────────
      // Same treatment, same reason — see TODO.md. The badge said how the SUBSTRATE was assigned
      // (rule / agent / agent-verified / human, as a dot whose opacity rose with how much was
      // actually checked) and only ever appeared when the substrate was what the Material column
      // was showing. The row now carries no certainty signal at all. `M.certaintyLabel` and
      // `mat.isSubstrate` are untouched — `mat.isSubstrate` is part of `materialOf`'s ordinary
      // return shape and `certaintyLabel` is exercised by further-reading-model.test.js — only the
      // markup built from them here is out.
      //
      // const certLbl = mat.isSubstrate ? M.certaintyLabel(r.substrate_certainty) : null;
      // const cert = certLbl
      //   ? `<span class="fr-cert fr-cert-${escapeHtml(r.substrate_certainty)}" title="Assigned by: ${escapeHtml(certLbl)}"></span>` : '';
      const cert = '';
      // A RETRACTION is never silent. It rides with the row rather than removing it, because hiding
      // a retracted paper is how a reader ends up citing one.
      const flags = [
        Number(r.is_retracted) === 1 ? '<span class="fr-flag fr-retracted" title="Retracted publication">retracted</span>' : '',
        Number(r.is_preprint) === 1 ? '<span class="fr-flag fr-preprint" title="Preprint — not peer reviewed">preprint</span>' : '',
      ].join('');
      const rcr = (r.rcr === null || r.rcr === undefined || Number.isNaN(Number(r.rcr)))
        ? '—' : Number(r.rcr).toFixed(1);
      const title = r.title || '';
      const pmid = String(r.pmid);
      // The stored elision is DISPLAYED, never recomputed: it is a claim about what the row says,
      // and the tooltip states the true count behind it.
      const authors = r.authors || '';
      const authorTip = Number(r.author_n) > 4 ? `${r.author_n} authors` : authors;
      // THREE LINES [BB 2026-08-16]: title, authors, then the citation. Authors get their own line
      // because they are the second thing a reader checks and the first thing that gets elided when
      // they share a line with the journal — the elision was landing on the names, not the venue.
      const meta = [
        r.journal ? `<span class="fr-jour">${escapeHtml(r.journal)}</span>` : '',
        r.year ? `<span class="fr-yr">${escapeHtml(String(r.year))}</span>` : '',
        `<a class="fr-pmid" href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(pmid)}/" target="_blank" rel="noopener">PMID ${escapeHtml(pmid)}</a>`,
        // RCR files with the PMID [BB 2026-08-16]: it qualifies the citation rather than being a
        // second dimension of the table.
        `<span class="fr-rcr" title="Relative Citation Ratio — field- and time-normalised">RCR ${rcr}</span>`,
      ].filter(Boolean).join(' <span class="fr-dot">·</span> ');
      // The TITLE is the link: one obvious target per row beats a separate id to aim at.
      //
      // THE MATERIAL IS THE IDENTITY LINE and the paper is the row [BB 2026-09-23]. The certainty
      // and rung badges travel with it, because they say how the SUBSTRATE was assigned and the
      // substrate is what that line shows.
      return rowPair(
        identityLine(`<span class="fr-mat">${matHtml}${cert}${rungHtml}</span>`),
        `<td class="fr-paper">` +
          `<a class="fr-title" href="https://pubmed.ncbi.nlm.nih.gov/${escapeHtml(pmid)}/" target="_blank" rel="noopener" title="${escapeAttr(title)}">${escapeHtml(title)}</a>${flags}` +
          (authors ? `<div class="fr-au" title="${escapeAttr(authorTip)}">${escapeHtml(authors)}</div>` : '') +
          `<div class="fr-meta">${meta}</div>` +
        `</td>`,
        1, { cls: Number(r.is_retracted) === 1 ? 'fr-row-retracted' : '' });
    }).join('');

    return `<div class="meas-section">${head}` + renderLayerTable(frame, body) + `</div>`;
  };

  const groups = M.splitByType(rows);
  // THE COUNT MOVED, THE ADVICE STAYS [BB 2026-09-24, SUPERSEDES the withheld-count message —
  // IMPORTANT 4, review-findings 2026-09-24 restores the second half]. `sel.message`'s two halves
  // did different jobs: "N papers — showing the M with highest RCR, N-M not shown" restated a count
  // the L1 head's own `20 of 867` already carries, so THAT half is dropped here. "This object is
  // not selective; add a second one to narrow it" is not a count, and nothing replaced it — an
  // earlier pass dropped both halves as one string and lost the one line that tells a reader what
  // to DO about a result this broad, leaving `further-reading-model.test.js` asserting text no
  // reader could reach. So: the scope line states what was done, the second sentence states the
  // action, and the withheld number does not repeat.
  const blurb = sel && !sel.complete
    ? `<p class="fr-lead">Showing the ${sel.shown.toLocaleString('en-US')} top RCR publications. ` +
      'This object is not selective; add a second one to narrow it.</p>' : '';

  // COMMENT & ERRATA FOLDS IN AFTER REVIEWS [BB 2026-09-24]. It is the third group the corpus
  // splits into — comments, letters, errata — and it stays its own section rather than being
  // merged into Reviews or dropped: a retraction notice is not a review, and a reader who came
  // looking for one must be able to find it. Last, because it is the least likely to be what they
  // came for.
  pubSync(rows.length, grandTotal);
  host.innerHTML = filterBar + blurb +
    section('Original research', 'orig', groups.original) +
    section('Reviews', 'review', groups.review) +
    section('Comment & errata', 'excluded', groups.excluded);
}

// WITHDRAWN WITH THE FILTER BAR [BB 2026-09-24] — see the note at its markup above. Left as code
// because the control is to be reimplemented; nothing emits `[data-frfilter]` while it is out, so
// this listener would never fire.
//
// Delegated on #furtherbody, which renderFurtherReading replaces wholesale — so the listener goes
// on the container, which is never itself replaced.
// document.addEventListener('click', (e) => {
//   const btn = e.target.closest && e.target.closest('[data-frfilter]');
//   if (!btn || !document.getElementById('furtherbody')?.contains(btn)) return;
//   const next = btn.getAttribute('data-frfilter');
//   if (!next || next === furtherFilter) return;
//   furtherFilter = next;
//   if (furtherLast) renderFurtherReading(furtherLast.queryNode, lastKey, furtherLast.unitNode);
// });

// Delegated on #measbody (survives renderMeasurements()'s innerHTML resets,
// since the container itself is never replaced).
document.getElementById('measbody').addEventListener('click', e => {
  // Show more / show fewer — a RENDER toggle only; the relevance set behind it never changed.
  //
  // `e.stopPropagation()` REMOVED [BB 2026-09-25, `specs/2026-09-25-one-object-heads.md` Ruling 1].
  // It guarded a CLICK INSIDE A CLICK [BB 2026-09-24]: this control used to live INSIDE
  // `.subhd.sub-toggle`, the collapse target itself, so a press here would also toggle the section
  // unless stopped. It now renders inside the table's own header band — a SIBLING of `.subhd`, not
  // a descendant — so `e.target.closest('.sub-toggle')` in the document-level handler can never
  // reach it walking up from here. The harm the stop existed to prevent cannot occur any more; a
  // stop asserting it would be a guard for a harm that is gone, which this repo treats as worse than
  // no guard (`measurement-render.test.js`'s "click-inside-a-click cannot recur" now asserts the
  // absence instead of the stop).
  const more = e.target.closest('.meas-more');
  if (more) {
    const tok = more.dataset.sec;
    if (expandedSecs.has(tok)) expandedSecs.delete(tok); else expandedSecs.add(tok);
    renderMeasurements(currentMeasurementsWorld);
    return;
  }
  const tr = datumRowFrom(e.target, 'data-id');
  if (!tr) return;
  const mid = tr.dataset.id;
  // Row body: toggle the measurement into/out of the latch set.
  toggleLatch(mid);
});

// ── THE WHOLE PAIR IS THE POINTER TARGET [BB 2026-09-23] ────────────────────────────────────────
// A datum is two rows now (`rowPair`, render.js) and its `data-*` attributes live on the DATA row,
// where `tr[data-id]` selectors can still reach them. But a handler written as
// `e.target.closest('tr[data-id]')` then answers only when the pointer is on the NUMBERS — so the
// identity line, which this design moved out to its own line precisely because it is the thing a
// reader looks at, became the one part of the row that did nothing: clicking the descriptor did
// not latch, and hovering a material name in the mass table did not band the sequence grid.
//
// So: find the GROUP, then its data row. `closest` still does the work; it just stops at the
// tbody, which is the element that means "this datum". Falls back to the old lookup for any table
// not yet built from pairs.
function datumRowFrom(target, attr) {
  if (!target || !target.closest) return null;
  const pair = target.closest('tbody.rowpair');
  return (pair && pair.querySelector(`tr[${attr}]`)) || target.closest(`tr[${attr}]`);
}
// …and the same for "did the pointer leave the datum", which must mean the PAIR and not one of its
// rows: `tr.contains(relatedTarget)` said no as the cursor crossed from the numbers up to the
// descriptor, so the overlay flickered off inside a single row.
function stillInsideDatum(tr, related) {
  if (!related) return false;
  const scope = tr.closest('tbody.rowpair') || tr;
  return scope.contains(related);
}

// ── Measurement → sequence highlight controller ─────────────────────────────
// Multi-select: clicking measurement rows toggles them into the `measSel` latch
// set; the grid paints the UNION of all selected measurements' overlays. Hover
// previews transiently (`measHover`, yields to nothing — it just joins the union
// while active). Esc clears the whole set.
function repaintMeas() {
  clearMeasHighlight();
  const mids = new Set(measSel);
  if (measHover != null) mids.add(measHover);
  const overlays = [...mids].map(measGroupById).filter(Boolean).map((g) => overlayForGroup(g));   // arrow, NOT `.map(overlayForGroup)`: map would pass the index as `registry`
  applyMeasHighlights(overlays);
  document.querySelectorAll('#measbody tr[data-id]').forEach(tr =>
    tr.classList.toggle('meas-latched', measSel.has(tr.dataset.id)));
}
function hoverMeasurement(mid) { measHover = mid; repaintMeas(); }
function unhoverMeasurement() { if (measHover != null) { measHover = null; repaintMeas(); } }
function toggleLatch(mid) { measSel.has(mid) ? measSel.delete(mid) : measSel.add(mid); measHover = null; repaintMeas(); }
function clearLatch() { measSel.clear(); measHover = null; repaintMeas(); }

// Hover preview + Esc clears the whole latch set.
document.getElementById('measbody').addEventListener('mouseover', e => {
  const tr = datumRowFrom(e.target, 'data-id'); if (!tr) return;
  hoverMeasurement(tr.dataset.id);
});
document.getElementById('measbody').addEventListener('mouseout', e => {
  const tr = datumRowFrom(e.target, 'data-id'); if (!tr) return;
  if (stillInsideDatum(tr, e.relatedTarget)) return;   // moved within the datum, not out of it
  unhoverMeasurement();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && (measSel.size || seqSel.size)) { clearLatch(); clearSeqLatch(); }
});

// ── Sequence → measurement highlight controller (reverse of the above) ──────
// Multi-select: clicking a grid row toggles its accession into the `seqSel`
// latch set; painting bands the UNION of all selected accessions' measurement
// rows (`.meas-xref`). Hover previews transiently via `seqHover`. Esc clears
// both this set and `measSel` (see the shared keydown handler above).
function midsForAccession(acc) {
  const out = [];
  measGroups.forEach((g, mid) => { if (g.rows.some(r => r.uniprot_id === acc)) out.push(mid); });
  return out;
}
let seqSel = new Set(), seqHover = null;
function repaintSeq() {
  document.querySelectorAll('#measbody tr.meas-xref').forEach(t => t.classList.remove('meas-xref'));
  const accs = new Set(seqSel); if (seqHover) accs.add(seqHover);
  const mids = new Set([...accs].flatMap(midsForAccession));
  mids.forEach(mid => { const tr = document.querySelector(`#measbody tr[data-id="${mid}"]`); if (tr) tr.classList.add('meas-xref'); });
}
function hoverSeq(acc) { seqHover = acc; repaintSeq(); }
function unhoverSeq() { if (seqHover != null) { seqHover = null; repaintSeq(); } }
function toggleSeqLatch(acc) { seqSel.has(acc) ? seqSel.delete(acc) : seqSel.add(acc); seqHover = null; repaintSeq(); }
function clearSeqLatch() { seqSel.clear(); seqHover = null; repaintSeq(); }

document.getElementById('subunits').addEventListener('mouseover', e => {
  const row = e.target.closest('.al-row[data-acc]'); if (!row) return;
  hoverSeq(row.dataset.acc);
});
document.getElementById('subunits').addEventListener('mouseout', e => {
  const row = e.target.closest('.al-row[data-acc]'); if (!row) return;
  if (e.relatedTarget && row.contains(e.relatedTarget)) return;  // moved within the row
  unhoverSeq();
});
document.getElementById('subunits').addEventListener('click', e => {
  const row = e.target.closest('.al-row[data-acc]'); if (!row) return;
  toggleSeqLatch(row.dataset.acc);
});

// ── the per-residue readout ──────────────────────────────────────────────────
// What the pointer is on, in the pointed-at molecule's OWN numbering, written under the grid. This
// replaces the per-row offset superscript, which stated one offset for a row that usually has
// several. The fact varies per residue, so the instrument that reports it has to as well.
//
// ONE delegated listener, and every input is already on the cell: `data-own` (this molecule's own
// number), `data-pos` (the aligned position, absent on an insertion column), `data-aln`, plus the
// row's `data-handle`. No registry lookup and no per-cell `title` — a four-family card is ~6,600
// cells and titling them all is a few hundred KB of markup for a delayed native popup on every cell
// the pointer crosses.
document.getElementById('subunits').addEventListener('mouseover', e => {
  const cell = e.target.closest('.ares'); if (!cell) return;
  const row = cell.closest('.al-row[data-acc]'); if (!row) return;
  const out = row.closest('.su')?.querySelector('.al-readout'); if (!out) return;
  const grid = row.closest('.al-grid');
  const num = (v) => (v == null || v === '' ? null : Number(v));
  // A COLLAPSED RUN is not a residue, so it takes the run branch rather than the identity one — the
  // readout answers "which residue is this" and the honest answer here is "several, not drawn".
  if (cell.classList.contains('ins-run')) {
    out.textContent = readoutFor({
      handle: row.dataset.handle,
      run: { n: Number(cell.dataset.run || 0),
             after: num(cell.dataset.after), before: num(cell.dataset.before) },
    });
    return;
  }
  const insertion = cell.dataset.pos === undefined;
  const res = cell.textContent === '-' ? null : cell.textContent;
  const carriers = insertion
    ? grid.querySelectorAll(`.ares[data-aln="${cell.dataset.aln}"]:not(.gap)`).length
    : 0;
  const d = (cell.dataset.drift || '').split('→');
  out.textContent = readoutFor({
    handle: row.dataset.handle, residue: res,
    own: num(cell.dataset.own),
    pos: insertion ? null : Number(cell.dataset.pos),
    insertion, gap: res == null, outside: cell.classList.contains('outside'),
    carriedBy: carriers,
    ofRows: grid.querySelectorAll('.al-block:first-child .al-row[data-acc]').length,
    // The cell's shading, restated as the reason for it. Both are absent on the great majority of
    // cells, which is why they are data attributes and not a title on all ~6,600 of them.
    state: cell.dataset.state || null,
    drift: d.length === 2 ? { from: d[0], to: d[1] } : null,
    extentLabel: grid.dataset.extent || null,
  });
});
document.getElementById('subunits').addEventListener('mouseout', e => {
  const grid = e.target.closest('.al-grid'); if (!grid) return;
  if (e.relatedTarget && grid.contains(e.relatedTarget)) return;   // moved within the grid
  const out = grid.closest('.su')?.querySelector('.al-readout');
  if (out) out.textContent = '';
});

// ── Card-local cross-highlight: Mass / AM row → its sequence ─────────────────
// Hovering a datum row bands the sequences it speaks about in the SAME card's grid. The matching
// rule — idea position, with accession only as a narrowing — lives in measurement-highlight.js
// beside the other datum→sequence overlay, because it is the same question asked by a different
// pointer, and it was answered two different ways here for as long as it lived in two files.
const clearSeqXref = (card) => clearRowXref(card);
document.getElementById('subunits').addEventListener('mouseover', e => {
  const tr = datumRowFrom(e.target, 'data-acc'); if (!tr) return;
  const card = tr.closest('.su'); if (!card) return;
  clearRowXref(card);
  applyRowXref(tr, card, (typeof nucleosomeParser2 !== 'undefined') && nucleosomeParser2.DEFAULT_REGISTRY);
});
document.getElementById('subunits').addEventListener('mouseout', e => {
  const tr = datumRowFrom(e.target, 'data-acc'); if (!tr) return;
  const card = tr.closest('.su'); if (!card) return;
  if (stillInsideDatum(tr, e.relatedTarget)) return;  // moved within the datum, not out of it
  clearSeqXref(card);
});

// Match-mode toggle: compatible (default) ⇄ entails for the per-arrangement
// measurements. Default surfaces every datum consistent with the query (discovery);
// tightening to entails keeps only data the query strictly entails (spec §5.1).
const broadenBtnEl = document.getElementById('broaden-toggle');
if (broadenBtnEl) broadenBtnEl.addEventListener('click', () => {
  broaden = !broaden;
  // The word `via` is in the footer's own markup now, not here [BB 2026-09-24]: the control is one
  // clause of "Map Hs \u2192 Hs via compatible", so it holds the value alone.
  broadenBtnEl.innerHTML = `<b>${broaden ? 'compatible' : 'entails'}</b>`;
  broadenBtnEl.setAttribute('aria-pressed', String(broaden));
  broadenBtnEl.classList.toggle('on', broaden);
  renderMeasurements(currentMeasurementsWorld);
  // ARRAYS READ `broaden` TOO, and only this pane was being told (BB, 2026-08-06:
  // "(H4K16ac)-30-(H4) shows (H2A.Z)-30-(H2A.Z) for entails, but the Diagnostic panel rightly
  // rejects it"). `queryThreeTier` takes the mode as an argument, so the Arrays card kept whatever
  // it had computed under the PREVIOUS one — and since the default is `compatible`, flipping to
  // `entails` relabelled the button and left a compatible-only datum on screen. Nothing was wrong
  // with the relation: `entails2((H2A.Z)-30-(H2A.Z), (H4K16ac)-30-(H4))` is false and Tier 2 would
  // have dropped it. The card was simply never asked again.
  //
  // Every other `broaden` reader — glyphRelevantRows, columnAxisAccepts, markAxisAccepts — is inside
  // renderMeasurements, which is why this one was the only one missed and why nothing else needs
  // adding here.
  renderArrays(currentIR, currentRender.materials, lastKey);
});

// Number of marked/variant copies in an arrangement string (a proxy for how
// "modified" a world is; wild-type "" and absence "∅" don't count).
function arrMarkCount(arrStr) {
  return String(arrStr || '').split('|')
    .reduce((n, seg) => n + seg.split('/').filter(c => c && c !== '∅').length, 0);
}

// The lowest (least-modified) C2 (dyad-symmetric) arrangement, or — if the query
// has no C2 — the first arrangement (c2First keeps C2 ahead of C1). Ties
// resolve by enumeration order (the reduce keeps the earlier one).
// C2 first, C1 after, each group stable — the panel lists dyad-symmetric worlds ahead of asymmetric
// ones and default-selects the first. Was `sortC2First` in arrangements-model.js, which re-parsed the
// arrangement string; it reads the engine's symmetry now.
function c2First(arrStrs) {
  return (arrStrs || [])
    .map((a, i) => ({ a, i, rank: symOf(a) === 'C2' ? 0 : 1 }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map((o) => o.a);
}

// THE INTERPRETATION CARRIES ITS OWN POINT GROUPS, so read them from it rather than from the global
// `arrByStr`. That map is populated by `indexWorldIRs` for the FOCUSED unit only, and `unitWorld`
// enumerates other units directly — so `symOf` answered 'C1' for every one of their arrangement
// strings, no C2 was ever found, and a non-focused bead defaulted to the first enumerated world
// instead of the lowest-C2 one. The deleted `pointGroup()` read the string and worked for any unit;
// this reads the record, which is better, but it has to be given the right record. Reviewed
// 2026-08-05.
function lowestC2(interpOrOctamers) {
  const isInterp = interpOrOctamers && interpOrOctamers.node === 'interpretation';
  const octs = (isInterp ? interpOrOctamers.octamers : interpOrOctamers) || [];
  const arrs = isInterp ? (interpOrOctamers.arrangements || []) : null;
  const symAt = (a, i) => (arrs && arrs[i]) ? arrs[i].symmetry : symOf(a);
  const c2 = octs.filter((a, i) => symAt(a, i) === 'C2');
  if (!c2.length) {
    // c2First also consults `arrByStr`; with a foreign interpretation, rank from its own records.
    if (arrs) {
      const ranked = octs.map((a, i) => ({ a, i, rank: symAt(a, i) === 'C2' ? 0 : 1 }))
        .sort((x, y) => x.rank - y.rank || x.i - y.i);
      return ranked.length ? ranked[0].a : undefined;
    }
    return c2First(octs)[0];
  }
  return c2.reduce((best, a) => arrMarkCount(a) < arrMarkCount(best) ? a : best);
}

// ── Arrangements panel: counts + C2/C1 + facet tiles ────────────────────────
// Consumes interpret3(): the tiles are `octamers`, and the point group and orientation label come
// from the index-aligned `arrangements` records. `arrangements-model.js` used to supply them by
// re-parsing the arrangement string and was deleted 2026-08-05.
// Mirrors specs/mockups/2026-07-13-shell-materials-arrangements.html
// (.counts/.sym/.cell markup, tile() glyph), adapted to real arrStr data
// (a proteoform signature per copy, "" = wild-type) instead of the mockup's
// placeholder MM/HET/WW worlds.
// Tile-click behaviour (selection driving materials/measurements) is Task 4 —
// this only gives each tile `data-arr` for that task to bind to.

function clearArrangementCounts() {
  document.getElementById('arr-counts').innerHTML = '';
}

// THE TWO COUNTS ARE NAMED BY `classify2`, THE ONE NAMER (grammar/species.js) [BB 2026-08-05].
// They used to be named from `absenceModel.composition`, which is null for anything without DNA
// (absence is a statement about a PARTICLE) and for every class but hexasome/tetrasome — so the
// fallback "octamer · nucleosome" labelled a free tetramer, a dimer and a lone H3 alike.
//
//   core     — the PROTEIN complex, compositions up to the dyad flip. Only the four DNA-wrapped
//              classes need a word for it; a free assembly already IS its core, so it names itself
//              and this table stays four rows rather than becoming a second species registry.
//              (A chromatosome's core is listed as the octamer because H1 is not a face family:
//              the arrangements being counted are over H3/H4/H2A/H2B, which is what the word must
//              name if it is to be true of the number beside it.)
//   particle — the DNA-WRAPPED thing, dyad-explicit. Shown only when there IS DNA: without it
//              nothing orients the two faces, which is why `interpret3` already leaves `sign` null
//              on a DNA-less octamer. The number would be counting a distinction the reader cannot
//              point at, so it is dropped rather than renamed.
const CORE_OF = { nucleosome: 'octamer', chromatosome: 'octamer',
                  hexasome: 'hexamer', tetrasome: 'tetramer' };

// NAMED FROM THE ENTITIES BEING COUNTED, not from the query (BB, 2026-08-06).
//
// This was handed `particleOf(query)` and classified THAT. Two things follow, and both are the same
// mistake the cartoon made: the consumer attached to the wrong stage of the IR. `classify2` names a
// PARTICLE; handed a whole array it answers "array", which is not a species and which this function
// then had to special-case into a blank. And the numbers beside the words come from `interpret3`,
// so naming them off the query meant the label and the count were derived from different things —
// `(H3:K27M)(H3:K36me3)` printed bare numbers while `(H3:K27M)2`, the same shape said differently,
// printed named ones.
//
// The worlds ARE the entities the counts count, and composition is invariant across them (worlds
// differ by ARRANGEMENT, not by what is present), so one world names them all. Its particles are
// what `classify2` is for, and `particlesOf` is the same expansion the Arrays gate uses — so a
// repeated particle is named once per particle rather than once per member.
//
// A mixed array — particles of different classes — gets NO name rather than the first one: there is
// no single word that is true of the number beside it, which is the rule the old `|| sig` fallback
// followed and the reason the array answer blanks instead of guessing.
function countNames(interp, fallback) {
  const P2 = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
  // A world when there is one; otherwise the node the counts were computed FROM. A chromatosome
  // enumerates zero worlds and still has a name, and losing it would trade one wrong label for a
  // missing one. Either way the naming below is the same: per PARTICLE, never on the whole node.
  const world = (interp && interp.worlds && interp.worlds[0]) || fallback || null;
  if (!P2 || !world) return { core: null, particle: null };
  let parts = [];
  try { parts = P2.particlesOf(world) || []; } catch (e) { parts = []; }
  // A DNA-less assembly is not a particle but still has a class — a bare octamer names its core and
  // no particle, which is what `interpret3` already says by leaving `sign` null on it.
  const nodes = parts.length ? parts : [world];
  let cls = null;
  try {
    const seen = nodes.map((n) => P2.classify2(n));
    cls = seen.every((c) => c && c === seen[0]) ? seen[0] : null;
  } catch (e) { cls = null; }
  // NOT A SINGLE WORD → NO WORD. `classify2` used to answer the string `'array'` here and this
  // tested for it; since 2026-08-14 it answers what is actually in the array — one class name when
  // they agree, the LIST when they do not. So a uniform array now lands a real name (a two-nucleosome
  // chain reads `nucleosome`, which is what the count-form spelling of it already read), and the
  // blank is reserved for the mixed case it was written for: `Array.isArray` is the same test as
  // before, asked of the answer's shape rather than of a sentinel word.
  if (!cls || Array.isArray(cls)) return { core: null, particle: null };
  return { core: CORE_OF[cls] || cls,
           particle: nodes.some((n) => n && n.dna != null) ? cls : null };
}

function renderArrangementCounts(octamers, nucleosomes, capped, total, interp, node) {
  // The C2/C1 symmetry legend is gone — each tile carries its own point-group
  // label (.pg), so the breakdown is already surfaced. We keep the truncation
  // warning, so a capped tile set never reads as complete. The composition caption is gone: the
  // count labels themselves now name the class (see `countNames`), and a caption beside them said
  // it twice — once contradicting the other ("1 octamer · hexasome").
  // Three distinct states, and they must not be conflated. REFUSED: nothing was enumerated, so the
  // counts are not counts at all — say what the space is instead of printing 0. DRAWN-SUBSET: the
  // counts are exact and only the tiles are capped. COMPLETE: nothing to say.
  const partial = interp && interp.exhausted === false;   // sampled, not refused
  const shown = Math.min(tileLimit, total || 0);
  // The count IS the control (BB): "showing 24 of 95" is where the eye already is when it wants more,
  // so the trigger lives there rather than on a button below a grid of tiles.
  // Three states, and they must not be conflated. PARTIAL: the space was too large to walk, so these
  // are real worlds drawn from across it — a LOWER BOUND, said with "at least", never a refusal and
  // never a claim of completeness. There is still no "enumerate anyway" (BB): the only thing an opt-in
  // could buy is a grid nobody can read, and the answer that matters — which measurements are relevant
  // — is already complete below, because C is read off the query rather than off the worlds.
  const cappedNote = partial
    ? ` <span class="capped">&mdash; at least ${total} of ${(interp.candidates || 0).toLocaleString()}`
      + ` candidate worlds sampled</span>`
    : (total > shown
        ? ` <button type="button" class="capped arr-expand" id="arr-more">&mdash; showing ${shown} of ${total} &mdash; show all</button>`
        : (tileLimit > TILE_CAP && total > TILE_CAP
            ? ` <button type="button" class="capped arr-expand" id="arr-more" data-fewer="1">&mdash; showing all ${total} &mdash; show fewer</button>`
            : ''));
  const name = countNames(interp, node);
  const plural = (n, w) => `${w}${n !== 1 ? 's' : ''}`;
  // `big` is built per count so a missing name drops its whole span — a count with no word beside it
  // is not a smaller label, it is an unlabelled number.
  const big = (pre, n, word) => (word
    ? `<span class="big">${pre}${n}<small>${plural(n, word)}</small></span>` : '');
  // A partial draw still has real counts to show — they are simply lower bounds, so the labels lead
  // with "≥". Printing only the note (the old refusal behaviour) threw away numbers we do have.
  // (`name`/`plural` used to be declared BELOW this branch and read inside it — a temporal-dead-zone
  // ReferenceError on every sampled query. Found while moving the naming; nothing else changed here.)
  if (partial) {
    document.getElementById('arr-counts').innerHTML =
      big('&ge;', octamers, name.core) + big('&ge;', nucleosomes, name.particle) + cappedNote;
    return;
  }
  document.getElementById('arr-counts').innerHTML =
    big('', octamers, name.core) + big('', nucleosomes, name.particle) + cappedNote;
}

// Ported from the mockup's tile(w)/cv(n), but reads the real per-family
// [copy0, copy1] (proteoform signatures, "" = wild-type) from
// parseArrangement(arrStr) instead of the mockup's placeholder MM/HET/WW worlds.
const ARR_FAMS = ["H3", "H4", "H2A", "H2B"];
const ARR_FAMCOL = ['--h3', '--h4', '--h2a', '--h2b'];
// Light tints (matching the cartoon beads) for the arrangement tile dots.
const ARR_FAMCOL_LT = ['--h3-lt', '--h4-lt', '--h2a-lt', '--h2b-lt'];
// family -> --hXX custom-prop NAME (not value): the family colors live once in
// _shell.scss :root (--h3..--h2b, light + dark) — the single owner; this only
// maps a family to that var name, reused by buildMaterialCard() to set --fam on
// each .su card (mockup: el.style.setProperty('--fam','var('+f.col+')')).
const FAM_COLORVAR = Object.fromEntries(ARR_FAMS.map((f, i) => [f, ARR_FAMCOL[i]]));

// Read shell CSS custom props off .shell — --strong/etc. are scoped there, not
// on :root (only the family colors --h3..--h2b are on :root), so reading from
// document.documentElement returns "" for --strong and the modified-copy ring vanishes.
function cv(n) { return getComputedStyle(document.querySelector('.shell') || document.documentElement).getPropertyValue(n).trim(); }

// One arrangement tile. Drawn from the SAME SeatMap the cartoon uses (BB, 2026-07-25, stage 3), so
// the bead and the tile are literally one object at two scales rather than two renderers that had
// to be kept in agreement. It used to re-read the arrangement STRING and decode copy signatures
// itself — a third opinion about what a copy looks like, next to worldDeco and fallbackDeco.
//
// `world` is the concrete world IR for this arrangement (interpret2's `worlds[i]`, aligned to
// `octamers[i]`). Without one there is nothing to draw, so the tile is skipped rather than guessed.
// THE TILE OBEYS THE FLIP, like the cartoon and the label already did [BB 2026-08-05]. The dots are
// drawn per SEAT, so an orientation change moves them — and the flip moved every other view of the
// selected world (`worldIRFor` swaps the faces for the cartoon, `flipSelectedWorld` for the material
// and measurement panes, `labelOf` for the point-group text) while the tile kept the unflipped copy
// layout. It is the one view where the two rows ARE the two faces, so it was the most visible.
//
// Applied HERE rather than only at the click, so a rebuild (a re-render, a context switch) redraws a
// persisted flip the same way — the flip lives in `flippedArr`, not in the DOM.
function tileSvg(arrStr, world) {
  const w = (world && isFlipped(selectedUnit, arrStr)) ? flipWorldIR(world) : world;
  // THE TILE'S ROWS ARE THE FACES, AND SO ARE THE SEAT NUMBERS [BB 2026-08-11]. Row h holds seat
  // `:h+1`, a world stamps `face` as 1 or 2, and `seats()` puts copy k in seat k — one number the
  // whole way through, so the tile and the cartoon cannot disagree about which half a copy is on.
  //
  // This used to pass the atlas because the cartoon reordered a family's two seats by
  // `particle-priority` and the tile had to reproduce that or contradict it. `seats()` no longer
  // consults the atlas at all; the argument is kept only because other callers still pass it.
  const sm = w ? seats(w, nucleosomeParser2, beadAtlas) : null;
  let svg = '';
  const x0 = 12, gapx = 16, gapy = 14;
  for (let h = 0; h < 2; h++) {
    for (let f = 0; f < 4; f++) {
      const fam = ARR_FAMS[f];
      const st = sm && sm.seats[fam + ':' + (h + 1)];
      const cx = x0 + f * gapx, cy = 9 + h * gapy;
      // Identity is carried by the family COLOUR (light tint = canonical, full shade = variant) and
      // decoration by a dot on top — the same two axes, drawn the same way, as the cartoon bead.
      const isVariant = !!(st && st.variant);
      const isModified = !!(st && st.marks.length);
      const famColor = cv(isVariant ? ARR_FAMCOL[f] : ARR_FAMCOL_LT[f]);
      const sig = !st ? 'absent'
        : (!st.occupied ? 'absent'
          : (isVariant ? [st.variant].concat(st.marks.map(m => m.token)) : st.marks.map(m => m.token))
              .join(' · ') || 'wild-type');
      const title = `<title>${fam} · ${sig}</title>`;
      if (!st || !st.occupied) {
        // An absent copy KEEPS its family fill; absence is carried entirely by black ink — the same
        // outline the present copies wear, plus a strikethrough. Drawn in the family colour with no
        // fill it read as a paler present copy rather than a struck-out one.
        const r = 4.6;
        svg += `<g>${title}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${famColor}" fill-opacity="0.45" stroke="#000" stroke-width="0.7" stroke-opacity="0.7"/>` +
          `<line x1="${cx - r}" y1="${cy + r}" x2="${cx + r}" y2="${cy - r}" stroke="#000" stroke-width="1.2" stroke-opacity="0.85"/></g>`;
        continue;
      }
      svg += `<g>${title}<circle cx="${cx}" cy="${cy}" r="4.6" fill="${famColor}" stroke="#000" stroke-width="0.7" stroke-opacity="0.7"/>` +
        (isModified ? `<circle class="arr-dot" cx="${cx}" cy="${cy}" r="1.9"/>` : '') + '</g>';
    }
  }
  return `<svg width="72" height="32" viewBox="0 0 72 32">${svg}</svg>`;
}

function tileEl(arrStr, world) {
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.arr = arrStr;
  el.innerHTML = tileSvg(arrStr, world) + `<div class="pg">${labelOf(arrStr, selectedUnit)}</div>`;
  return el;
}

async function renderArrangements(query, interp) {
  const facets = document.getElementById('facets');
  // interp may be pre-computed by the caller (renderFocusedPanes enumerates once
  // up front to pick the default world); only interpret here if it wasn't passed.
  if (interp === undefined) {
    try { interp = interpretWorlds(query); }
    catch (e) { interp = null; }
    currentInterp = interp;
    indexWorldIRs(interp);   // standalone call (not pre-indexed by renderFocusedPanes)
  }
  if (!interp || interp.node !== 'interpretation') {
    // Nothing to enumerate (a bare histone, or a query that doesn't denote an
    // assembly): the arrangements panel shows a collapsed, non-opening header
    // rather than a "wrap in ( )" prompt or a vanished box.
    facets.innerHTML = '';
    clearArrangementCounts();
    syncSection('arrsel', 0);
    return;
  }
  // THE COUNT IS ARRANGEMENTS OFFERED, not rows: this is a SELECTOR, and BB's rule for it is
  // "more than one" rather than "more than none" — one arrangement is not a choice. `interp.total`
  // is the number the counts row already prints.
  syncSection('arrsel', interp.total || 0);
  const { octamers, nucleosomes } = interp.counts;
  // `interp` FIRST: the words must be named from the same things the numbers count. The query is a
  // fallback for the queries that enumerate nothing and still have a name.
  renderArrangementCounts(octamers, nucleosomes, interp.capped, interp.total, interp, query);
  facets.innerHTML = '';
  // PARTIAL enumeration (the candidate space was too large to walk). Real worlds were drawn from
  // across it, so the tiles below are genuine — just not all of them. Saying so beats both an
  // unexplained short grid and the old blanket refusal.
  if (interp.exhausted === false) {
    const p = document.createElement('p');
    p.className = 'al-meta';
    p.textContent = `This query denotes ${interp.candidates.toLocaleString()} candidate arrangements — `
      + `too many to enumerate. The tiles below are a representative sample of real ones, not all of `
      + `them. Materials and measurements are unaffected: relevance is derived from the query itself, `
      + `not from the arrangements.`;
    facets.appendChild(p);
  }
  // Tile order. Two criteria, and they pull in OPPOSITE directions, so the choice is explicit:
  //   · dyad-symmetric (C2) first — the symmetric worlds are what the eye looks for, and the default
  //     selection targets the first tile;
  //   · most PERMISSIVE first — a world that pins fewer copies has a larger up-set, so more data
  //     entails it. Under strict matching that is literally "the tile most data attaches to".
  // C2 worlds pin BOTH copies, so ranking purely by permissiveness would bury every symmetric world.
  // C2 leads (BB), permissiveness orders within each group. Order-only — the counts are group totals.
  // Built here rather than read from `worldIRByArr`, which is populated by `indexWorldIRs` on a
  // different path and may not have run for this interpretation yet.
  const wByArr = new Map();
  (interp.octamers || []).forEach((a, i) => { if (interp.worlds && interp.worlds[i]) wByArr.set(a, interp.worlds[i]); });
  const permissive = (a) => {
    const w = wByArr.get(a);
    return (w && typeof worldUpSet === 'function') ? worldUpSet(w, relevance.GLYPH_U).length : 0;
  };
  const ordered = c2First(interp.octamers)
    .map((a, i) => ({ a, i, c2: symOf(a) === 'C2', p: permissive(a) }))
    .sort((x, y) => (y.c2 - x.c2) || (y.p - x.p) || (x.i - y.i))
    .map((o) => o.a);
  // The world IR behind each arrangement string, so a tile draws from the node rather than from a
  // re-parse of its own label.
  const wmap = new Map((interp.octamers || []).map((o, i) => [o, (interp.worlds || [])[i]]));
  ordered.slice(0, tileLimit).forEach(arrStr => facets.appendChild(tileEl(arrStr, wmap.get(arrStr))));


  // Re-apply a persisted tile selection after the rebuild (a port/context switch
  // rebuilds the tiles from scratch). If the selected arrangement is no longer
  // among the enumerated tiles, drop the selection. Materials/measurements were
  // already rendered under selectedWorld by onInput; this just re-highlights it.
  // Re-default rather than clear when the persisted arrangement is gone, so a rebuild can never land
  // in the no-world state (tiles are not deselectable). renderFocusedPanes already re-defaulted before
  // materials rendered; this covers the standalone call path, where it also re-renders them.
  if (selectedArr) {
    const cells = [...facets.querySelectorAll('.cell[data-arr]')];
    const cell = cells.find(c => c.dataset.arr === selectedArr);
    if (cell) { cell.classList.add('sel'); selectedWorld = worldIRFor(selectedUnit, selectedArr); }
    else {
      const first = lowestC2(interp);
      selectedArr = first || null;
      selectedWorld = first ? worldIRFor(selectedUnit, first) : null;
      if (first) {
        const c2 = cells.find(c => c.dataset.arr === first);
        if (c2) c2.classList.add('sel');
        renderMaterials(currentRender.parsed, currentRender.key, selectedWorld);
        renderMeasurements(selectedWorld);
      }
    }
  }

  // Has-data dots (sub-project #3, Task 2): fetch candidate screen rows for
  // the query's union of modifications, then per-tile filter via
  // tileMods()+filterEntailedRows() (per-world entailment). Table wiring
  // for these candidates is Task 3 — this only places the dot.
  const { parsed, key } = currentRender;
  const gen = materialsToken;                          // capture generation BEFORE the await
  // THE CARDS ARE CANON'S MEMBERS. `fuseCanon` fuses meet-identical copies and leaves distinct ones
  // apart, so the pane lists what the particle IS — which is what the cartoon and the arrangements
  // have always drawn. The old `materialsModel`'s hand-rolled grouping (key on family|variant, then re-split
  // via `_proteoforms`) was a second opinion about identity; this one asks meet.
  const canon = canonNode(currentIR);
  const materials = canon ? materialsFromCanon(canon) : [];
  // AN ABSENT FAMILY HAS NO CANON MEMBER — that is what its absence means — so the ghost cards a
  // hexasome/tetrasome shows have to be put back. `absenceModel` already knows which families went
  // unseated (it reads the same `seats()` the cartoon ghosts), so this is one derivation surfacing in
  // two places rather than two derivations. Appended after the present materials: a hole is read
  // last, after what is there.
  for (const k of (absenceModel?.absentKeys ?? [])) {
    const family = String(k).split('|')[0];
    if (materials.some((m) => m.family === family)) continue;
    materials.push({ family, variant: null, count: 0, certainty: null, segments: null,
                     mods: [], _markMods: {}, hasMark: false, isFill: false, key: k, _absent: true });
  }
  const unionMods = queryUnionMods(materials);
  const candidates = await queryScreenCandidates(unionMods);
  if (key !== lastKey || gen !== materialsToken) return;  // stale-guard: a newer query/tile-click superseded us
  currentRender.candidates = candidates;                  // reused by Task 3's tile-coupled table
  currentRender.materials = materials;
  // A dot asks the per-world question — "is this tile a world some measurement attaches to?" — so it
  // runs the same two axes as the strict branch: the datum's shape in the tile's up-set, then
  // entails2 against that tile's own world IR. The meet runs once per (tile, MEASUREMENT), not per
  // lookup row: a screen deposits one row per mark and they all share one descriptor.
  const byMeasurement = [...groupByMeasurement(candidates).values()];
  facets.querySelectorAll('.cell[data-arr]').forEach(cell => {
    const arr = cell.dataset.arr;
    const up = relevance.tileUpSet(arr);
    if (up.length && byMeasurement.some(rows =>
          rows.some(r => relevance.datumGlyphMask(r).some(g => up.includes(g))) && relevance.entailsWorld(rows, arr))) {
      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.title = 'Has data';
      // Its glyph is a Private Use Area codepoint, which a screen reader announces as garbage, and
      // `title` alone is not a reliable accessible name. This badge carries information no other
      // part of the tile states, so it is LABELLED rather than hidden.
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Has data');
      cell.appendChild(dot);
    }
  });

  // (Removed 2026-07-29, BB: the "Arrangements are species-independent…" note. It explained that
  // Show as reaches the materials while arrangements and measurements are drawn from every organism
  // — true, but it is the page reassuring the reader about its own behaviour, and it appeared only
  // when Show as was active, which is exactly when the reader is already thinking about organisms.)
}

// Tile selection → materials world-split (Task 4). Delegated on #facets
// (survives renderArrangements()'s facets.innerHTML='' resets, since the
// container itself is never replaced). Clicking the already-selected tile
// deselects it and falls back to the family-level default view.
// Draw more / fewer tiles. A render toggle: enumeration already finished, so this re-draws from
// `currentInterp` and computes nothing.
//
// THE NODE IS NOT OPTIONAL, AND IT IS THE FOCUSED UNIT. This passed `currentRender.info?.canonical`
// — a field `currentRender` has never carried; it is `{parsed, key}` at all three of its assignments
// — so the argument was `undefined` every time, `countNames` had no node to classify, and BOTH counts
// rendered as the empty string. Clicking "show all" on 95 octamers left the line reading only
// "showing all 95 — show fewer", and "show fewer" could not bring the numbers back because it
// re-entered the same way. The optional chaining is what made it silent: a field that never exists
// reads exactly like one that is merely absent this time.
//
// `particleOf(unitIR2(selectedUnit))` is what the render path itself passes (renderFocusedPanes),
// so the toggle and the render now name the same thing — which is the point: the panel is counting
// the focused unit's arrangements, and re-drawing them must not change what is being counted.
function redrawTiles() {
  return renderArrangements(particleOf(unitIR2(selectedUnit)), currentInterp);
}

// Tile-count controls. Delegated from the counts line (#arr-counts), which is rebuilt on every render,
// so the listener must live on the container rather than the buttons.
document.getElementById('arr-counts').addEventListener('click', e => {
  const more = e.target.closest('#arr-more');
  if (more) {
    tileLimit = more.dataset.fewer ? TILE_CAP : Infinity;
    redrawTiles();
    return;
  }
});

document.getElementById('facets').addEventListener('click', e => {
  const cell = e.target.closest('.cell[data-arr]');
  if (!cell) return;
  const { parsed, key } = currentRender;
  if (!parsed) return;                                    // nothing rendered yet
  arrTouched = true;                                      // this member's choice is the user's, not the default
  // CLICKING THE SELECTED TILE FLIPS ITS ORIENTATION. Deselecting is still not a thing — a world is
  // always chosen; that used to drop the panes to query-level materials while the cartoon kept
  // drawing the full octamer, and the state had no meaning of its own. What a second click means now
  // is "show me the other way round", which is meaningful exactly when there IS another way round:
  // a C1 arrangement whose orientation the reader did not state.
  if (cell.classList.contains('sel')) {
    if (!canFlip(cell.dataset.arr)) return;               // C2, or the descriptor already chose
    toggleFlip(selectedUnit, cell.dataset.arr);
    // ONE REPRESENTATION, SO ONE FLIP. This read `selectedWorld = flipSelectedWorld(...)` — a second
    // flip, over the parsed copy-signature pair, kept in step with `flipWorldIR` by hand. The
    // selection IS the world IR now and `worldIRFor` applies the swap for the flip state `toggleFlip`
    // has just written, so re-deriving IS the flip. (Audit §5a.)
    selectedWorld = worldIRFor(selectedUnit, cell.dataset.arr);
    const pg = cell.querySelector('.pg');
    if (pg) pg.textContent = labelOf(cell.dataset.arr, selectedUnit);
    // AND THE TILE'S OWN GLYPH. Every other view of the selected world moved on a flip — cartoon,
    // label, material and measurement panes — while the dots the reader just clicked stayed put
    // [BB 2026-08-05]. `worldIRFor` already applies the swap, so this asks it rather than flipping a
    // second time here; `tileSvg` would apply the flip on a rebuild anyway, which is why it is given
    // the SWAPPED world with the flip state already spent.
    const svgEl = cell.querySelector('svg');
    const fw = worldIRFor(selectedUnit, cell.dataset.arr);
    if (svgEl && fw) svgEl.outerHTML = tileSvg(null, fw);
    repaintSelectedBead(topParsed);                       // the rows swap; marks change copy
    renderMaterials(parsed, key, selectedWorld);
    renderMeasurements(selectedWorld);
    return;
  }
  document.querySelectorAll('#facets .cell.sel').forEach(c => c.classList.remove('sel'));
  cell.classList.add('sel');
  selectedArr = cell.dataset.arr;
  selectedWorld = worldIRFor(selectedUnit, cell.dataset.arr);
  unitArr.set(selectedUnit, { arr: selectedArr, touched: true });  // remember this member's choice
  repaintSelectedBead(topParsed);              // cartoon mirrors the picked world
  renderMaterials(parsed, key, selectedWorld);
  renderMeasurements(selectedWorld);
});

// Builds one material card for family `m` (a materialsFromCanon() entry), re-hosting
// the existing leaf renderers (resolveContext, formatSequence,
// queryLayers+renderAmTable) behind the .su card
// markup (mockup: specs/mockups/2026-07-13-shell-materials-arrangements.html).
// `mods` is the set of modifications to actually paint on this copy (empty
// for a wild-type copy in a heterotypic split); `copyPill` is the pre-built
// `.copyn` pill markup (copy 1 / copy 2 / ×2, per the mockup). `lit` mirrors
// the mockup's buildCard(..., lit) flag: true when a world is selected and
// this card is the copy carrying that world's mark (mockup: 'su'+(lit&&isMark
// ?' sel':'')) — renders the .su.sel highlight ring tying the card back to
// the selected arrangement tile.
// Negated-mark summary pill (case 1). Withdrawn ink: a ¬ prefix, the residue
// (omitted for a positionless/global negation), and a struck token. The whole
// list of exclusions is carried by formatSequence's asterisk tooltip; this pill
// is the compact per-mark echo in the card header.
function negModPillHtml(x) {
  const base  = `${x.residue ?? ''}${x.position ?? ''}`;   // '' for a positionless global mark
  const token = x.variant ? x.variant : (x.modification ?? '');
  const what  = x.variant ? `${base}→${x.variant}` : `${base}${x.modification ?? ''}`;
  return `<span class="mark mark--absent" title="not ${what} (asserted absent)">` +
    `<span class="not">¬</span>${base}<span class="strike">${token}</span></span>`;
}

// Human-readable extent for a card head. Null/whole-chain → '' (no badge on an ordinary query).
function extentLabel(segments) {
  if (!segments || !segments.length) return '';
  if (segments.length === 1 && segments[0].start === '-inf' && segments[0].end === '+inf') return '';
  // A BOUND THAT COULD NOT BE PLACED IS NOT NAMED. Since the display frame stopped swallowing a
  // null counterpart (2026-08-07) an unplaceable endpoint arrives as null, and half an extent is
  // worse than none — the grid already refuses to DRAW one for the same reason.
  if (segments.some((x) => x && (x.start == null || x.end == null))) return '';
  const bound = (v, isStart) => (v === '-inf' ? 'N' : v === '+inf' ? 'C' : String(v));
  const parts = segments.map(x => `${bound(x.start, true)}\u2013${bound(x.end, false)} ${x.certainty === 'defined' ? 'defined' : 'native'}`);
  const all = segments.every(x => x.certainty === segments[0].certainty);
  const text = all && segments.length === 1
    ? `residues ${bound(segments[0].start, true)}\u2013${bound(segments[0].end, false)} \u00b7 ${segments[0].certainty === 'defined' ? 'defined' : 'native'}`
    : parts.join(' \u00b7 ');
  return `<span class="extenttag">${escapeHtml(text)}</span>`;
}

// Absent-unit ghost card (case 2 / case 4-heavy). Synchronous — no context/
// sequence/mass/AM resolution: the unit is claimed absent, so only the family
// rail + label + ∅ block are drawn. Mirrors the .su markup enough that it sits
// in the same column as present cards.

function buildGhostCard(m) {
  const card = document.createElement('div');
  // `sect su …`, MATCHING EVERY REAL MATERIAL CARD [2026-09-26 review, finding 4]. This was `su
  // absent-ghost` alone — the one card in the materials column that was not a `.sect` — so it
  // missed the section layout rules the spine gives every other L1 head, real or absent.
  card.className = 'sect su absent-ghost';
  const famVar = FAM_COLORVAR[m.family];
  if (famVar) card.style.setProperty('--fam', `var(${famVar})`);
  const isoTag = (m.variant && m.variant !== 'NA') ? `<span class="iso">${m.variant}</span>` : '';
  // HEAD ONLY (BB, 2026-07-30). The card used to carry a body as well: a ∅ glyph and the words
  // "H3 absent / No copy in this assembly" — which restated the family already in the title, the
  // word already in the head, and the hatching that is the whole visual point. Three sayings of one
  // fact, and the tallest card in the column belonged to the unit with the least to report. The
  // hatch moves onto the head, where the statement is.
  card.innerHTML =
    `<div class="secthd"><h3 class="sect-label">${m.family}</h3>${isoTag}` +
    `<span class="acc">absent</span></div>`;
  return card;
}

// ── THE PORT IS A DIFFERENT RETURN CONTEXT, NOT A ROUND TRIP (2026-08-07) ──────────────────────
// `port2 = abstract2(ctxIn) ∘ materialize2(ctxOut)` crossed species by manufacturing a
// species-independent coordinate to travel through. THE COLUMN ALREADY IS ONE. Measured for
// `H3:K27M`: column 258 in every species, with seven human / four mouse / three fly molecules
// answering at their own 27, 27-28 and 27. So the port is `materialize3(ir, targetCtx, reg)` — the
// same walk, returning in the other context — and the abstraction step has nothing left to do.
// (`walkNode` was already two-context: identification runs over ⊤ and only the ANSWERING set is
// filtered by ctx, which is why the column does not move.)
//
// The card holds a world COPY, not the authored member, so the port's member is found by its MARK
// COLUMNS — the species-independent coordinate, which is the same fact stated once more. A copy
// that states no mark has nothing to look up: its answer over there is every molecule of its
// family/variant, which is a registry question and not a materialization.
//
// null means the port cannot answer for this material, and the caller badges it "No target" rather
// than showing the source organism's molecules under a port badge.
function portCardNode(m, mods, portTaxon) {
  const P = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
  const REG = P && P.DEFAULT_REGISTRY;
  if (!P || !REG || portTaxon == null || typeof P.materialize3 !== 'function') return null;
  const ctx = { taxon_id: portTaxon };
  const colsOf = (xs, posKey) => (xs || [])
    .filter((x) => x && !x.negated && typeof x[posKey] === 'number')
    .map((x) => x[posKey]).sort((a, b) => a - b).join(',');
  const sig = colsOf(mods, 'position');
  if (!sig) {
    const vtoks = m.variant == null ? null
      : (typeof P.expandVariants2 === 'function' ? P.expandVariants2(m.family, [m.variant]) : [m.variant]);
    const accs = (REG.realize && REG.realize(m.family, vtoks, ctx)) || [];
    if (!accs.length) return null;
    const verdicts = {};
    accs.forEach((a) => { verdicts[a] = 'satisfies'; });   // nothing is stated, so nothing is judged
    return { family: m.family, accession: null, satisfiers: null, anchor: m.anchor,
             displayAnchor: m.displayAnchor, verdicts: verdicts, reasons: [], warnings: [] };
  }
  let node = null;
  try { node = P.materialize3(unitIR2(selectedUnit), ctx, REG); } catch (e) { return null; }
  const members = [];
  (function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (x.node === 'proteoform') { members.push(x); return; }
    (x.members || []).forEach(walk);
  })(node);
  const found = members.find((p) => p.family === m.family
                                 && colsOf(p.modifications, 'position') === sig) || null;
  // `satisfiers` for the same reason worldView carries it: `accession` is ⊤ whenever the survivors
  // are the whole family over there, and a card that reads only `accession` then names nothing.
  // ONE derivation, imported rather than repeated — see world-view-model.js.
  if (found && typeof satisfiersOf === 'function' && found.satisfiers === undefined)
    found.satisfiers = satisfiersOf(found);
  return found;
}

async function buildMaterialCard(m, mods, copyPill, key, gen, lit) {
  // THE ENGINE HANDLES, AT THE TOP OF THE FUNCTION AND NOT IN THE MIDDLE OF IT. These were declared
  // beside the mass loop, ~150 lines below their first use, and the coordinate work of 2026-08-03
  // added two earlier readers (the port anchor and the grid's `toCol`). `const` is not hoisted —
  // it is in the temporal dead zone until its declaration — so the whole card threw
  // `ReferenceError: can't access lexical declaration 'REGmat' before initialization` and the
  // materials pane rendered NOTHING. `make test` was green throughout: no suite loads this file,
  // which needs a DOM. Caught by opening the page.
  //
  // They depend on nothing local — only the parser global — so the top of the function is where
  // they belong, and a third reader added later cannot reintroduce this.
  const P2mat = (typeof nucleosomeParser2 !== 'undefined') ? nucleosomeParser2 : null;
  const REGmat = P2mat && P2mat.DEFAULT_REGISTRY;
  // THE COORDINATE WORK IS `material-card-model.js`. What the grid reads and what the reader reads
  // are different numbers — columns for the grid, the display anchor's own numbering for every pill
  // and readout — and which of the two a consumer gets is the thing this function kept getting
  // wrong. It now asks one module, which has its own suite and can be run beside the mass loop that
  // has to agree with it.
  const { dispMods, dispSegments, token } = cardFrames(m, mods, REGmat);
  // NOTE: resolveContext() already merges the per-family/variant entries of the
  // global `contextOverrides` (context-editor.js) internally — see duckdb.js:47.
  // The third arg here is the *call-level* override, used to inject the
  // query-global species lens (qcontext) below.
  // A realization slot that pinned a specific material (accession/name) forces
  // that material + species — the token wins over the query species lens
  // (precedence #1). Spread last so its uniprot_id/taxon_id override the lens.
  // The accession the IR resolved for this material, if it named one. This replaces a DuckDB
  // round-trip that answered the same question less well: a handle can resolve to more than one
  // molecule, and `resolve2`'s classify is taxon-aware where that lookup deliberately is not.
  const irAccPin = irAccessionFor(currentIR, m.family, m.variant);
  const pin = irAccPin ? { uniprot_id: irAccPin[0], accession: irAccPin } : null;
  // Only the pin. The context itself now arrives through contextOverrides / the context-level
  // default, both read straight from the editor's YAML inside resolveContext.
  const callOverride = { ...(pin ?? {}) };
  const ctx = await resolveContext(m.family, m.variant, callOverride);
  if (key !== lastKey || gen !== materialsToken) return null;         // stale-guard

  // Port drift: when active, display the PORT realization (sequence, MW,
  // accession, species) with baseline-drift + neutralized-mark overlay. seqMods
  // are port-remapped clones (never mutate the shared card mods); the
  // original `mods` stay source-framed for the mod pills and the AM query.
  let displayCtx = ctx, drift = null, seqMods = mods, portSpecies = null, portUnavailable = false;
  // Stage B: the port context is the one the GRID materializes into, so it has to outlive this
  // block. `driftIdea` is the same drift keyed by idea position — grid columns are idea positions,
  // the port sequence is in the target's own numbering, and the two keyings are not interchangeable.
  // The node the CARD reads. In the source context that is `m` itself — a world copy, which
  // materialize3 already filled with the accession set, the verdicts, the reasons and the frame.
  // Under a port it is the same query materialized in the TARGET context (see `portCardNode`).
  let cardNode = m;
  let portCtxForGrid = null, driftIdea = null, driftCol = null;
  if (ctx && portActive()) {
    // No call-level override: resolvePortContext already applies the context-level default
    // BENEATH its per-family entries. Passing it here too put it back on TOP, which is the
    // exact bug the Read as rework removed — a family block in the Show as YAML was ignored.
    const portCtx = await resolvePortContext(m.family, m.variant);
    if (key !== lastKey || gen !== materialsToken) return null;
    const portNode = portCtx ? portCardNode(m, mods, portCtx.taxon_id) : null;
    if (portCtx?.sequence && ctx.uniprot_id && portNode) {
      // Sync, from the registry frame — no DuckDB round-trip and no cache to invalidate.
      // In the QUERY'S frame on both sides: the drift map paints the grid, and the grid's columns
      // are keyed in that frame (spec 2026-07-31 §7.1).
      // R12's anchor: the marks were written under the card's token, so that token's canonical
      // member is whose numbering their numbers are in.
      const refAcc = (REGmat && REGmat.printRefOf) ? REGmat.printRefOf(token || m.family, m.family) : null;
      const alignment = portAlignment(ctx.uniprot_id, portCtx.uniprot_id, null, refAcc);
      displayCtx = portCtx;
      portCtxForGrid = portCtx;
      cardNode = portNode;                 // the grid answers in the TARGET's molecules
      drift = alignment.driftByPort;
      driftIdea = alignment.driftByIdea;
      driftCol = alignment.driftByCol;
      // Drop mods with no alignment to the port frame: rendered at their source
      // index on the port sequence they produced a bogus MW delta and a mark at
      // the wrong residue. Not alignable → not shown on the port card.
      // KEYED THE WAY THE MARKS ARE KEYED. `ideaToPort` is keyed in the ANCHOR's own numbering,
      // and since 2026-08-05 a world's marks are COLUMNS — so every lookup went in with a column
      // and came back undefined for any card whose anchor renumbers, and the mark was dropped as
      // unportable when it was only unnameable. `colToPort` is the same map with no anchor in it.
      // The legacy (non-world) call sites still hand authored numbers, and those ARE the anchor's.
      seqMods = portMods(mods, m.positionsAreColumns ? alignment.colToPort : alignment.ideaToPort,
                         portCtx.sequence, ctx.uniprot_id, null, token)
        .filter(mm => !mm._unmapped);
      portSpecies = portCtx.species;
    } else {
      portUnavailable = true;   // port is active but has no coverage for this material
    }
  }

  const card = document.createElement('div');
  // Stable across re-renders (ignores the copy split so a family stays open
  // whether shown as one ×2 card or two copy cards).
  const cardKeyId = m.key || (m.family + '|' + (m.variant ?? ''));
  // A COMPLETION FILL is withdrawn, not hidden: it is part of the particle and the reader may want
  // it, but it is not what they asked about. Same distinction the caption makes when it elides a
  // wild-type term, and the same conditional — when everything is a fill, nothing is withdrawn.
  // A MATERIAL IS OPEN WHEN THE QUERY MODIFIES IT [BB 2026-09-23: "Collapsed if they are not
  // modified"] — SEEDED into `collapsedSubs` on the query's first render, exactly as an assay
  // section is. That is the whole of the rule now: there is no second store to consult and no
  // precedence to state, because the reader's own toggle writes to the same set the default was
  // seeded into. `firstRenderOf` is what makes it once.
  const matSub = 'mat|' + cardKeyId;
  seedMaterialCollapse(matSub, materialIsMarked(dispMods));
  card.className = 'sect su' + (lit ? ' sel' : '') + (m.isFill ? ' fill' : '');
  card.dataset.cardkey = cardKeyId;   // family|variant — measurement-highlight targets this
  const famVar = FAM_COLORVAR[m.family];
  if (famVar) card.style.setProperty('--fam', `var(${famVar})`);

  // Card title: the VARIANT when the material is one (H2A.Z, not "H2A") — a variant card is a
  // statement about that variant, and with heterotypic worlds two "H2A" cards were indistinguishable.
  // Falls back to the family for a bare family material.
  const headTitle = (m.variant && m.variant !== 'NA') ? m.variant : m.family;
  // The accession is appended ONLY when it was GIVEN (a realization slot pinned this material, e.g. a
  // bare-accession query) → "H2A.Z (P0C0S5)". Deliberately NOT the accession resolveContext merely
  // picked: for a family query that is one realization of a set, not a fact about the query, and it
  // read as stale pinning (the note below still stands — the alignment grid shows the resolved set).
  const givenAcc = pin && pin.uniprot_id ? pin.uniprot_id : null;
  const accTag = givenAcc ? `<span class="acc-given">(${escapeHtml(givenAcc)})</span>` : '';
  const modPills = dispMods                                  // the reader's numbering, not the grid's
    .filter(x => x.variant || x.modification)
    .map(x => x.negated ? negModPillHtml(x)
      : `<span class="mark mark--stated"${x._unplaced
          ? ' title="this site has no counterpart in the numbering this card prints in, so it is shown without one"'
          : ''}>${x._unplaced && x.residue ? escapeHtml(x.residue) : ''}${describeMod(x).canonical}</span>`)
    .join('');
  // No resolved-token label in the card header: the accession/variant a family
  // query resolves to (e.g. "H3.1" for H3) is one realization of a set, not a
  // fact about the query — it read as stale pinning. The alignment grid inside
  // the card already shows the full resolved set.
  const portBadge = portSpecies
    ? `<span class="portbadge">→ ${portSpecies}</span>`
    : portUnavailable
      ? `<span class="portbadge portbadge-na" title="No sequence for this material in the target organism">No target</span>`
      : '';

  // Accessions the WALK RULED OUT — a mark that is physically impossible on that molecule — so
  // the AM table does not resurrect a material the sequences/mass list rejected on chemistry.
  //
  // NOT "accessions that survive" (BB, 2026-07-29). This used to keep only rows whose accession was
  // among the grid's rows, which is a MATERIAL-layer test standing in for a chemical one. Under a
  // port the grid's rows are the TARGET organism's materials, so a human→mouse port dropped every
  // human AlphaMissense row — the whole AM pane went empty, which is the opposite of the ruling that
  // a query in one organism must still reach data measured in another. Absence from the current
  // candidate set is not a verdict about the datum; being ruled out is.
  let ruledOutAccessions = null;
  let bodyHtml;
  if (!ctx) {
    // resolveContext filters taxon_id hard, so an organism we hold no sequence for lands here.
    // "No context resolved" is true but reads as a malfunction; it is a gap in OUR coverage, and
    // saying so is the same distinction the empty grid makes (spec D4.3 / Result 5). The live case
    // is yeast H3 and H4, absent from tables/proteins.parquet.
    const where = speciesNameForTaxon(effectiveTaxonFor(m.family, m.variant));
    bodyHtml = `<div class="sectbody"><p class="al-meta al-noframe">`
             + `no ${escapeHtml(m.family)} sequences are registered`
             + `${where ? ' in ' + escapeHtml(where) : ''}`
             + ` &mdash; a gap in this dataset, not in the organism</p></div>`;
  } else {
    // Possible-sequences alignment (materials-alignment-grid-design): the resolved SET
    // the query could mean, aligned on the shared coordinate with the query's mods
    // highlighted. When a port is active we keep the single port-drift sequence for now
    // (§7 unifies these into a cross-species alignment later).
    let seqSection, massSection;
    {
      // THE ROW SET IS materialize3's. `realize` offers every accession for this family/variant in
      // the context; the walk removes the ones whose sequence cannot carry the query's marks, with a
      // reason for each. Nothing is added back, and the grid/mass/AM tables all follow these rows.
      //
      // STAGE B: with a port active this node was materialized in the TARGET context — so the grid
      // answers "what does this query mean over THERE",
      // as a SET. It used to answer with a single target sequence, which could not show that the
      // question has 15 answers in human and one in yeast. Marks keep their idea positions; each
      // target material answers at its own number.
      const target = portCtxForGrid || ctx;
      // The IR's accession wins over the realization pin: it is the one object, and it resolves
      // handles the DuckDB lookup deliberately leaves open (an entry name shared across species).
      // THE CARD READS THE NODE. It used to build a fresh probe and run a SECOND materialization,
      // ignoring the accession set, verdicts and reasons `materialize3` had already put on this
      // copy — and the probe was fed own-numbers this function had corrupted, so the second pass
      // searched for a residue at a number no molecule uses and came back empty. `H2AS139ph`
      // rendered as "H2A S177ph — no sequences resolved". `cardFromNode` copies and counts; it
      // recomputes nothing, because the node IS the answer.
      const { accessions, verdicts } = cardFromNode(cardNode);
      const alnModel = await resolvedAlignment(m.family, m.variant, target.taxon_id, accessions, verdicts, dispSegments, token);
      if (key !== lastKey || gen !== materialsToken) return null;        // stale-guard
      // A NULL VERDICT IS "WE DID NOT DECIDE", not "nothing was ruled out". It reaches here only
      // from the refusal fallback, where the query denotes nothing and there is no node to read.
      ruledOutAccessions = new Set(((verdicts && verdicts.removed) || [])
        .map(w => w.accession || w.uniprot_id).filter(Boolean));
      // THE COLUMN COORDINATE FOR BOTH AXES, and the drift keying that goes with it — one call
      // into `material-card-model.js`, which holds the rulings (R24's all-or-nothing extent, the
      // anchor `materialize3` chose, "already in columns? the caller says so") and their tests.
      const { modPos, segCols, extentUnplaceable, driftCols } =
        gridCoords(m, mods, { registry: REGmat, token, driftIdea, driftCol });
      // `dispSegments` for the TEXT: the grid DRAWS `segCols` but the readout NAMES the extent, and
      // "outside the stated extent 143–225" is a coordinate the reader never wrote. (F7.)
      const grid = alignmentGridHtml(alnModel, modPos, driftCols, segCols, dispSegments);
      const extentMsg = extentUnplaceable
        ? `The stated extent cannot be placed on this alignment — ${token || m.family} has no counterpart `
          + `for one of its bounds, so it is not drawn.`
        : '';
      // No "Possible sequences" subhead — the grid's own meta line ("N sequences the
      // query could mean · aligned on family · N/M conserved") is the section header.
      // D4.3 — silent when the QUERY narrows (that is your own statement, not a loss), but never
      // silent when the CHEMISTRY empties the set: a blank pane reads the same as a failure.
      // THE REFUSAL IS A CAUSE, AND IT IS THE ONLY ONE THERE IS ON THIS PATH. When the query
      // denotes nothing there is no node to read, so there are no verdicts to explain the empty
      // set — but `materialize3` said why it refused the member, and that sentence is better than
      // the verdict-derived one it replaces: "no H2A.Z has the stated residue at 119" is the whole
      // finding. Without it the card fell back to "No sequences resolved", which reads as a
      // malfunction.
      const emptyMsg = emptySetMessage(m.family, verdicts, target.species, m.variant)
        || (!verdicts && m.refusal ? m.refusal.detail : null);
      // A number written after an accession is read in THAT molecule's numbering, but the grid
      // prints idea numbers — so a reader can take a row label and a ruler tick off one screen and
      // mean something we parse differently. Say which reading was taken and what the other one is.
      // …and on the refusal path, from the refusal's own warnings. The notice fires exactly where
      // the walk is UNPOSABLE — a pinned molecule that cannot answer its own stated number — which
      // is also exactly where materialize3 refuses the member, so there are no verdicts to read it
      // from and the refusal carries it instead.
      const frameMsg = frameNotice(verdicts)
        || (!verdicts && m.refusal
              ? frameNotice({ frameAmbiguous: (m.refusal.warnings || [])
                  .filter(w => w.reason === 'number-belongs-to-the-token') })
              : null);
      const frameHtml = (frameMsg ? `<p class="al-meta al-frameamb">${escapeHtml(frameMsg)}</p>` : '')
                      + (extentMsg ? `<p class="al-meta al-frameamb">${escapeHtml(extentMsg)}</p>` : '');
      seqSection = frameHtml + (grid
        || (emptyMsg ? `<p class="al-meta al-ruled">${escapeHtml(emptyMsg)}</p>`
                     : `<p class="al-meta">No sequences resolved</p>`));

      // Per-material masses, THE WHOLE LOOP, in `material-card-model.js`. It reads each accession's
      // OWN residue at the mark's site — so "K27M" on an accession carrying R at 27 evaluates
      // R27→M — and it is the quantity the head line's MW Δ below has to agree with. The two are
      // now one module apart and testable side by side, which they were not when this ran here.
      const massMods = massModsOf(mods);
      const hasMassMods = massMods.length > 0;
      const massRows = await massRowsFor(alnModel, massMods, !!m.positionsAreColumns, {
        registry: REGmat,
        emitMaterial: P2mat && P2mat.emitMaterial,
        markSite: markSite,
        subDelta: resolveSubstitutionDelta,
        ptmDelta: resolvePtmDelta,
      });
      if (key !== lastKey || gen !== materialsToken) return null;    // stale-guard after async
      massSection = collapsibleSubhd(cardKeyId + '|mass', 'Mass')
                  + alignmentMassTableHtml(massRows, hasMassMods);
    }

    // THE HEAD-LINE MW IS GONE (BB, 2026-08-07). A block here computed a display MW and its Δ into
    // `mwHtml` — `mwModsFor(seqMods, …)` for the wild-type letters, `totalMwDelta` for the numbers,
    // `formatMW`/`formatMWDelta` for the string — and then NOTHING read the variable. Not
    // `bodyHtml`, not `card.innerHTML`, no reader anywhere in the repo, and it was already dead at
    // 0c9fd66, so the head line has not shown a mass in some time. Removed rather than rewired: the
    // per-material mass TABLE above is the answer to the same question, per accession and with the
    // chips that justify each delta, where the head line could only ever state one number for a card
    // that resolves to a set.
    //
    // The stale-guard that followed the `await totalMwDelta` went with it, because the await went.
    // Five remain and each still stands behind its own await — resolveContext, resolvePortContext,
    // resolvedAlignment, massRowsFor, queryLayers.
    //
    // `mwModsFor`/`wildTypeAt` in `material-card-model.js` ARE GONE TOO [BB 2026-08-07]. Left
    // standing for one commit as "the only executable coverage this area has" — which was the wrong
    // reading of them. They were not coverage of the mass; they were a SECOND reader of "which
    // residue does this molecule carry here", competing with `markSite` over `cells`/`colCells`, and
    // two such readers is precisely what let the head line and the mass table print V→A and K→A for
    // one query. Deleting the display and keeping the duplicate would have left the defect class
    // intact with nothing on screen to reveal it next time.
    //
    // `mw-wildtype-axis.test.js` went with them; its one claim that outlives the display — that
    // `residueAt` and `residueAtCol` return DIFFERENT LETTERS at the columns this page queries — is
    // now in `cells-axis.test.js`, beside the count it justifies.

    // (The single display-context Mass line that used to stand in here for port cards is gone:
    // under Stage B a port card gets the same per-material mass table as any other, because it now
    // resolves to a SET of target materials rather than one.)

    bodyHtml =
      `<div class="sectbody">` +
      seqSection +
      massSection +
      `<div class="am-slots"></div>` +
      `</div>`;
  }

  // THE EXTENT, IN WORDS, ON THE HEAD. The grid band shows it, but the band lives inside the card
  // body — so a collapsed card said nothing at all about the fact that this is a peptide rather
  // than a chain, and two cards differing only in extent looked identical. Certainty comes with it,
  // because a segment states both: `[1-30]` is thirty residues exactly, `{1-30}` is thirty residues
  // open to more.
  const extentTag = extentLabel(dispSegments);               // "residues 1–30", never "143–225"
  card.innerHTML =
    // AN `<h3>`, like every other L1 head on the spine. A material is a peer of `Nucleosomes` and
    // of `Original research`; as a span it was the one section of the answer contributing nothing
    // to the document outline, which is the only structural navigation this page offers.
    `<div class="secthd sub-toggle${collapsedSubs.has(matSub) ? ' collapsed' : ''}" data-sub="${matSub}">`
    + `<h3 class="sect-label">${headTitle}</h3>${accTag}${copyPill}${modPills}` +
    `${extentTag}${portBadge}${CARET_HTML}</div>` +
    bodyHtml;

  // NO CLICK HANDLER HERE. The head is a `.sub-toggle` with a `data-sub`, so the one delegated
  // listener that collapses every other head on the page collapses this one too. A second handler
  // with its own class and its own store is what this rewrite removes.

  // Per-mod AlphaMissense (reuse the existing modification-level layer).
  if (ctx) {
    const amSlots = card.querySelector('.am-slots');
    // Skip negated marks: an asserted-absent substitution has no pathogenicity
    // claim to make (and showing it would imply the variant is present).
    // IDEA COORDINATES: `queryLayers` walks this number in each candidate's own numbering, so it
    // needs the one the reader wrote, not the column. (F4, 2026-08-05.)
    for (const dm of dispMods.filter(x => (x.variant || x.modification) && !x.negated)) {
      const modValue = isStrict() ? (dm.variant ?? dm.modification ?? null) : null;
      // `residue` is the WILD-TYPE letter, and it is what identifies the column (R5) — the walk
      // reads the stated number in each candidate's own numbering and the hard-matchers pick the
      // site. `modValue` is null in loose mode, so the PTM tier cannot be relied on to stand in.
      const resultsByLayer = await queryLayers('modification', m.family, dm.position,
        { modValue, variant: m.variant, frame: token, residue: dm.residue ?? null });
      if (key !== lastKey || gen !== materialsToken) return null;     // stale-guard
      let rows = resultsByLayer.get('alpha_missense') ?? [];
      // Drop only what chemistry ruled out; an organism the query is not currently looking at is
      // still an organism the measurement was made in.
      if (ruledOutAccessions && ruledOutAccessions.size)
        rows = rows.filter(r => !ruledOutAccessions.has(r.uniprot_id));
      if (rows.length === 0) continue;
      const label = describeMod(dm).canonical;
      const section = document.createElement('div');
      section.innerHTML = collapsibleSubhd(cardKeyId + '|am|' + label, `AlphaMissense &middot; ${label}`)
                        + `<div class="am-body"></div>`;
      amSlots.appendChild(section);
      renderAmTable(rows, { position: dm.position, slotFamily: m.family, slotVariant: m.variant }, section.querySelector('.am-body'), { showMeta: false });
    }
  }

  return card;
}

// Real material cards: re-hosts the existing leaf renderers (resolveContext,
// formatSequence, queryLayers+renderAmTable)
// behind the new .su card markup (mockup: specs/mockups/2026-07-13-shell-materials-arrangements.html).
//
// `world` (optional) is the selected tile's world IR (copies are members, not signatures;
// proteoform signatures, "" = wild-type) for the currently-selected arrangement
// tile, or null/undefined for the default family-level view. When a world is
// given, each copy shows its OWN mark by signature (modsForSig): identical
// copies (c0===c1) collapse to one ×2 card; differing copies split into copy 1 /
// copy 2, each showing its signature's mark (a wild-type "" copy shows none) —
// mirroring the mockup's renderMaterials(world)/buildCard(fk, state, copy, both, lit).
async function renderMaterials(parsed, key, world) {
  // Capture our generation before touching the DOM. Any later renderMaterials()
  // call (from a subsequent tile click or a new query) bumps materialsToken,
  // making every `gen !== materialsToken` check below fail — so a superseded
  // render's continuations bail out instead of interleaving with the new one.
  const gen = ++materialsToken;
  const host = document.getElementById('subunits');
  // THE CARDS ARE CANON'S MEMBERS. `fuseCanon` fuses meet-identical copies and leaves distinct ones
  // apart, so the pane lists what the particle IS — which is what the cartoon and the arrangements
  // have always drawn. The old `materialsModel`'s hand-rolled grouping (key on family|variant, then re-split
  // via `_proteoforms`) was a second opinion about identity; this one asks meet.
  const canon = canonNode(currentIR);
  const materials = canon ? materialsFromCanon(canon) : [];
  // AN ABSENT FAMILY HAS NO CANON MEMBER — that is what its absence means — so the ghost cards a
  // hexasome/tetrasome shows have to be put back. `absenceModel` already knows which families went
  // unseated (it reads the same `seats()` the cartoon ghosts), so this is one derivation surfacing in
  // two places rather than two derivations. Appended after the present materials: a hole is read
  // last, after what is there.
  for (const k of (absenceModel?.absentKeys ?? [])) {
    const family = String(k).split('|')[0];
    if (materials.some((m) => m.family === family)) continue;
    materials.push({ family, variant: null, count: 0, certainty: null, segments: null,
                     mods: [], _markMods: {}, hasMark: false, isFill: false, key: k, _absent: true });
  }


  // Build into a detached node list and swap it in once at the end, instead of
  // clearing the host up front and appending each card as it resolves — that
  // blanked the pane and popped cards in one at a time (flicker) on every port
  // switch / tile click. The old content stays visible until the new cards are
  // ready; a superseded render returns without swapping, leaving it untouched.
  const nodes = [];

  // (The port drift LEGEND was removed 2026-07-29. Each shading now explains itself when you point
  // at a cell that carries it — `stateData` in render.js stamps the reason on the cell, and the
  // readout under the grid words it. It was not merely redundant: two of its three swatches had gone
  // stale without anything failing. "your mark" was drawn as a red tint after marks stopped being
  // red, and "neutralized (native in target)" outlived `formatSequence`, the only renderer that
  // could ever produce that shade. A legend is a second description of the page and drifts from it
  // silently; the cell describing itself cannot.)

  // `modsForSig` stood here: it decoded a copy-signature string back into marks by splitting on ','
  // and looking the pieces up in `_markMods`. A FOURTH decoder of the format `isContentful` was
  // written to abolish, and it survived because its only caller was a branch nothing routed to.

  // v2 world path — when a concrete tile is selected AND we have its meet-derived IR, render the
  // materials straight from that world: worldView() groups identical copies (count>1) and keeps
  // distinct variants separate, so the card set mirrors the octamer exactly. This is the finish-line
  // fix for "(H2A.Z@H2A.X) → 4 loose histones" — the world model is the IR, never re-derived from the
  // arrangement string. Falls through to the legacy per-copy split below only when no IR is indexed
  // (arrays / non-enumerable units). IR mods carry `substitution`; the card renderers speak the
  // parse-tree `variant`, so adapt on the way in.
  // ONE card path (BB, 2026-07-25). This branch was reached only when a concrete tile was selected;
  // the default view fell through to a tree-derived list below. Two builders for the same pane is
  // how they drift, and the world one was already the better model — a card is a distinct
  // PROTEOFORM (family + variant + mark multiset) with a copy count, read off the IR.
  //
  // So the default view now uses it too, over the query's own particle. The visible consequence is
  // that COMPLETION shows: `(H3:K27M)` renders H3 x1 and H3:K27M x1 rather than one H3 card
  // carrying the mark, because the octamer really does have one marked and one unmarked copy — and
  // the tile view has always shown it that way. `lit` stays false with no tile selected, so nothing
  // is highlighted in the default view as before.
  // ONE SOURCE, ONE COORDINATE SYSTEM. Every query yields an interpretation now — N worlds for a
  // two-faced particle, exactly ONE for a dimer, a half-octamer or a bare material — so the pane
  // reads `worlds[i]` in every case and there is nothing left for a second builder to do.
  //
  // The default view uses the world the panel default-SELECTS anyway (`lowestC2`), so what you see
  // before clicking and what you see after clicking the first tile are the same thing.
  //
  // This was blocked until the card learned to render its DISPLAYED numbers through the anchor: a
  // world's positions are columns, and the card prints them, so `H3[1-30]` read "residues 143–225".
  // That conversion is at the top of `buildMaterialCard`; the grid still gets columns, the reader
  // still gets the molecule's own numbering.
  // THE SELECTION IS THE WORLD IR (2026-08-05, audit §5a). `world` used to be a `parseArrangement`
  // result — `{fam: [sig0, sig1]}`, copy-signature strings — so this line used it as a BOOLEAN and
  // then went back to `worldIRByArr` for the object it actually wanted. Two representations of one
  // selected thing, and the string one was a parse of a format the enumerator happens to emit.
  const worldIR = world || (unitWorld(null, selectedUnit, false) || null);
  const viewIR = worldIR || null;
  // A WORLD IS CLOSED BY DEFINITION, so every world copy carries a `defined` whole-chain extent —
  // that is what makes it one concrete world rather than a description of several, and the matcher
  // relies on it to reject candidates cheaply. It is NOT a claim the query made, and captioning it
  // as one drew a solid extent rule under `(H3:K27M)`, which is open.
  //
  // So the caption takes its whole-chain certainty from the QUERY. Only the whole-chain case: a
  // STATED extent is the user's own and passes through untouched. Fixing this in the enumerator
  // instead was tried and reverted — open world copies cost 100x on the intractable query and stop
  // being worlds at all.
  const queryParticle = relevance.referenceParticle();
  const queryExtent = new Map();
  for (const pfm of (queryParticle?.members ?? [])) {
    const fam = pfm?.family, sg = pfm?.segments;
    if (fam && Array.isArray(sg) && sg.length && isWholeChain(sg) && !queryExtent.has(fam))
      queryExtent.set(fam, sg.map((x) => ({ ...x })));
  }
  const displayExtent = (fam, segs) =>
    (segs && isWholeChain(segs) && queryExtent.has(fam)) ? queryExtent.get(fam) : segs;
  // `viewIR` is null in ONE case now: a query that enumerates NO worlds, which means the walk found
  // the site unposable — `(H2A.Z:K119ub)`, where no H2A.Z has a lysine at its own 119. The query
  // denotes nothing, but the reader still asked about something, so the branch below renders the
  // query's own materials and each card explains the empty set. That is a REFUSAL FALLBACK, not a
  // second opinion about a query that does denote something: the default view, the selected-tile
  // view and every non-particle now come through `worldView` above.
  // ── OPEN A LONE CARD, ON THE LIST THE CARDS ACTUALLY COME FROM ────────────────────────────────
  // This gate used to sit ~80 lines up, over `materials` (materialsFromCanon). That is NOT the list
  // the world path renders: those cards come from `worldView(viewIR).materials`, and the two carry
  // DIFFERENT KEYS by design — the canon key is an idea coordinate (`H3§§§native§27|K|M|…`), the
  // world key is materialized (`H3§H3.3,…§P68431,…§native§258|K|M|…`, an alignment column). So the
  // gate opened a key no card was ever built under, and a bare `H3K27M` never opened its only card
  // [BB 2026-08-11]. `materials` still feeds the ghost cards and the refusal fallback, which is what
  // it is for; it stopped being the card list when the world path became the one card path
  // (BB 2026-07-25, the comment above), and this gate did not follow.
  //
  // Counting the RENDERED cards also makes "only one card" mean what a reader sees. `(H3:K27M)`
  // enumerates a marked and an unmarked H3 copy plus the rest of the octamer — several cards — so it
  // stays collapsed for the reason the comment below gives, not by accident of which list was asked.
  // The same list the cards come from, kept whole rather than mapped to keys, because the
  // fallback below has to ask each entry whether the query marks it.
  const cardEntries = viewIR ? worldView(viewIR).materials : materials;
  const cardKeys = cardEntries.map(g => g.key);
  const isAssembly = !!(parsed && (parsed.node === 'assembly' || parsed.node === 'array'));
  // THE FALLBACK, AND IT IS ONLY A FALLBACK. The rule is that a card opens when the query modifies
  // it; this answers the case the rule cannot — a query that marks NOTHING (`(H3)`, a bare family)
  // would leave every card seeded closed and the answer looking empty, so one card is left open to
  // show what a card is.
  //
  // It must not fire when the rule has something to say, or it would open an unmarked card beside
  // the marked one the reader asked about.
  //
  // IT CLAIMS THE ID RATHER THAN OPENING ANYTHING. `firstRenderOf` is true once per (query, id),
  // so claiming the lone card's id here means the card itself finds it already seen a moment later
  // and does not seed itself closed. Expressed as an addition — `openCards.add(...)` — this was a
  // second store arguing with the first; expressed as an absence of seeding it is the same rule.
  // The fallback is now an ABSENCE of seeding rather than an addition: a query that marks nothing
  // would leave every card collapsed and the answer looking empty, so one card is exempted from
  // the seeding above by having its id marked already-seen.
  const ruleOpensSomething = cardEntries.some(g => materialIsMarked(g.mods));
  if (!ruleOpensSomething && cardKeys.length && (cardKeys.length === 1 || !isAssembly)
      && typeof firstRenderOf === 'function') {
    firstRenderOf('mat|' + cardKeys[0], queryKeyOrNull());   // claim it, so the card does not seed
  }

  if (viewIR) {
    const toParseMod = (mm) => ({ position: mm.position, residue: mm.residue,
      variant: mm.substitution ?? null, modification: mm.modification ?? null, negated: false });
    for (const m of materials) {                                     // ghosts: families absent in every world
      if (m._absent) nodes.push(buildGhostCard(m));
    }
    for (const g of worldView(viewIR).materials) {
      // No tooltip: `identical copies` on a label reading `2 copies` says the same thing twice, and
      // it was the last lowercase fragment among the page's static decorations [BB 2026-08-11]. What
      // it was reaching for — that these copies are indistinguishable, not merely counted — is a
      // fact about the GROUPING and belongs where the grouping is explained, not on the count.
      const copyPill = `<span class="copyn">${g.count} cop${g.count > 1 ? 'ies' : 'y'}</span>`;
      // PASS THE WHOLE GROUP, not a two-field copy of it. Rebuilding `{family, variant}` here threw
      // away everything else worldView had derived — `segments` and `certainty` among them — so a
      // query stating an extent reached the card with none, and the grid band, the dimming, the
      // extent-restricted mass and the head badge all had nothing to act on. Each of those looked
      // like its own unbuilt feature; there was one dropped field.
      // THE WHOLE GROUP, and that now includes `accession` and the coordinate declaration. The
      // comment above is about a dropped field; these are two more of them, and `positionsAreColumns`
      // is the one that decides whether the grid shades the right cell at all.
      const card = await buildMaterialCard({ family: g.family, variant: g.variant,
                                             // THE CARD'S IDENTITY, WHICH THIS LITERAL DROPPED.
                                             // `cardKeyId` is `m.key || family|variant`, so without
                                             // this every card on the world path was keyed `H3|` —
                                             // a different namespace from the `pfCanonKey` the
                                             // open-by-default gate and `worldView` both use. The
                                             // gate added the canon key, the card looked up the
                                             // fallback, and a bare `H3K27M` never opened its only
                                             // card [BB 2026-08-11]. Two extents also shared one
                                             // `data-cardkey`, which is the collapse
                                             // world-view-model.js:42 fixed in the MODEL and this
                                             // line quietly undid on the way to the DOM.
                                             key: g.key,
                                             segments: displayExtent(g.family, g.segments),
                                             certainty: g.certainty,
                                             accession: g.accession,
                                             anchor: g.anchor,
                                             // THE WALK'S ANSWER, WHOLE. Everything above is a
                                             // field this literal once dropped and had to be taught
                                             // again; these four are the ones the card READS rather
                                             // than displays, and without them it went back to
                                             // materializing a second time. `displayAnchor` is the
                                             // frame its numbers are printed in — not always the
                                             // anchor, which places them.
                                             displayAnchor: g.displayAnchor,
                                             verdicts: g.verdicts,
                                             reasons: g.reasons,
                                             warnings: g.warnings,
                                             positionsAreColumns: true },   // always a world now
        g.mods.map(toParseMod), copyPill, key, gen, !!world && g.mods.length > 0);
      if (key !== lastKey || gen !== materialsToken) return;
      if (card) nodes.push(card);
    }
    if (key !== lastKey || gen !== materialsToken) return;
    host.replaceChildren(...nodes);
    if (measSel.size || measHover != null) repaintMeas();
    return;
  }

  for (const m of materials) {
    // Absent unit (case 2 / case 4): the whole family/variant is claimed absent
    // — render a hollow ghost card and skip the sequence/mass/AM body entirely.
    // Independent of tile selection (an absent unit is absent in every world).
    if (m._absent) { nodes.push(buildGhostCard(m)); continue; }
    if (!world) {
      // Default view: no copy pill, never highlighted (mockup: world === null → lit = false always).
      // The `_proteoforms` branch that stood here is gone: it re-split a family whose marks the model
      // had just merged, and canon never merges them — two distinct proteoforms are two members, so
      // they arrive as two entries with two card keys.
      // THE REFUSAL TRAVELS WITH THE CARD. This loop runs only when the query enumerates no worlds,
      // which since interpret3 means materialize3 refused a member — an unposable site, an
      // unplaceable extent. There is no materialized node for the card to read, so the one thing it
      // can honestly say is why there is none.
      const matU = (typeof materializedUnit === 'function') ? materializedUnit(selectedUnit) : null;
      const refusal = ((matU && matU.refusals) || []).find(r => r.family === m.family) || null;
      const card = await buildMaterialCard(refusal ? { ...m, refusal } : m, m.mods, '', key, gen, false);
      if (key !== lastKey || gen !== materialsToken) return;
      if (card) nodes.push(card);
      continue;
    }

    // THE PER-COPY SIGNATURE SPLIT STOOD HERE, and is unreachable as of 2026-08-05. It read
    // `world[m.family]` — two copy-signature strings — and decoded each back into marks with
    // `modsForSig`, which split on ',' and looked the pieces up in `_markMods`: a FOURTH decoder of
    // the string format `isContentful` was written to abolish, surviving because nothing routed here.
    //
    // `viewIR` above is `world || unitWorld(...)`, so a non-null `world` always takes the `worldView`
    // path and never arrives here. What this loop still does is the default view (`!world`) and
    // ghosts — which is what the refusal fallback is FOR.
  }

  if (key !== lastKey || gen !== materialsToken) return;
  host.replaceChildren(...nodes);

  // Latched/hovered measurements must survive an LHS rebuild (query edit / world
  // select). If a family no longer resolves, its overlay paints nothing — a clean
  // no-op (the .meas-latched <tr>s are rebuilt by renderMeasurements).
  if (measSel.size || measHover != null) repaintMeas();
}

// Auto-complete paired brackets: ( → (), [ → [], { → {}
// With a selection, wraps the selected text: select "H3K27M", press [ → [H3K27M].
// Without a selection, inserts an empty pair and places the cursor inside.
const BRACKET_PAIRS = { '(': ')', '[': ']', '{': '}' };
inputEl.addEventListener('keydown', e => {
  const close = BRACKET_PAIRS[e.key];
  if (!close) return;
  e.preventDefault();
  const start = inputEl.selectionStart;
  const end   = inputEl.selectionEnd;
  const selected = inputEl.value.slice(start, end);
  inputEl.value = inputEl.value.slice(0, start) + e.key + selected + close + inputEl.value.slice(end);
  if (selected.length > 0) {
    // Keep the wrapped text selected (inside the brackets)
    inputEl.setSelectionRange(start + 1, start + 1 + selected.length);
  } else {
    inputEl.setSelectionRange(start + 1, start + 1);
  }
  inputEl.dispatchEvent(new Event('input'));
});

// ── RETURN RUNS THE QUERY. NOTHING ELSE DOES [BB 2026-08-25] ─────────────────────────────────────
//
// Typing used to schedule `onInput` behind a 150 ms debounce, so the page answered continuously as
// you wrote. That is what made the mark palette untestable and, more to the point, unusable: dialling
// `H3` and then reaching for `K27` ran a query at every pause in between, and each one replaced the
// answer you were building toward with an answer to a fragment.
//
// It also settles a split the page was already living with. The atlas has SET-not-RUN since
// 2026-08-24 — "answering each of 175 targets on the way past is not reading, it is being
// interrupted" — while the field it writes into ran on every keystroke. Same argument, so now the
// same rule: composing is free, and Return is the one gesture that asks.
//
// `input` keeps only the CHROME. `syncChips` hides the example strip on the first keystroke, which
// is the field acknowledging you rather than an answer.
inputEl.addEventListener('input', () => {
  errorRequested = false;                      // editing withdraws a request to see the error
  // The `window.` guard is not about ordering: `example-chips.js` is inlined BEFORE this file and
  // has already bound. It is there because `syncChips` is published as a `window` property rather
  // than declared — see that module's header for why the strip splits what is testable from when it
  // is asked.
  if (window.syncChips) window.syncChips();
});

// THE ONE ENTRY POINT FOR "RUN IT NOW", and it is published for the same reason `syncChips` is:
// modules cannot reach a name `shell.js` declares.
//
// Every caller that used to fake a keystroke — `dispatchEvent(new Event('input'))` — calls this
// instead. That was always the honest name for what those eight sites meant, and while typing also
// ran the query the two were indistinguishable; now they are not, and a synthetic `input` means
// exactly what a real one does: the text changed, update the chrome.
// IT UPDATES THE CHROME TOO, and leaving that out cost a round trip. Every caller reached `onInput`
// by dispatching `input`, and the chrome rode along on that event for free — so replacing the
// dispatch with a bare `onInput()` silently stopped tucking the example strip, and an answered page
// came up with the full-height cartoon row sitting above it. Caught by the shot diff, which went
// from 0.000% on every answered screen to 17–19% and a page 52 px taller.
//
// THE ERROR REQUEST IS RETURN'S ALONE, and the split below is what keeps that legible. `runQuery`
// clears it, because a chip, a rerender or a context change is not someone asking what is wrong —
// which is exactly what the synthetic `input` used to do on its way past. Return sets it and then
// runs, so the flag is written where the key is read and nowhere else.
//
// Written as two functions rather than one with a flag argument: `soft-failure.test.js` reads this
// file as TEXT and requires `errorRequested = true` to appear at the commit key. A parameter
// satisfied the behaviour and erased the pattern, and the guard is right that the literal is
// clearer — this is a handshake worth being able to grep for.
function runQueryNow() {
  if (window.syncChips) window.syncChips();
  onInput();
}
window.runQuery = function runQuery() {
  errorRequested = false;
  runQueryNow();
};

inputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  errorRequested = true;                       // Return means "I am done — tell me what is wrong"
  runQueryNow();
});

// GO IS RETURN, and that is the whole of it [BB 2026-09-23]. On a phone the only way to run a
// query was a keyboard key the page never named, and the dial and the marks deliberately SET the
// field without running it — so a touch user could compose and then be stuck. It sets
// `errorRequested` exactly as Return does: pressing it means "I am done", so a query that cannot
// parse must say why rather than leave the last answer standing.
// THE FOLD IS A PHONE MEASURE AND THE MARKUP ALONE COULD NOT SAY SO [BB 2026-09-23]. `<details
// open>` is open EVERYWHERE, so the phone got the dial and the 35 marks expanded and one tap from
// closed — the opposite of the measure — while the "forced open above 700px" was `cursor: default`,
// which changes the pointer and not the behaviour: a desk click still collapsed the section that
// ruling says is two columns. Both claims were false in the same direction, that CSS could carry a
// rule about WHICH STATE THE ELEMENT STARTS IN. It cannot; only the attribute can, and only script
// can set it per width. `open` stays in the markup so a phone with no JS still gets the section.
// THE LICENCE OPENS IN PLACE, AND FAILS BY NAVIGATING [BB 2026-09-23]. The footer's two items
// looked alike and behaved differently — one opened a card, one left the page, and on a phone
// leaving loses the query you typed. Now both open a card. The element stays an <a href>, so every
// way this can fail ends at the page it was always a link to: no JS, a refused fetch, an offline
// tab, a middle-click or a modified click (which is not ours to intercept).
//
// The body is fetched, not inlined: measured at 3.0 KB gzipped against a 33.1 KB boot document,
// inlining it would be +9% on the document that gates the first paint for a panel most readers
// never open. Fetched once and kept — the licence does not change while the page is open.
// ONE PANEL IDIOM (Task 9, 2026-09-23): opens through `openSheet('licence', { toggle: true })`/
// `closeSheet()` rather than writing `panel.hidden` itself, so the licence card closes any other
// open sheet on the way in, dismisses on a second press (as it always did), and is itself closed
// the moment Diagnostics (or Read as / Show as) opens. Nothing about the fetch-once-and-keep, the
// modified-click passthrough or the failure path below changed.
(function bindLicenceCard() {
  const link = document.getElementById('qlicence');
  const panel = document.getElementById('licenceeditor');
  const body = document.getElementById('licencebody');
  if (!link || !panel || !body || typeof fetch !== 'function' || typeof openSheet !== 'function') return;
  let loaded = false;
  // IN FLIGHT IS NOT THE SAME AS LOADED, and `loaded` alone could not tell them apart. It is set at
  // the END of a successful fetch, so between the first press and the response every further press
  // took the `!loaded` branch: open, close, open issued a SECOND request for the same document and
  // both responses called `replaceChildren` on the panel. One fetch at a time, and a press that
  // arrives mid-flight just toggles.
  let inFlight = false;
  link.addEventListener('click', async (e) => {
    // A reader asking for a new tab or a saved link is asking for the PAGE. Leave those alone.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    e.preventDefault();
    if (!loaded && !inFlight) {
      // THE TOGGLE DECIDES FIRST, and 'Loading…' is written only if it opened. Writing it up here
      // wiped the panel's body on a press that CLOSED it — including the body of a fetch still on
      // its way — so reopening showed 'Loading…' over content that had already arrived.
      openSheet('licence', { toggle: true });
      if (panel.hidden) return;               // the toggle just closed it — nothing to fetch
      body.textContent = 'Loading…';
      inFlight = true;
      try {
        const res = await fetch(link.href, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const main = doc.querySelector('main.doc');
        if (!main) throw new Error('no main.doc in /licence/');
        // THE WRAPPER IS THE TYPOGRAPHY [BB 2026-09-23]. Every rule in _docpage.scss is nested
        // inside `.docpage` — the serif face, the measure, the definition list, the heading scale.
        // Injecting `main.childNodes` dropped both classes, so the content landed with the SHELL's
        // defaults instead: monospace, and dl spacing meant for a data panel. It read as a
        // typewriter with the line breaks typed in, which is what BB saw. Keep the whole subtree,
        // wrapper and all, and the same markup reads as a page at /licence/ and as a card here.
        const wrap = document.createElement('div');
        wrap.className = 'docpage';
        wrap.appendChild(main);
        body.replaceChildren(wrap);
        // THE SECOND CALL SITE [BB 2026-09-24]. `main` carries `#feedback-contact` — a bare span
        // with `data-email-user`/`data-email-host` and a `<noscript>` fallback, per
        // `licence-body.html`, never a `<script>` of its own — and `assembleFeedbackContact` is
        // what turns that span into the mailto link on the standalone `/licence/` page, run there
        // from its own page-load wiring. This injected subtree has no page-load wiring of its own
        // — `DOMParser` output is inert until something acts on it — so the same function is called
        // here explicitly, once, on the subtree that just landed.
        if (typeof assembleFeedbackContact === 'function') assembleFeedbackContact(wrap);
        loaded = true;
      } catch (err) {
        // The link still works. Say so by using it, rather than reporting a failure the reader
        // can do nothing with — this is the one place a fallback is a whole page away.
        console.warn('licence card unavailable, navigating instead:', err);
        window.location.href = link.href;
      } finally {
        inFlight = false;
      }
      return;
    }
    openSheet('licence', { toggle: true });
  });
})();

// ── THE FOOTER MEASURES ITSELF ──────────────────────────────────────────────────────────────────
// The footer is `position: fixed`, so it reserves no space and `.shell` pads its own bottom by
// --foot-h to clear it. That token cannot be a constant: the footer WRAPS — four controls do not
// fit one line at 402px — so its height is a function of the width, the type scale and the length
// of the words in it. Shipped at a fixed 46px it was right at desk width and 34px short on a
// phone, and a clearance that is short hides the last row of the last table with no symptom
// anywhere: the row is simply never reachable.
//
// So the element reports its own box. The declared --foot-h stays as the no-JS fallback.
//
// ON `.shell`, WHERE THE TOKEN LIVES. Writing it to documentElement would put it in the `:root`
// vocabulary, which docs/CLAUDE.md keeps strictly apart from `.shell`'s — and the clearance rule
// reads it from `.shell`, so it would not see it there anyway.
(function bindFooterHeight() {
  const foot = document.querySelector('.sitefoot');
  const shell = document.querySelector('.shell');
  if (!foot || !shell) return;
  // GUARDED THE SAME WAY --topbar-h IS, and for the same reason: the stub DOM the render suites
  // run against has no geometry, and an unguarded call throws at LOAD — which takes the whole
  // module with it, the failure `page-consumers` exists to name.
  const apply = () => {
    // A sheet un-pins the footer (`position: static`, _sheet.scss) and it is then in flow and
    // clearing itself, so measuring at that moment would write a height the page also reserves.
    if (document.body && document.body.classList
        && document.body.classList.contains('sheet-open')) return;
    const r = typeof foot.getBoundingClientRect === 'function' ? foot.getBoundingClientRect() : null;
    const h = Math.ceil((r && r.height) || foot.offsetHeight || 0);
    // CEIL, not floor. The two errors are not symmetric: over-clearing costs a strip of blank page,
    // under-clearing hides a row of the answer under the bar where nothing can reach it.
    if (h > 0 && shell.style && typeof shell.style.setProperty === 'function') {
      shell.style.setProperty('--foot-h', h + 'px');
    }
  };
  apply();
  if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(foot);
  // EXPOSED FOR `closeSheet()` [2026-09-26 review, finding 1]. The `sheet-open` bail-out above and
  // the observer are not enough on their own: a sheet un-pins the footer WITHOUT changing its
  // content height, so the RO never fires for that transition either way. Measured harm — open
  // Diagnostics on a phone (`sheet-open` set), rotate to landscape so `.footrow` goes from two
  // lines to one: the RO fires mid-rotation and is skipped by the bail-out above, and closing the
  // sheet afterward fires no RO at all (closing restores `position: fixed`, which is not a resize).
  // `--foot-h` is then left at the two-line value while the footer is one line tall, which
  // OVER-clears — the harmless direction. Rotate the other way (portrait, sheet open, back to
  // landscape) and the stale value UNDER-clears, hiding a row of the answer under the fixed bar —
  // exactly what the `Math.ceil` comment above forbids. `sheet.js` loads before this module (app.js)
  // but calls this well after load, once a reader actually closes something, so the ordering is
  // safe the same way `contextOverrideForQuery`'s `typeof` guard is (docs/CLAUDE.md).
  Object.assign(globalThis, { refreshFootHeight: apply });
})();

(function bindProteinFold() {
  const fold = document.getElementById('protein-fold');
  if (!fold || typeof window.matchMedia !== 'function') return;
  // 1100px, THE ONE THRESHOLD [BB 2026-09-23] — not 700. The stylesheet decides where the caret
  // shows and where the summary stops inviting a click; this decides which state the section opens
  // in and whether the click does anything. Two numbers for one boundary means a band of widths
  // where the page offers a control that has been disabled: at 900px the caret drew, the cursor
  // said pointer, and the click was swallowed.
  const phone = window.matchMedia('(max-width: 1100px)');
  const apply = () => { fold.open = !phone.matches; };
  apply();
  // Crossing the breakpoint re-decides: at desk width the section is not foldable at all, so a
  // choice made at phone width has nothing to carry over into.
  if (typeof phone.addEventListener === 'function') phone.addEventListener('change', apply);
  // Above the breakpoint the summary is inert. preventDefault on the click is what actually stops
  // the toggle; the cursor rule beside it in _shell.scss only ever said it was inert.
  fold.addEventListener('click', (e) => {
    if (!phone.matches && e.target && e.target.closest && e.target.closest('summary')) e.preventDefault();
  });
})();

const goBtn = document.getElementById('qgo');
if (goBtn) goBtn.addEventListener('click', () => {
  inputEl.focus();
  errorRequested = true;
  runQueryNow();
});

// THE SPECIES LENS LIVES IN `species-lens.js` (U7, 2026-08-15) — the organism maps, the two
// menus, the Read-as/Show-as controls and the overrides they resolve to. It owns `qcontext` and
// `qport`, which is why `contextOverrideForQuery` went with it and `notation-canon.js` no longer
// needs an installer to be handed the lens: it is an ordinary module export now.
//
// `rerender` is one host entry because the two lines are one idea. `lastKey` is declared in
// index.html's own script block rather than in any module, so it is exactly as unreachable from a
// module as a shell.js declaration is.
configureSpeciesLens({
  rerender: () => { lastKey = null; window.runQuery(); },
});


// ONE PANEL IDIOM (Task 9, 2026-09-23): every sheet's × routes through `closeSheet()` rather than
// hiding only its own `.qeditor` — the four now share one close path, the same way they share one
// open path (openSheet). sheet.js is always present on the real page, and in the node suites the
// stub `querySelectorAll` returns `[]`, so this never runs without `closeSheet` defined; there is
// no per-panel fallback to fall back to.
document.querySelectorAll('.qeclose').forEach(b => {
  b.addEventListener('click', () => { closeSheet(); });
});


// THE EXAMPLE CHIPS ARE IN `example-chips.js` (U6, 2026-08-15). Chrome, and the only unit in the
// seam map that nothing else is entangled with in either direction — it reads the query field and
// whether there is an answer on screen, and that is the whole of it.
configureChips({
  queryInput: () => inputEl,
  currentIR:  () => currentIR,
});

// THE FRONT-PAGE ATLAS (graphics/variants/, promoted into _includes/variant-atlas.svg). Chrome, on
// the same footing as the chips: it reads the query field and writes to it, and knows nothing about
// how a query is run. Its visibility is #onboarding's, so nothing here has to hide it.
configureVariantAtlas({
  queryInput: () => inputEl,
});

// THE MARK PALETTE, on the same footing as the chips and the atlas: it reads the query field and
// writes to it, and knows nothing about how a query is run. `inputEl` is DECLARED in this file, so
// the module can only reach it through this host — a module that named it directly would pass every
// node suite and resolve to nothing on the page.
configureToppings({
  queryInput: () => inputEl,
});

// Test affordance: pre-fill the query from `?q=` and route it through the
// normal input handler. If the DB isn't ready yet, onInput() defers and the
// dbReady() boot below re-dispatches — same path a hand-typed query takes.
// Absent the param this is a no-op (default behavior unchanged).
// THE MENU STATE HAS TO BE DECLARED, NOT ASSUMED. `showOnboarding` is what sets `menu-open`, and
// until Return-to-run landed it was reached on the first keystroke of every session via
// `setEmpty()`. Now nothing runs at boot, so on a fresh page the class was never written and the
// example strip — which reads it — came up tucked on a page that is entirely menu.
(function declareMenuState() {
  showOnboarding(!String(inputEl.value || '').trim());
})();

(function prefillQueryParam() {
  const q = _harnessParams.get('q');
  if (q === null) return;
  inputEl.value = q;
  window.runQuery();
})();

// ── Boot ──────────────────────────────────────────────────────────────────

ensureBeadDefs();   // preload bead defs in parallel with DuckDB init

dbReady().then(async () => {
  // The organism menus are built from the data, so they cannot exist before it does. A failure here
  // must not take the page down with it: the seeded human default still resolves, so we log and
  // carry on rather than leaving the user with no materials at all.
  // The atlas repaints itself from here without being asked: `loadSpecies` ends in
  // `updateControls`, which is where every path that moves the read-as organism converges and where
  // the figure is now redrawn. It matters at boot because the atlas paints its resting ring while
  // `SPECIES_TAXON` is still the seeded `{Hs: 9606}` — right for the default, stale for a restored
  // session in any other organism.
  try { await loadSpecies(); } catch (e) { console.warn('species list unavailable:', e); }
  bootStatus(null);   // the boot line has said everything it had to say
  // If the user typed while the WASM was still loading, they saw
  // "Loading data…" and lastKey is already set — re-dispatch so the
  // materials actually render now that db is ready.
  if (inputEl.value.trim()) { lastKey = null; window.runQuery(); }
}).catch(err => {
  bootStatus(`Could not load the data: ${err.message}`, { error: true });
  renderUnitError('physics',
    `<div class="errhd">Database error</div><p>${escapeHtml(err.message)}</p>`);
});

