# violet-insight-normalizer

`normalize(mediaId, results, selection)` is one pure function. It folds asynchronous analysis results from a provider for one public conversation into one deterministic insight record. An API and a product UI can read that record. The code is TypeScript. zod defines the input contract. vitest runs the tests. There is no UI, API, persistence or pipeline, as the brief asks.

## Run

```
pnpm install
pnpm test        # 3 vitest tests
pnpm typecheck   # tsc --noEmit, strict
```

The code needs Node 22.12 or newer, because it uses `toSorted`, `Map.groupBy` and vitest 4.

## Contract (`src/contracts.ts`)

- **Input.** A `ProviderResult` is one snapshot of one category for one analysis run. The categories (`kind`) are transcript, topic, phrase, person, place, object and sentiment. A result has these fields: `resultId`, `mediaId`, `provider`, `modelVersion`, `runId`, `revision`, `state` (`partial`, `complete` or `failed`), `producedAt`, `receivedAt`, an optional `analyzedSpans` list, and `items`. Each item has an `observationId`, a `value` whose shape depends on the category, an optional `span`, and a `confidence` typed as `unknown`. The module exports the zod schema. The ingestion adapter parses raw payloads with the schema at the boundary and passes the parsed output to the function, not the raw object. The function checks meaning, not shape. The record is a snapshot and shares no objects with the input.
- **Selection.** `{ provider, runId, expectedKinds }` tells the function which run is the source of truth and which categories the caller asked for.
- **Output.** The `InsightRecord` has `schemaVersion`, `mediaId`, `selection`, `categories`, `insights` and `issues`. `categories[kind]` has a status (`not_requested`, `pending`, `partial`, `complete`, `failed` or `conflict`), the winning revision, the analyzed spans and the source result. Each `Insight` has a `source` with provider, model version, run, result, produced time and received time. `issues` lists every ignored, superseded, duplicated, conflicting, withheld or invalid item, with its category (`kind`) and its ids.

## Invariants

- The same set of deliveries gives a deep-equal record in any order. A repeated delivery changes nothing in `categories` or `insights`. It adds one duplicate entry to `issues`, because the function must report duplicates. The function reads no clock, uses no randomness and does not change its input.
- Only the selected run contributes insights. The function reports results from other runs as ignored and never mixes them in. A newer model becomes the truth when someone selects it. It does not become the truth because it arrived later or because its version string sorts higher.
- Inside a category, the highest `revision` replaces lower ones. A late lower revision cannot bring back removed observations. An empty complete snapshot means "analyzed, nothing found" and clears the category.
- Two deliveries of the same `resultId` with identical content are a duplicate. The function keeps one. `receivedAt` is receiver metadata and does not count as content. Two deliveries of the same `resultId` with different content are a conflict. Then the category reports `conflict` and gives no insights, unless a clean result with a strictly higher revision exists. The function names each withheld clean result in `issues`. The function compares `producedAt` as an instant and ignores the order of `items` and `analyzedSpans`. A different timezone offset or a re-serialized list is therefore not different content. The same rule applies to a repeated `observationId` inside one result: identical copies collapse into one, and the function drops and reports copies that differ.
- Two different results at the same highest revision are a conflict. The function does not break the tie by timestamp.
- Missing confidence is `null`, never 0 or 1. A non-finite or out-of-range confidence also becomes `null`. The function reports it and keeps the observation.
- The function never merges observations by label. Two "Alex" mentions stay two insights. Identity resolution is a product decision downstream.
- A category that the caller expected but the provider never delivered is `pending`, not silently empty. Absence is never success.
- Nothing disappears silently. Each ignored, superseded, duplicated, withheld or invalid item has an issue entry with its ids.
- A category's status says what the provider delivered: `complete`, `partial` or `failed`. Evidence removed because of an observation conflict is visible in `issues`, not in the status.

## Assumptions

- The provider or the ingestion adapter stamps `revision` per category and per run in source order. Arrival order carries no meaning.
- `observationId` is stable inside one run. The function assumes no identity across runs. That is why runs never mix.
- One selection names one provider and one run. Fusing providers is out of scope.
- Confidence is a number from 0 to 1. Other scales are an adapter concern.
- The schema trims whitespace from labels. The function does not change case and does not remove diacritics, because for a person's name that changes identity.
- The function carries `sentiment.targetId` but does not interpret it. See the product question.
- `toInsight` holds the only type cast in `src/`. TypeScript cannot correlate a member of the discriminated input union with the matching member of the output union (TS issue 30581). Both sides are exactly typed. The cast is the seam.

