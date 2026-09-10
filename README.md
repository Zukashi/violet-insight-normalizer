# violet-insight-normalizer

One pure function, `normalize(mediaId, results, selection)`, that folds asynchronous provider analysis results for one public conversation into a deterministic insight record for an API and a product UI. TypeScript, zod for the input contract, vitest for tests. No UI, API, persistence or pipeline, as the brief asks.

## Run

```
pnpm install
pnpm test        # 3 vitest tests
pnpm typecheck   # tsc --noEmit, strict
```

Node 22.12 or newer (`toSorted`, `Map.groupBy`, vitest 4).

## Contract (`src/contracts.ts`)

- **Input** `ProviderResult`: one snapshot of one category (`kind`: transcript, topic, phrase, person, place, object, sentiment) for one analysis run. Fields: `resultId`, `mediaId`, `provider`, `modelVersion`, `runId`, `revision`, `state` (`partial` | `complete` | `failed`), `producedAt`, `receivedAt`, optional `analyzedSpans`, and `items[]`, each with `observationId`, a per-kind `value`, an optional `span` and `confidence` typed as `unknown`. The zod schema is exported; validating the shape is the ingestion adapter's job at the boundary. The function validates meaning.
- **Selection** `{ provider, runId, expectedKinds }`: the caller states which run is the source of truth and which categories it asked for.
- **Output** `InsightRecord { schemaVersion, mediaId, selection, categories, insights, issues }`. `categories[kind]` carries a status (`not_requested` | `pending` | `partial` | `complete` | `failed` | `conflict`), the winning revision, the analyzed spans and the source result. Every `Insight` carries its `source` (provider, model version, run, result, produced and received time). `issues[]` lists, by id, everything that was ignored, superseded, duplicated, conflicting or invalid.

## Invariants

- Same multiset of results gives a deep-equal record, whatever the delivery order and however many times a result is repeated. No clock, no randomness, input never mutated.
- Only the selected run contributes insights. Other runs are reported as ignored, never blended in. A newer model becomes the truth when someone selects it, not because it arrived later or because its version string sorts higher.
- Within a category the highest `revision` replaces lower ones. A late lower revision cannot resurrect removed observations. An empty complete snapshot means "analyzed, nothing found" and clears the category.
- The same `resultId` delivered twice with identical content is a duplicate and is kept once (`receivedAt` is receiver metadata and does not count as content). With different content it is a conflict: unless a clean result with a strictly higher revision exists, the category reports `conflict`, yields no insights, and any withheld clean result is named in `issues`. `producedAt` is compared as an instant, so a different timezone offset is not different content. The same rule applies to a repeated `observationId` inside one result: identical copies collapse, differing copies are dropped and reported.
- Two different results at the same highest revision are a conflict, not a tie broken by timestamp.
- Missing confidence is `null`, never 0 or 1. A non-finite or out-of-range confidence also becomes `null` and is reported, and the observation is kept.
- Observations are never merged by label. Two "Alex" mentions stay two insights. Identity resolution is a product decision downstream.
- A category that was expected but never delivered is `pending`, not silently empty. Absence is never success.
- Nothing disappears silently. Every ignored, superseded, duplicated or invalid item has an issue entry with its ids.

## Assumptions

- The provider, or the ingestion adapter, stamps `revision` per category per run in source order. Arrival order carries no meaning.
- `observationId` is stable within a run. Cross-run identity is not assumed, which is why runs never mix.
- One provider and one run per selection. Fusing providers is out of scope.
- Confidence is a number in [0, 1]. Other scales are an adapter concern.
- Labels are kept as delivered apart from whitespace trimming in the schema: no case folding, no diacritic stripping, because for a person's name that changes identity.
- `sentiment.targetId` is carried but not interpreted. See the product question.
- `toInsight` holds the only cast in `src/`: TypeScript cannot correlate a member of the discriminated input union with the matching member of the output union (TS issue 30581). Both sides are exactly typed; the cast is the seam.

## Production risk, product question, and how to verify quality

**Risk.** Misattribution: a statement or a sentiment attached to the wrong named person from a public conversation. It is a privacy harm even though the audio is public, and it is invisible in aggregate dashboards. The function's answer is no label merging, per-mention provenance, and explicit run selection so two models never blend silently.

**Product question.** Is "brand sentiment" the tone of the conversation, or opinions directed at a specific brand? Untargeted sentiment is conversation-level evidence. Showing it on a brand dashboard is a claim the data does not support. The answer changes labeling, aggregation and what the UI may show.

**Verifying quality.** Build a small, consent-appropriate evaluation set stratified by accent, language, cross-talk, sarcasm and brand ambiguity. Two annotators label mentions and sentiment targets independently; disagreements are adjudicated. Track precision and recall per category and per slice, plus calibration: does confidence 0.8 mean right 80% of the time? A candidate model run is scored on the same set and diffed against the current run before anyone changes the selection. In production, replay real payloads through `normalize` in CI as a determinism regression.

## AI work log

- **What AI helped with.** Two models (Claude, Codex) analysed the brief independently and mined my own earlier work for reusable patterns: out-of-order webhook rank guards, explicit-version snapshot selection, tolerant vendor schemas with strict internal types. Claude drafted the scaffold, the function and the tests from a plan I approved. Codex then reviewed the result adversarially.
- **What I verified or corrected.** Every precedent the models cited was checked in source before I used it (three claims checked, three confirmed, one line number wrong). Tests were run, not assumed; the order test replays three fixed permutations and checks the input was not mutated. Codex review findings were triaged by hand: REVIEW_TRIAGE.
- **What judgment remained mine, and one suggestion I rejected.** Explicit run selection instead of my first idea (newest `producedAt` wins), no merging by label, and keeping observations with invalid confidence instead of dropping them. Rejected: a `minConfidence` option inside `normalize`. Filtering in the core hides evidence; thresholds belong to the product at the read boundary.

## Time

About 1.5 hours before the clock: reading the brief, getibble.com and getviolet.io, and a design discussion across two models. Implementation clock on 2026-09-10: 17:39 to END_TIME for scaffold, contracts, function, tests, this README and one review round.

## Why this shape fits Violet

Ultra Violet sells brands real-time sentiment from public conversations on ibble. A record that flickers between model versions, or that quietly merges two people, lands in a customer's dashboard as a fact. Stability across reprocessing and honest uncertainty are the product, not polish.
