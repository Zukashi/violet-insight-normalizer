import { describe, expect, it } from 'vitest';

import {
  INSIGHT_RECORD_SCHEMA_VERSION,
  ISSUE_CODE,
  providerResultSchema,
  type ProviderResult,
  type Selection
} from './contracts.js';
import { normalize } from './normalize.js';

const MEDIA_ID = 'media-1';
const PROVIDER = 'mock-provider';
const FIRST_RUN = 'run-1';
const SECOND_RUN = 'run-2';

const secondRunBase = {
  mediaId: MEDIA_ID,
  provider: PROVIDER,
  modelVersion: 'model-2',
  runId: SECOND_RUN,
  revision: 1,
  state: 'complete',
  producedAt: '2026-09-10T10:00:00Z',
  receivedAt: '2026-09-10T10:00:05Z'
} as const satisfies Partial<ProviderResult>;

const firstRunBase = {
  ...secondRunBase,
  modelVersion: 'model-1',
  runId: FIRST_RUN,
  producedAt: '2026-09-09T10:00:00Z',
  receivedAt: '2026-09-09T10:00:05Z'
} as const satisfies Partial<ProviderResult>;

describe('normalize', () => {
  it('turns complete results of a selected run into a sorted record with provenance', () => {
    // given
    const selection = {
      provider: PROVIDER,
      runId: SECOND_RUN,
      expectedKinds: ['transcript', 'topic', 'sentiment']
    } satisfies Selection;
    const transcript = {
      ...secondRunBase,
      kind: 'transcript',
      resultId: 'res-transcript',
      analyzedSpans: [{ startMs: 0, endMs: 10_000 }],
      items: [
        { observationId: 'seg-2', value: { text: 'and that is why I switched' }, span: { startMs: 5_000, endMs: 10_000 }, confidence: 0.8 },
        { observationId: 'seg-1', value: { text: 'I used to edit everything myself' }, span: { startMs: 0, endMs: 5_000 }, confidence: 0.9 }
      ]
    } satisfies ProviderResult;
    const topics = {
      ...secondRunBase,
      kind: 'topic',
      resultId: 'res-topic',
      analyzedSpans: [{ startMs: 0, endMs: 10_000 }],
      items: [
        { observationId: 't-1', value: { label: 'Podcast editing' }, confidence: 0.7 },
        { observationId: 't-2', value: { label: 'Creator tools' }, confidence: 0.6 }
      ]
    } satisfies ProviderResult;
    const sentiment = {
      ...secondRunBase,
      kind: 'sentiment',
      resultId: 'res-sentiment',
      analyzedSpans: [{ startMs: 0, endMs: 10_000 }],
      items: [
        { observationId: 's-1', value: { polarity: 'positive', targetId: 'brand-42' }, span: { startMs: 5_000, endMs: 10_000 }, confidence: 0.55 }
      ]
    } satisfies ProviderResult;
    const results = [sentiment, topics, transcript].map((result) => providerResultSchema.parse(result));

    // when
    const record = normalize(MEDIA_ID, results, selection);

    // then
    expect(record.schemaVersion).toBe(INSIGHT_RECORD_SCHEMA_VERSION);
    expect(record.mediaId).toBe(MEDIA_ID);
    expect(record.issues).toEqual([]);
    expect(record.insights.map((insight) => [insight.kind, insight.observationId, insight.confidence])).toEqual([
      ['transcript', 'seg-1', 0.9],
      ['transcript', 'seg-2', 0.8],
      ['topic', 't-1', 0.7],
      ['topic', 't-2', 0.6],
      ['sentiment', 's-1', 0.55]
    ]);
    expect(record.insights[4]).toEqual({
      id: 'mock-provider/run-2/sentiment/s-1',
      kind: 'sentiment',
      observationId: 's-1',
      value: { polarity: 'positive', targetId: 'brand-42' },
      span: { startMs: 5_000, endMs: 10_000 },
      confidence: 0.55,
      source: {
        provider: PROVIDER,
        modelVersion: 'model-2',
        runId: SECOND_RUN,
        resultId: 'res-sentiment',
        producedAt: '2026-09-10T10:00:00Z',
        receivedAt: '2026-09-10T10:00:05Z'
      }
    });
    expect(record.categories.transcript).toEqual({
      status: 'complete',
      revision: 1,
      analyzedSpans: [{ startMs: 0, endMs: 10_000 }],
      source: expect.objectContaining({ resultId: 'res-transcript', modelVersion: 'model-2' })
    });
    expect(record.categories.topic.status).toBe('complete');
    expect(record.categories.sentiment.status).toBe('complete');
    expect(record.categories.person).toEqual({ status: 'not_requested', revision: null, analyzedSpans: null, source: null });
  });

  it('converges to the same record for any delivery order and repeated deliveries, without resurrecting removed observations', () => {
    // given
    const selection = { provider: PROVIDER, runId: SECOND_RUN, expectedKinds: ['topic'] } satisfies Selection;
    const firstRevision = {
      ...secondRunBase,
      kind: 'topic',
      resultId: 'res-topic-rev-1',
      revision: 1,
      items: [
        { observationId: 't-a', value: { label: 'Audience growth' }, confidence: 0.6 },
        { observationId: 't-b', value: { label: 'Merch' }, confidence: 0.4 }
      ]
    } satisfies ProviderResult;
    const secondRevision = {
      ...secondRunBase,
      kind: 'topic',
      resultId: 'res-topic-rev-2',
      revision: 2,
      producedAt: '2026-09-10T10:01:00Z',
      items: [{ observationId: 't-a', value: { label: 'Audience growth' }, confidence: 0.65 }]
    } satisfies ProviderResult;
    const retriedSecondRevision = { ...secondRevision, receivedAt: '2026-09-10T10:02:00Z' } satisfies ProviderResult;
    const delivered = [retriedSecondRevision, firstRevision, secondRevision];
    const deliveredSnapshot: unknown = JSON.parse(JSON.stringify(delivered));
    const permutations = [
      [firstRevision, secondRevision, retriedSecondRevision],
      [secondRevision, retriedSecondRevision, firstRevision],
      [secondRevision, firstRevision, retriedSecondRevision]
    ];
    const conflictingRedelivery = {
      ...secondRevision,
      items: [{ observationId: 't-a', value: { label: 'Audience growth' }, confidence: 0.9 }]
    } satisfies ProviderResult;

    // when
    const record = normalize(MEDIA_ID, delivered, selection);
    const replayed = permutations.map((permutation) => normalize(MEDIA_ID, permutation, selection));
    const conflicted = normalize(MEDIA_ID, [...delivered, conflictingRedelivery], selection);

    // then
    expect(record.insights.map((insight) => [insight.observationId, insight.source.resultId, insight.confidence])).toEqual([
      ['t-a', 'res-topic-rev-2', 0.65]
    ]);
    expect(record.insights[0]?.source.receivedAt).toBe('2026-09-10T10:00:05Z');
    expect(record.categories.topic).toEqual(
      expect.objectContaining({ status: 'complete', revision: 2, source: expect.objectContaining({ resultId: 'res-topic-rev-2' }) })
    );
    expect(record.issues).toEqual([
      { code: ISSUE_CODE.DUPLICATE_DELIVERY, resultIds: ['res-topic-rev-2'], observationIds: [] },
      { code: ISSUE_CODE.SUPERSEDED_REVISION, resultIds: ['res-topic-rev-1'], observationIds: [] }
    ]);
    for (const replay of replayed) {
      expect(replay).toEqual(record);
    }
    expect(delivered).toEqual(deliveredSnapshot);
    expect(conflicted.categories.topic).toEqual({ status: 'conflict', revision: null, analyzedSpans: null, source: null });
    expect(conflicted.insights).toEqual([]);
    expect(conflicted.issues).toEqual([
      { code: ISSUE_CODE.CONFLICTING_DELIVERY, resultIds: ['res-topic-rev-2'], observationIds: [] }
    ]);
  });

  it('keeps uncertain observations distinct and never falls back to an unselected run', () => {
    // given
    const selection = { provider: PROVIDER, runId: SECOND_RUN, expectedKinds: ['person', 'topic'] } satisfies Selection;
    const previousPeople = {
      ...firstRunBase,
      kind: 'person',
      resultId: 'res-run-1-person',
      items: [{ observationId: 'p-old', value: { label: 'Alex' }, confidence: 0.9 }]
    } satisfies ProviderResult;
    const previousTopics = {
      ...firstRunBase,
      kind: 'topic',
      resultId: 'res-run-1-topic',
      items: [{ observationId: 't-old', value: { label: 'Live events' }, confidence: 0.8 }]
    } satisfies ProviderResult;
    const reprocessedPeople = {
      ...secondRunBase,
      kind: 'person',
      resultId: 'res-run-2-person',
      state: 'partial',
      analyzedSpans: [{ startMs: 0, endMs: 30_000 }],
      items: [
        { observationId: 'p-1', value: { label: 'Alex' }, span: { startMs: 1_000, endMs: 2_000 } },
        { observationId: 'p-2', value: { label: 'Alex' }, span: { startMs: 20_000, endMs: 21_000 }, confidence: 1.7 }
      ]
    } satisfies ProviderResult;

    // when
    const record = normalize(MEDIA_ID, [previousPeople, reprocessedPeople, previousTopics, previousPeople], selection);

    // then
    expect(record.insights.map((insight) => [insight.id, insight.value, insight.confidence])).toEqual([
      ['mock-provider/run-2/person/p-1', { label: 'Alex' }, null],
      ['mock-provider/run-2/person/p-2', { label: 'Alex' }, null]
    ]);
    expect(record.insights.every((insight) => insight.source.runId === SECOND_RUN)).toBe(true);
    expect(record.categories.person).toEqual(
      expect.objectContaining({ status: 'partial', revision: 1, analyzedSpans: [{ startMs: 0, endMs: 30_000 }] })
    );
    expect(record.categories.topic).toEqual({ status: 'pending', revision: null, analyzedSpans: null, source: null });
    expect(record.issues).toEqual([
      { code: ISSUE_CODE.IGNORED_UNSELECTED_RUN, resultIds: ['res-run-1-person'], observationIds: [] },
      { code: ISSUE_CODE.IGNORED_UNSELECTED_RUN, resultIds: ['res-run-1-topic'], observationIds: [] },
      { code: ISSUE_CODE.INVALID_CONFIDENCE, resultIds: ['res-run-2-person'], observationIds: ['p-2'] }
    ]);
  });
});
