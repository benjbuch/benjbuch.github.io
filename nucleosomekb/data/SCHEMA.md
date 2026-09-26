# `docs/data/` — the shipped artifact

These parquet files are what the browser reads, and what an outside consumer gets when they
vendor this project. This file documents the four **literature** tables, which had no schema
anywhere; the registry tables (`proteins`, `protein_families`, `alignment_*`, `gene_index`,
`*_masses`, `ptm_deltas`) are documented in **`tables/SCHEMA.md`**, which describes the same
files under their build-time name.

Written 2026-08-25 in response to notes from a downstream consumer, which established each
of the traps below by hitting it. **Revised 2026-08-31** after a second round from the same
consumer: `literature_gapmap.parquet` was added, the artifact was regenerated from a curated store
it had fallen five days behind, and `taxa` became `taxon_id`. Counts are `[measured 2026-08-31]`
unless stated; where a count below is materially different from the 2026-08-25 one it is because
~500 curated mentions from ~100 papers had never been built into the artifact.

---

## Read this first: the corpus is a query result, not the literature

Membership is decided by `[tiab]` search legs over EDAT 1996–2026 — **title and abstract only**,
the same scope as extraction. A paper can therefore be invisible in two different ways:

- **In the corpus, contributing no mention.** Its sites live in tables the sweep cannot see.
- **Never admitted at all.** The search legs did not match its title or abstract.

**"No mentions" does not mean "not in the literature."** Measured by a downstream consumer:
**79% of the alleles the index called silent were in a catalog it could not see** — 104 of 131,
all in one supplementary table. That is the failure mode this file exists to warn about, and it
is invisible from inside the data: the counts simply come out low, and nothing looks wrong.

---

## `literature_papers.parquet`

One row per **study**, 43,065 rows — 43,051 in-query plus 14 out-of-query. The corpus holds
43,348 *records*; 297 are duplicates merged by `dedup.js`, so this table answers questions about
studies, not records.

**This table is no longer "the corpus, exactly" — it is the papers the artifact can cite**
[2026-09-01, `specs/2026-09-01-out-of-query-papers.md`]. A curated paper the `[tiab]` search legs
never admitted gets a row here from an authored `citation:` in `papers/PMID*/paper.yaml`, so that
its mentions have something to join to. **`admitted` says which route a row took, and asking the
old question is `WHERE admitted = 'in-query'`.** 14 out-of-query rows today; the count is not the
membership rule, the column is.

### Corpus identity

| Column | Type | Notes |
|---|---|---|
| `pmid` | VARCHAR | PubMed ID. The key everywhere. |
| `admitted` | VARCHAR | `in-query` (the search found it) or `out-of-query` (a curator read it and stated its citation). Never NULL. An out-of-query row has NULL `edat`, `pmcid`, `pub_types`, `citations` and `rcr`, and `metadata_known = 0`. |
| `edat` | DATE | Entrez date — what the 1996–2026 window is applied to, not the publication date. |
| `pmcid` | VARCHAR | PMC ID where one exists; NULL for 15,173. Presence means full text is *fetchable*, not that it was read. |
| `year`, `journal` | | 19 and 11 NULLs respectively. |
| `built`, `onco`, `variant`, `mark`, `linker`, `position` | INT | Which search leg admitted this paper — **why it is in the corpus**. A corpus fetched before a leg existed simply lacks that column. |

### Publication metadata (from PubMed + iCite, regenerable)

