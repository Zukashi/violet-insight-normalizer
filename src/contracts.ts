import { z } from 'zod';

export const KINDS = ['transcript', 'topic', 'phrase', 'person', 'place', 'object', 'sentiment'] as const;
export type Kind = (typeof KINDS)[number];

export const RESULT_STATES = ['partial', 'complete', 'failed'] as const;
export type ResultState = (typeof RESULT_STATES)[number];

export const POLARITIES = ['positive', 'neutral', 'negative', 'mixed'] as const;
export type Polarity = (typeof POLARITIES)[number];

export const spanSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative()
  })
  .refine((span) => span.endMs >= span.startMs, { message: 'endMs must not precede startMs' });
export type Span = z.infer<typeof spanSchema>;

const nonEmptyText = z.string().trim().min(1);

const labelValueSchema = z.object({ label: nonEmptyText });
const transcriptValueSchema = z.object({ text: nonEmptyText });
const sentimentValueSchema = z.object({
  polarity: z.enum(POLARITIES),
  targetId: nonEmptyText.optional()
});

export const VALUE_SCHEMA = {
  transcript: transcriptValueSchema,
  topic: labelValueSchema,
  phrase: labelValueSchema,
  person: labelValueSchema,
  place: labelValueSchema,
  object: labelValueSchema,
  sentiment: sentimentValueSchema
} as const satisfies Record<Kind, z.ZodType>;
export type Values = { [K in Kind]: z.infer<(typeof VALUE_SCHEMA)[K]> };

const observationSchema = <TValue extends z.ZodType, TSpan extends z.ZodType>(value: TValue, span: TSpan) =>
  z.object({
    observationId: nonEmptyText,
    value,
    span,
    confidence: z.unknown().optional()
  });

const resultSchemaFor = <K extends Kind, TObservation extends z.ZodType>(kind: K, observation: TObservation) =>
  z.object({
    kind: z.literal(kind),
    resultId: nonEmptyText,
    mediaId: nonEmptyText,
    provider: nonEmptyText,
    modelVersion: nonEmptyText,
    runId: nonEmptyText,
    revision: z.number().int().nonnegative(),
    state: z.enum(RESULT_STATES),
    producedAt: z.iso.datetime({ offset: true }),
    receivedAt: z.iso.datetime({ offset: true }),
    analyzedSpans: z.array(spanSchema).optional(),
    items: z.array(observation)
  });

const optionalSpan = spanSchema.optional();

export const providerResultSchema = z.discriminatedUnion('kind', [
  resultSchemaFor('transcript', observationSchema(VALUE_SCHEMA.transcript, spanSchema)),
  resultSchemaFor('topic', observationSchema(VALUE_SCHEMA.topic, optionalSpan)),
  resultSchemaFor('phrase', observationSchema(VALUE_SCHEMA.phrase, optionalSpan)),
  resultSchemaFor('person', observationSchema(VALUE_SCHEMA.person, optionalSpan)),
  resultSchemaFor('place', observationSchema(VALUE_SCHEMA.place, optionalSpan)),
  resultSchemaFor('object', observationSchema(VALUE_SCHEMA.object, optionalSpan)),
  resultSchemaFor('sentiment', observationSchema(VALUE_SCHEMA.sentiment, optionalSpan))
]);
export type ProviderResult = z.infer<typeof providerResultSchema>;
export type ProviderResultOf<K extends Kind> = Extract<ProviderResult, { kind: K }>;
export type Observation = ProviderResult['items'][number];

KINDS satisfies readonly ProviderResult['kind'][];

export interface Selection {
  readonly provider: string;
  readonly runId: string;
  readonly expectedKinds: readonly Kind[];
}

export const CATEGORY_STATUSES = ['not_requested', 'pending', 'partial', 'complete', 'failed', 'conflict'] as const;
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

export interface Source {
  readonly provider: string;
  readonly modelVersion: string;
  readonly runId: string;
  readonly resultId: string;
  readonly producedAt: string;
  readonly receivedAt: string;
}

export interface CategoryState {
  readonly status: CategoryStatus;
  readonly revision: number | null;
  readonly analyzedSpans: readonly Span[] | null;
  readonly source: Source | null;
}

export interface InsightOf<K extends Kind> {
  readonly id: string;
  readonly kind: K;
  readonly observationId: string;
  readonly value: Values[K];
  readonly span: Span | null;
  readonly confidence: number | null;
  readonly source: Source;
}
export type Insight = { [K in Kind]: InsightOf<K> }[Kind];

export const ISSUE_CODE = {
  MEDIA_MISMATCH: 'MEDIA_MISMATCH',
  IGNORED_UNSELECTED_RUN: 'IGNORED_UNSELECTED_RUN',
  IGNORED_UNEXPECTED_KIND: 'IGNORED_UNEXPECTED_KIND',
  DUPLICATE_DELIVERY: 'DUPLICATE_DELIVERY',
  CONFLICTING_DELIVERY: 'CONFLICTING_DELIVERY',
  SUPERSEDED_REVISION: 'SUPERSEDED_REVISION',
  CONFLICTING_REVISION: 'CONFLICTING_REVISION',
  DUPLICATE_OBSERVATION: 'DUPLICATE_OBSERVATION',
  CONFLICTING_OBSERVATION: 'CONFLICTING_OBSERVATION',
  INVALID_CONFIDENCE: 'INVALID_CONFIDENCE'
} as const;
export type IssueCode = (typeof ISSUE_CODE)[keyof typeof ISSUE_CODE];

export interface Issue {
  readonly code: IssueCode;
  readonly resultIds: readonly string[];
  readonly observationIds: readonly string[];
}

export const INSIGHT_RECORD_SCHEMA_VERSION = 1 as const;

export interface InsightRecord {
  readonly schemaVersion: typeof INSIGHT_RECORD_SCHEMA_VERSION;
  readonly mediaId: string;
  readonly selection: Selection;
  readonly categories: Readonly<Record<Kind, CategoryState>>;
  readonly insights: readonly Insight[];
  readonly issues: readonly Issue[];
}

export interface InsightIdentity {
  readonly provider: string;
  readonly runId: string;
  readonly kind: Kind;
  readonly observationId: string;
}

export const insightIdOf = ({ provider, runId, kind, observationId }: InsightIdentity): string =>
  [provider, runId, kind, observationId].map((part) => encodeURIComponent(part)).join('/');
