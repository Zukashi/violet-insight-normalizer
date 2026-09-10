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

const CONFLICT_STATE: CategoryState = { status: 'conflict', revision: null, analyzedSpans: null, source: null };

export function normalize(
  mediaId: string,
  results: readonly ProviderResult[],
  selection: Selection
): InsightRecord {
  const issues: Issue[] = [];
  const admitted = results
    .toSorted((a, b) => compareResults(a, b))
    .filter((result) => admit(result, mediaId, selection, issues));
  const { distinct, conflictedResultIds } = dropRepeatedDeliveries(admitted, issues);
  const categories = initialCategories(selection);
  const insights: Insight[] = [];

  for (const kind of KINDS) {
    const selected = selectWinner(
      distinct.filter((result) => result.kind === kind),
      issues
    );
    if (selected.outcome === 'none') {
      continue;
    }
    if (selected.outcome === 'conflict' || conflictedResultIds.has(selected.result.resultId)) {
      categories[kind] = CONFLICT_STATE;
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
): { distinct: ProviderResult[]; conflictedResultIds: ReadonlySet<string> } {
  const distinct: ProviderResult[] = [];
  const conflictedResultIds = new Set<string>();

  for (const [resultId, deliveries] of Map.groupBy(results, (result) => result.resultId)) {
    const [first, ...repeats] = deliveries;
    if (first === undefined) {
      continue;
    }
    distinct.push(first);
    if (repeats.length === 0) {
      continue;
    }
    const firstShape = canonicalJson(first);
    const conflicting = repeats.some((repeat) => canonicalJson(repeat) !== firstShape);
    if (conflicting) {
      conflictedResultIds.add(resultId);
    }
    issues.push(issue(conflicting ? ISSUE_CODE.CONFLICTING_DELIVERY : ISSUE_CODE.DUPLICATE_DELIVERY, [resultId], []));
  }

  return { distinct, conflictedResultIds };
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
  const seen = new Set<string>();
  const duplicated: string[] = [];
  const invalidConfidence: string[] = [];
  const insights: Insight[] = [];

  for (const item of items.toSorted((a, b) => compareObservations(a, b))) {
    if (seen.has(item.observationId)) {
      duplicated.push(item.observationId);
      continue;
    }
    seen.add(item.observationId);
    const confidence = classifyConfidence(item.confidence);
    if (confidence.status === 'invalid') {
      invalidConfidence.push(item.observationId);
    }
    insights.push(toInsight(result, item, confidence.value));
  }

  if (duplicated.length > 0) {
    issues.push(issue(ISSUE_CODE.DUPLICATE_OBSERVATION, [result.resultId], duplicated));
  }
  if (invalidConfidence.length > 0) {
    issues.push(issue(ISSUE_CODE.INVALID_CONFIDENCE, [result.resultId], invalidConfidence));
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    isRecord(current)
      ? Object.fromEntries(Object.entries(current).toSorted(([a], [b]) => compareStrings(a, b)))
      : current
  );
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

function kindIndex(kind: Kind): number {
  return KINDS.indexOf(kind);
}

function compareResults(a: ProviderResult, b: ProviderResult): number {
  return (
    compareStrings(a.provider, b.provider) ||
    compareStrings(a.runId, b.runId) ||
    compareNumbers(kindIndex(a.kind), kindIndex(b.kind)) ||
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
    compareNumbers(kindIndex(a.kind), kindIndex(b.kind)) ||
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