| Column | Type | Notes |
|---|---|---|
| `title`, `authors`, `author_n` | | `authors` is elided in the middle (`Bhat YA, Mocavini I … Rando OJ, Peterson CL`), not truncated — first and last authors both survive. |
| `indexed` | INT | 1 if MEDLINE has indexed the record. 5,697 papers are legitimately indexed=0. |
| `histone_mesh`, `histone_mesh_n`, `mesh_n` | | NLM's controlled vocabulary. A **precision** signal, never a selector — a wide MeSH set captures only 43–64% of this corpus. |
| `pub_types` | VARCHAR | NLM's raw publication-type list, `; `-separated. |
| `is_review`, `is_retracted`, `is_preprint`, `is_editorial` | INT | Derived from `pub_types`. **May be NULL — see below.** |
| `metadata_known` | INT | **1 if this paper's publication metadata was actually fetched.** |
| `citations`, `rcr` | INT / DOUBLE | iCite. `rcr` is field- and time-normalised; raw counts just rank old papers first. Both NULL where iCite does not hold the PMID (213 and 5,083). **A missing RCR is NULL, never 0** — 0 is a real value meaning "cited at the field floor". |
| `notice` | VARCHAR | Publisher marker parsed from the title: `retracted`, `withdrawn`, `retraction-notice`, or `""`. |

**`metadata_known = 0` means the four `is_*` flags are NULL, and NULL means *unknown*, not
*false*.** `enrich.js` fetches PubMed in batches of 200; a batch that exhausts its retries leaves
its rows blank and the run carries on. Until 2026-08-25 those blanks were coerced to 0, so 199
papers asserted "not retracted, not a review" on no evidence — and one of them, PMID 31504810, is
a Retracted Publication about H3 K27M. **If you filter on `is_retracted = 0`, decide deliberately
whether you mean "known not retracted" (`is_retracted = 0 AND metadata_known = 1`).** All rows are
`metadata_known = 1` for every in-query row; the 14 out-of-query rows are 0 by construction,
because nothing has fetched their publication types — see `admitted` above.

`is_retracted` also folds in `notice`: three withdrawn papers carry no retraction publication type
at all, and the marker lives only in the title. A `retraction-notice` is deliberately *not* folded
in — the notice is not itself retracted, it announces a retraction.

### Curation state

| Column | Type | Notes |
|---|---|---|
| `import_verdict` | VARCHAR | `not-assessed` (41,335 — **96%**), `NO` (919), `CONTACT` (767), `YES` (30). |
| `entity_scope` | VARCHAR | The **primary** material: `chromatin-invivo` 1,076, `no-substrate` 233, `mononucleosome` 144, `no-measurement` 125, `free-histone` 49, `array` 47, `peptide` 33. |
| `entity_scopes` | VARCHAR | **Scope is a list.** Every material a measurement was made on, `;`-separated. `entity_scope` stays the primary one so existing consumers read what they always read. |
| `substrate` | VARCHAR | mn notation for what was studied (`({H3.3:Q5H})`). NULL for 36,806. |
| `substrate_certainty` | VARCHAR | `agent` or a curator's stamp. |
| `taxon_id` | INT | NCBI taxonomy id. **Sparse by construction — 1,529 of 43,051 (3.6%)**, set only where an agent READ the paper. It is *not* a corpus-wide organism filter and cannot be made into one: the corpus search legs carry no organism term, so a NULL here means "nobody read this paper", never "not this organism". Named `taxa` until 2026-08-31, when it was migrated to the name every other table uses. |
| `agent_sampled` | INT | The hash-uniform **stratified** draw. This is the flag corpus estimates may be reweighted from. |
| `agent_selection` | VARCHAR | *Which* draw read the paper. Its `display` value is **citation-biased by construction** — do not use it for estimates. |
| `protocol_version` | VARCHAR | Which curation protocol produced the row. Versioned: rows are not comparable across versions. |
| `review_status`, `container_id` | | Currently all NULL. `container_id` closes the loop when a `data/` container names its PMID; nothing does yet. |

**96% of the corpus is `not-assessed`.** Absence of a verdict is not a negative verdict.

---

## `literature_mentions.parquet`

One row per **mention** — a descriptor found in a paper. 60,292 rows.

