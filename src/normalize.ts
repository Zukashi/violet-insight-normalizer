import {
  INSIGHT_RECORD_SCHEMA_VERSION,
  ISSUE_CODE,
  KINDS,
  insightIdOf,
  type CategoryState,
  type CategoryStatus,
  type Insight,
  type InsightRecord,
  type Issue,
  type IssueCode,
  type Kind,
  type Observation,
  type ProviderResult,
  type ResultState,
  type Selection,
  type Source,
  type Span
} from './contracts.js';

type Categories = Record<Kind, CategoryState>;

type Selected =
  | { readonly outcome: 'none' }
  | { readonly outcome: 'conflict' }
  | { readonly outcome: 'winner'; readonly result: ProviderResult };

type Confidence =
  | { readonly status: 'known'; readonly value: number }
  | { readonly status: 'unknown'; readonly value: null }
  | { readonly status: 'invalid'; readonly value: null };

const NON_JSON_MARK = '\u0000non-json:';

export function normalize(
  mediaId: string,
  results: readonly ProviderResult[],
  selection: Selection
): InsightRecord {
  const issues: Issue[] = [];
  const admitted = results
    .toSorted((a, b) => compareResults(a, b))
    .filter((result) => admit(result, mediaId, selection, issues));
  const { distinct, conflictedKinds } = dropRepeatedDeliveries(admitted, issues);
  const categories = initialCategories(selection);
  const insights: Insight[] = [];

  for (const kind of KINDS) {
    if (conflictedKinds.has(kind)) {
      categories[kind] = conflictState();
      continue;
    }
    const selected = selectWinner(
      distinct.filter((result) => result.kind === kind),
      issues
    );
    if (selected.outcome === 'none') {
      continue;
    }
    if (selected.outcome === 'conflict') {
      categories[kind] = conflictState();
      continue;
    }
    categories[kind] = categoryStateOf(selected.result);
    insights.push(...insightsOf(selected.result, issues));
  }

  return {
    schemaVersion: INSIGHT_RECORD_SCHEMA_VERSION,
    mediaId,
    selection: { ...selection, expectedKinds: [...selection.expectedKinds] },
    categories,
    insights: insights.toSorted((a, b) => compareInsights(a, b)),
    issues: issues.toSorted((a, b) => compareIssues(a, b))
  };
}

function admit(result: ProviderResult, mediaId: string, selection: Selection, issues: Issue[]): boolean {
  const code = admissionIssue(result, mediaId, selection);
  if (code === null) {
    return true;
  }
  issues.push(issue(code, [result.resultId], []));
  return false;
}

function admissionIssue(result: ProviderResult, mediaId: string, selection: Selection): IssueCode | null {
  if (result.mediaId !== mediaId) {
    return ISSUE_CODE.MEDIA_MISMATCH;
  }
  if (result.provider !== selection.provider || result.runId !== selection.runId) {
    return ISSUE_CODE.IGNORED_UNSELECTED_RUN;
  }
  if (!selection.expectedKinds.includes(result.kind)) {
    return ISSUE_CODE.IGNORED_UNEXPECTED_KIND;
  }
  return null;
}

function dropRepeatedDeliveries(
  results: readonly ProviderResult[],
  issues: Issue[]
): { distinct: ProviderResult[]; conflictedKinds: ReadonlySet<Kind> } {
  const distinct: ProviderResult[] = [];
  const conflictedKinds = new Set<Kind>();

  for (const [resultId, deliveries] of Map.groupBy(results, (result) => result.resultId)) {
    const [first, ...repeats] = deliveries;
    if (first === undefined) {
      continue;
    }
    distinct.push(first);
    if (repeats.length === 0) {
      continue;
    }
    const firstShape = deliveryShape(first);
    const conflicting = repeats.some((repeat) => deliveryShape(repeat) !== firstShape);
    if (conflicting) {
      for (const delivery of deliveries) {
        conflictedKinds.add(delivery.kind);
      }
    }
    issues.push(issue(conflicting ? ISSUE_CODE.CONFLICTING_DELIVERY : ISSUE_CODE.DUPLICATE_DELIVERY, [resultId], []));
  }

  return { distinct, conflictedKinds };
}

function selectWinner(candidates: readonly ProviderResult[], issues: Issue[]): Selected {
  if (candidates.length === 0) {
    return { outcome: 'none' };
  }
  const highestRevision = Math.max(...candidates.map((candidate) => candidate.revision));
  const superseded = candidates.filter((candidate) => candidate.revision !== highestRevision);
  if (superseded.length > 0) {
    issues.push(issue(ISSUE_CODE.SUPERSEDED_REVISION, superseded.map((candidate) => candidate.resultId), []));
  }
  const [winner, ...rivals] = candidates.filter((candidate) => candidate.revision === highestRevision);
  if (winner === undefined) {
    return { outcome: 'none' };
  }
  if (rivals.length > 0) {
    issues.push(issue(ISSUE_CODE.CONFLICTING_REVISION, [winner, ...rivals].map((candidate) => candidate.resultId), []));
    return { outcome: 'conflict' };
  }
  return { outcome: 'winner', result: winner };
}

function categoryStateOf(result: ProviderResult): CategoryState {
  return {
    status: statusOf(result.state),
    revision: result.revision,
    analyzedSpans: result.analyzedSpans ?? null,
    source: sourceOf(result)
  };
}

function statusOf(state: ResultState): CategoryStatus {
  switch (state) {
    case 'complete':
      return 'complete';
    case 'partial':
      return 'partial';
    case 'failed':
      return 'failed';
    default: {
      const exhaustive: never = state;
      throw new Error(`Unsupported result state: ${String(exhaustive)}`);
    }
  }
}