## Production risk, product question, and how to verify quality

**Risk.** Misattribution: a statement or a sentiment attached to the wrong named person from a public conversation. It is a privacy harm even though the audio is public. It is invisible in aggregate dashboards. The function answers with no label merging, provenance per mention, and explicit run selection, so two models never blend silently.

**Product question.** Is "brand sentiment" the tone of the conversation, or opinions directed at a specific brand? Untargeted sentiment is conversation-level evidence. A brand dashboard that shows it makes a claim the data does not support. The answer changes labeling, aggregation and what the UI may show.

**Verifying quality.** Build a small evaluation set with appropriate consent, stratified by accent, language, cross-talk, sarcasm and brand ambiguity. Two annotators label mentions and sentiment targets independently. Adjudicate disagreements. Track precision and recall per category and per slice, plus calibration: does confidence 0.8 mean right 80% of the time? Score a candidate model run on the same set and diff it against the current run before anyone changes the selection. In production, replay real payloads through `normalize` in CI as a determinism regression.

## AI work log

- **What AI helped with.** Two models, Claude and Codex, analysed the brief independently. They also searched my own earlier work for reusable patterns: rank guards for out-of-order webhooks, snapshot selection by explicit version, and tolerant vendor schemas with strict internal types. Claude drafted the scaffold, the function and the tests from a plan I approved. Codex then reviewed the result adversarially.
- **What I verified or corrected.** I checked every precedent the models cited in the source before I used it. I checked three claims. Three were correct, and one had the wrong line number. I ran the tests and did not assume them. The order test replays fixed permutations and checks that the input did not change. Three review passes ran on the result: an adversarial Codex review, a Codex sweep against a corpus of remarks from my own past code reviews, and a multi-agent Claude review. I triaged every finding by hand and applied most of them across four fix commits. The git history shows each round. The two findings that mattered most were both my own mistakes. A redelivery that differed only in `receivedAt` counted as a conflict. A conflict on an already superseded revision poisoned the whole category.
- **What judgment remained mine, and one suggestion I rejected.** I chose explicit run selection instead of my first idea, in which the newest `producedAt` wins. I chose no merging by label. I chose to keep observations with invalid confidence instead of dropping them. I rejected a `minConfidence` option inside `normalize`. A filter in the core hides evidence. Thresholds belong to the product at the read boundary.

I rejected these other review suggestions, with the reason for each:

- Drop an observation whose confidence is invalid. That loses evidence of a score bug.
- Model `CategoryState` as a discriminated union that carries the rival candidates of a conflict. The conflict issue already names them, and the change would not fit the timebox.
- Collapse the confidence classification to a boolean. A consumer needs the difference between "not provided" and "provided but unusable".
- Build the category record with a type cast instead of the explicit literal with seven keys.

## Time

I spent about 30 minutes before the clock on the brief, getibble.com, getviolet.io and a design discussion with two models. The implementation clock ran on 2026-09-10 from 17:39 to 18:04. That time covered the scaffold, the contracts, the function, the tests, this README and one review round.

## After the timebox

The implementation clock stopped at 18:04. Two more commits landed after it. Both carry the label `post-timebox` in the history. A multi-agent review that was still running finished late and confirmed five gaps. The two commits fix those gaps and nothing else:

- `Issue` now carries `kind`. A consumer can pair a conflict entry with its category when more than one category is in conflict.
- The function groups deliveries per category and result id.
- The order of `items` and `analyzedSpans` no longer counts as content when the function compares repeated deliveries.
- The function chooses the representative among identical deliveries deterministically, even when only the timestamp format differs.
- Two copies of an observation that differ only in the type of an unusable confidence value count as the same evidence.

Tests 2 and 3 gained the branches that had no assertion: rivals at the same revision, conflicting observation copies, a media mismatch, an unexpected category and the `failed` state.

## Why this shape fits Violet

Ultra Violet sells brands real-time sentiment from public conversations on ibble. A record that changes with each model version, or that quietly merges two people, reaches a customer's dashboard as a fact. Stability across reprocessing and honest uncertainty are the product, not polish.