| Column | Type | Notes |
|---|---|---|
| `mention_id` | VARCHAR | `<layer>:<pmid>-<n>` — `MNT:` swept, `cur:` curated, `con:` container. The prefix is the `source` row below, without the join. Curated and container ids were positional (`cur:1`, `cur:2`, assigned in directory order) until 2026-09-01, so adding one record re-keyed every id after it; they are pmid-keyed now, like the swept ones always were. |
| `pmid` | VARCHAR | Repointed to the surviving study for merged duplicates. |
| `descriptor` | VARCHAR | mn notation. Join key to `literature_descriptors`. |
| `axis` | VARCHAR | `mark` 44,295 · `variant` 11,495 · `mutation` 4,401 · `site` 18; NULL for 83. **`site` is a position named with neither a substitution nor a mark** — a structure that puts the residue in a contact, an MD trajectory measuring its salt bridge. It counts as attention at the column and joins neither abstract-layer bucket. An assembly descriptor takes the axis of its members, so a particle is no longer NULL for carrying its mutation one level down. |
| `layer` | VARCHAR | `deterministic` for all 57,279 swept rows; NULL for the 2,977 that are not swept. **The agent layer never writes mentions** on these axes, and that is asserted over the shipped table. |
| `field` | VARCHAR | `abstract` 56,516 · `title` 763 · `supplementary` 1,877 · `container` 498 · `full-text` 602. **`field` follows from the curator's `read_depth`, so a new reading depth mints a new value here** — `full-text` appeared when array substrates began to be curated from Methods sections. |
| `source` | VARCHAR | `swept` 57,279 · `curated` 2,479 · `container` 498. |
| `record_kind` | VARCHAR | `catalog` 1,877 · `study` 915 · empty 57,464. **What the row asserts, and it is a fact about the PAPER** — every row a curated paper contributes carries it, on whichever layer the row came from, including the `container` layer (147 rows, which read empty until 2026-09-01 because the carry-over ran before the containers were composed in). `catalog` means the paper compiled a census, so the row says the site was *observed somewhere*, not that the paper investigated it. Empty means no curated record for that paper, not "swept layer". See `literature_gapmap` below, where this becomes a count. |
| `offset_start`, `offset_end` | INT | Character offsets into the abstract. Evidence is stored as offsets *on purpose*: the artifact points into a document you fetch from PubMed yourself, so publisher text is never redistributed. |
| `phrase_id`, `sweep_id` | VARCHAR | Which phrase pattern and which sweep produced the row. |

### `source` is the column that decides what a row *claims*

**A `swept` row is a claim; a `curated`/`supplementary` row is an observation.** They are not the
same kind of statement and they arrive on the same `axis`:

- **`swept`** — machine-mined from title/abstract. The paper *says something about* the site.
  Coverage is title and abstract **only**.
- **`curated` + `field = supplementary`** — extracted by a named curator from a table. Typically a
  catalog: *this mutation was observed in a tumour*. That is not an assertion that anyone studied
  it, or that it does anything.
- **`curated` + `field = full-text`** — extracted by a curator from Methods or Results. This is a
  CLAIM and a strong one: the paper deliberately built this material and measured it. **So `source`
  alone no longer separates claims from observations — you need `field` too.** The distinction was
  introduced when array and designer-chromatin substrates began to be curated, and it is the
  opposite polarity from the supplementary rows sitting under the same `source` value.
- **`container`** — deposited measurement data from `data/`. The deposit is thereafter the
  authority.

Measured cost of conflating them: a consumer counting "constructs we predict inert that the
literature has published on" got **41**; splitting on `source` returned **1**, and all 40
additions were catalog rows. **A consumer who joins on `axis` alone and never looks at `source`
overcounts silently** — the numbers just come out high.

Note the scale: of 4,113 mutation-axis mentions, only 1,932 are swept. Supplementary extraction is
now comparable in size to the abstract sweep on that axis.

---

## `literature_descriptors.parquet`

One row per distinct descriptor, 3,284 rows. This is the **prefilter index** for the page's
relevance query, and it is built from tracked inputs so it can always be rebuilt.

| Column | Type | Notes |
|---|---|---|
| `descriptor` | VARCHAR | mn notation, e.g. `H3:K27M`. |
| `col_keys` | VARCHAR | `family:column` for every marked member, comma-separated. NULL for 197 variant-only / family-only descriptors, where the prefilter stands down. |
| `n_keys` | INT | Number of alignment **columns**. |
| `n_alternatives` | INT | Number of **proteoforms the descriptor denotes**. |