function insightsOf(result: ProviderResult, issues: Issue[]): Insight[] {
  const items: readonly Observation[] = result.items;
  const duplicated: string[] = [];
  const conflicting: string[] = [];
  const invalidConfidence: string[] = [];
  const insights: Insight[] = [];

  for (const [observationId, copies] of Map.groupBy(items, (item) => item.observationId)) {
    const [first, ...repeats] = copies.toSorted((a, b) => compareObservations(a, b));
    if (first === undefined) {
      continue;
    }
    if (repeats.length > 0) {
      const firstShape = canonicalJson(first);
      if (repeats.some((repeat) => canonicalJson(repeat) !== firstShape)) {
        conflicting.push(observationId);
        continue;
      }
      duplicated.push(observationId);
    }
    const confidence = classifyConfidence(first.confidence);
    if (confidence.status === 'invalid') {
      invalidConfidence.push(observationId);
    }
    insights.push(toInsight(result, first, confidence.value));
  }

  if (duplicated.length > 0) {
    issues.push(issue(ISSUE_CODE.DUPLICATE_OBSERVATION, [result.resultId], duplicated.toSorted((a, b) => compareStrings(a, b))));
  }
  if (conflicting.length > 0) {
    issues.push(issue(ISSUE_CODE.CONFLICTING_OBSERVATION, [result.resultId], conflicting.toSorted((a, b) => compareStrings(a, b))));
  }
  if (invalidConfidence.length > 0) {
    issues.push(issue(ISSUE_CODE.INVALID_CONFIDENCE, [result.resultId], invalidConfidence.toSorted((a, b) => compareStrings(a, b))));
  }
  return insights;
}

function classifyConfidence(raw: unknown): Confidence {
  if (raw === undefined || raw === null) {
    return { status: 'unknown', value: null };
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return { status: 'known', value: raw };
  }
  return { status: 'invalid', value: null };
}

function toInsight(result: ProviderResult, item: Observation, confidence: number | null): Insight {
  const insight = {
    id: insightIdOf({
      provider: result.provider,
      runId: result.runId,
      kind: result.kind,
      observationId: item.observationId
    }),
    kind: result.kind,
    observationId: item.observationId,
    value: item.value,
    span: item.span ?? null,
    confidence,
    source: sourceOf(result)
  };
  return insight as Insight;
}

function sourceOf(result: ProviderResult): Source {
  return {
    provider: result.provider,
    modelVersion: result.modelVersion,
    runId: result.runId,
    resultId: result.resultId,
    producedAt: result.producedAt,
    receivedAt: result.receivedAt
  };
}

function issue(code: IssueCode, resultIds: readonly string[], observationIds: readonly string[]): Issue {
  return { code, resultIds, observationIds };
}

function conflictState(): CategoryState {
  return { status: 'conflict', revision: null, analyzedSpans: null, source: null };
}

function initialCategory(kind: Kind, selection: Selection): CategoryState {
  return {
    status: selection.expectedKinds.includes(kind) ? 'pending' : 'not_requested',
    revision: null,
    analyzedSpans: null,
    source: null
  };
}

function initialCategories(selection: Selection): Categories {
  return {
    transcript: initialCategory('transcript', selection),
    topic: initialCategory('topic', selection),
    phrase: initialCategory('phrase', selection),
    person: initialCategory('person', selection),
    place: initialCategory('place', selection),
    object: initialCategory('object', selection),
    sentiment: initialCategory('sentiment', selection)
  };
}

function deliveryShape(result: ProviderResult): string {
  const { receivedAt: _receivedAt, ...content } = result;
  return canonicalJson(content);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === 'number' && !Number.isFinite(current)) {
      return `${NON_JSON_MARK}${String(current)}`;
    }
    if (typeof current === 'bigint') {
      return `${NON_JSON_MARK}${String(current)}n`;
    }
    if (isRecord(current)) {
      return Object.fromEntries(Object.entries(current).toSorted(([a], [b]) => compareStrings(a, b)));
    }
    return current;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

function compareNumbers(a: number, b: number): number {
  return a - b;
}

function compareResults(a: ProviderResult, b: ProviderResult): number {
  return (
    compareStrings(a.provider, b.provider) ||
    compareStrings(a.runId, b.runId) ||
    compareNumbers(KINDS.indexOf(a.kind), KINDS.indexOf(b.kind)) ||
    compareNumbers(a.revision, b.revision) ||
    compareStrings(a.resultId, b.resultId) ||
    compareStrings(canonicalJson(a), canonicalJson(b))
  );
}

function compareObservations(a: Observation, b: Observation): number {
  return compareStrings(a.observationId, b.observationId) || compareStrings(canonicalJson(a), canonicalJson(b));
}

function compareSpanStarts(a: Span | null, b: Span | null): number {
  if (a === null || b === null) {
    return Number(a === null) - Number(b === null);
  }
  return compareNumbers(a.startMs, b.startMs);
}

function compareInsights(a: Insight, b: Insight): number {
  return (
    compareNumbers(KINDS.indexOf(a.kind), KINDS.indexOf(b.kind)) ||
    compareSpanStarts(a.span, b.span) ||
    compareStrings(a.observationId, b.observationId)
  );
}

function compareIssues(a: Issue, b: Issue): number {
  return (
    compareStrings(a.code, b.code) ||
    compareStrings(a.resultIds.join(','), b.resultIds.join(',')) ||
    compareStrings(a.observationIds.join(','), b.observationIds.join(','))
  );
}