**`n_keys` and `n_alternatives` are different questions, and using the first as the second is a
known trap.** `H3:K27A|C|D|…|Y` packs 19 alternatives at one alignment column, so its `n_keys` is
1 and its `n_alternatives` is 19. A consumer expanding the pipe and giving every allele the set's
paper count read K27N, K27R and K27T as three independent literatures with identical PMID lists.

133 of 3,284 descriptors are sets (widths 2, 3, 5 and 19). **Sets are not a mutation-axis
phenomenon** — `H3:K9me1|me2|me3` is a mark-axis set and `H4:R3me1|me2a|me2s` an arginine one.
`n_alternatives` is the product over comma-separated members, because alternation is scoped to one
member: `H3:R2me2a|me2s,K9me2` denotes 2 proteoforms, not 3.

**`col_keys` is a fact about a VERSION of the alignment.** When the H3 realignment moved K27 from
column 222 to 258, every H3 descriptor key went stale and "Further reading" returned nothing on H3
queries. See *Versioning* below.

---

## `literature_gapmap.parquet`

**Attention per position, and the zeros are the product.** One row per alignment column of every
family frame — 734 rows, 728 posable — not only the columns that have literature, because a table of
the positions that *have* attention cannot express "nobody has studied this one"; it can only fail to
mention it, and a missing row reads as an absent fact rather than a measured one.

Added 2026-08-31. Before that it was computed and written to a gitignored directory, so the only
route to "how much attention has H3 R131 had" was to regex `^H3:R131[A-Z]$` over `descriptor` —
a consumer writing a parser over our string format, over a key we do not promise.

| Column | Type | Notes |
|---|---|---|
| `family` | VARCHAR | NULL on an unposable cell. |
| `aln_column` | INT | Column index in the family MSA. **Versions with the alignment** — see *Versioning* below. |
| `family_position` | INT | The family reference member's own number there — `H3:K27` is 27. **The stable key where it exists**, and it does not always exist: see the note below. |
| `residue` | VARCHAR | The reference member's residue there. NULL on the same rows as `family_position`. |
| `n_mutation_papers`, `n_mark_papers` | INT | Abstract layer, per axis. |
| `n_papers_abstract` | INT | Distinct papers over both axes. A pure function of the swept layer. |
| `n_papers_all` | INT | The above **plus** papers read to supplementary or full-text depth. |
| `n_papers_studied` | INT | Papers contributing anything that is **not** a census row. **This is the one to read for "has anyone looked".** |
| `n_papers_catalog` | INT | Papers contributing a census row here. |
| `unposable` | INT | 1 where the walk could not identify a column. Filter `= 0` for the frame. |
| `mutation_pmids`, `mark_pmids`, `deep_pmids`, `catalog_pmids` | VARCHAR | Comma-separated. |

### `family_position` is NULL for 19 posable columns, and one of them is the second-biggest row

**This is structural, not a glitch, and it is the one trap in this table.** `family_position` is the
family REFERENCE member's own number at a column (H2A P0C0S8, H3 P68431, …). A column the reference
does not occupy — an insertion relative to it — therefore has no family-frame name at all. Measured
on the shipped table: **19 of 728 posable columns**, 18 in H2A and 1 in H2B, because H2A's reference
occupies only 129 of the family's 387 columns.

The largest of them is **`H2A` `aln_column` 177 — γH2A.X S139, with 5,199 papers**, the
second-most-attended cell in the entire map after H3 K27. Canonical H2A simply does not have that
residue; the site lives in the H2A.X C-terminal extension.

**So a join on `(family, family_position)` silently drops it, and 5,231 papers' worth of attention
with it.** Two ways to be correct:

```sql
-- the frame where it exists, the column where it does not
SELECT family, coalesce(CAST(family_position AS VARCHAR), 'col' || aln_column) AS site, ...
FROM literature_gapmap WHERE unposable = 0;
```

or join on `(family, aln_column)` throughout and **pin the alignment version** — `aln_column` covers
every column but is a fact about a VERSION of the registry (see *Versioning*, and
`NUMBERING_CHANGELOG.md` for when it last moved). The frame is stable and partial; the column is
total and versioned. There is no key that is both, and that is the "positions are alignment columns"
ruling rather than a gap someone forgot to fill.

### A catalog is not attention, and this is the count most likely to be read wrongly

Nacev 2019 (PMID 30894748) tabulates 1,877 residue changes across ~3,000 tumours, so every position
it lists has at least one paper — and 0 vs 1 is exactly the difference between *unstudied* and
*unknown*. Measured 2026-08-31:

| | posable positions |
|---|---|
| `n_papers_all = 0` | **208** |
| `n_papers_studied = 0` | **499** |

The **291** in between are positions a census names and nobody has studied.

`n_papers_studied` and `n_papers_catalog` need not sum to `n_papers_all` — a paper contributing both
a census row and an ordinary one is in both. `studied` is accumulated positively for exactly that
reason, so **do not compute `n_papers_all - n_papers_catalog`**.

```sql
SELECT family, family_position, residue, n_papers_abstract, n_papers_all, n_papers_catalog
FROM   literature_gapmap
WHERE  unposable = 0 AND n_papers_studied = 0      -- NOT n_papers_all = 0
ORDER  BY family, family_position;
```

### `n_papers_abstract` vs `n_papers_all`, and why neither is inferred from the other

The first is uniform over all 43,051 papers in the corpus; the second additionally counts papers read
to supplementary or full-text depth, which is a handful. **A zero in the first is "the field has not
named this position in any title or abstract in this corpus"** — never "not assayed". H3
`family_position` 30 and 131 are both `(0, 4)`.

---

## Versioning — what a coordinate is a fact about

Every `aln_column`, `family_position` and `variant_position` is a fact about a **version of the
registry**: the alignment, the prune threshold and the numbering are one versioned object, and any
of them moving may move all of them.

The thing to pin is **`input_sha256` in `alignment_meta.parquet`, per family — record all five.**
A stamp that pinned only one family reads as verified provenance while naming the wrong alignment.
`tables/SCHEMA.md` §*Detecting stale positions* has the full rule.

**And when it DID move: [`NUMBERING_CHANGELOG.md`](NUMBERING_CHANGELOG.md), in this directory.** The
hash tells you the version you hold is not the one that ships; the changelog tells you when it
changed, what happened, and — the column that matters — **how many residues actually landed in a
different `aln_column`**. Those are different questions: admitting a member re-runs the MSA and
changes the version even where every existing index survives. Both cases are in the history —
`ffcfd44` bumped H3 with **0** residues moved, `bdefd76` moved **3,963**. It is generated from git
history of the shipped parquet, never hand-appended.

**A variant rename is not a coordinate move, and from outside they look identical.** `caH1 →
H1.1–H1.5` and `H2A.1 / H2B.1 → caH2A / caH2B` both surfaced to a consumer as failing tests, and
distinguishing them required recomputing per-family hashes by hand. `release_manifest.json` ships
that comparison — see below.

---

## `release_manifest.json`

A small tracked JSON capturing everything that defines coordinates and vocabulary at build time,
so two releases can be diffed without recomputing anything:

- per family: `n_members`, `n_columns`, `input_sha256`, `aln_version`
- the variant vocabulary: every token, its family, its `within:` parent and its reference
- table row counts

Regenerate with `make release-manifest`; diff two copies with
`Rscript scripts/diff_release_manifest.R <old.json>`, which prints, per family, whether the
numbering moved — and separately, which variant tokens were added, removed or re-parented. That is
the assertion *"numbering unchanged; these variants were renamed"*, which this project has always
had the data to make and did not ship.

---

## Not covered here

`docs/_data/literature.yml` carries the reading-effort counts behind the "Further reading"
empty-state note (full-text reads, abstract reads, publication span). Two of its three numbers are
not in the parquet and cannot be queried from it.
