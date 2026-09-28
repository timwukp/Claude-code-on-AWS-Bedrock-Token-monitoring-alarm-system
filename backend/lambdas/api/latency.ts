/**
 * Latency API — model-hop latency from CloudWatch, plus the observability status of every hop.
 *
 *   GET /v1/latency?window=1|7|30
 *
 * Scope and honesty, both stated in the payload so the UI cannot overstate them:
 *  - CloudWatch `AWS/Bedrock` is **account-level**. It carries no project, user or tenant
 *    dimension, so the fleet numbers are exactly that. Per-project latency comes from a different
 *    source in the same payload (`projects`): the aggregator folds each logged call's
 *    `amazon-bedrock-invocationMetrics` into count + sum + fixed buckets on the tenant's PROJDAY
 *    rollups (#13 phase 1b), and this handler reads those back for the window. That is why the
 *    function now holds read grants on the tenants and aggregates tables: the project section IS
 *    tenant-scoped, by the same claim every other page uses. Bucket percentiles are estimates
 *    (`estimated: true`); the fleet CloudWatch figures stay the exact reference.
 *  - `TimeToFirstToken` is published for **streaming** invocations only, so its sample count is
 *    lower than `InvocationLatency`'s. The difference is the honest coverage figure.
 *  - The generation segment is `InvocationLatency − TimeToFirstToken` at the same percentile.
 *    Percentiles are not additive, so it is returned with `derived: true` and must be labelled
 *    indicative rather than measured.
 *  - Only the Bedrock hop is observable from our own telemetry. The gateway, Guardrails and
 *    IDE/CLI hops are reported as `unmeasured` with what would have to be instrumented.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { badRequest, ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import * as projectRegistry from '../shared/project-registry';
import { projdayRange } from './project-calc';
import { buildProjectLatencyRows, latencyCoverage } from './latency-projects';

const cw = new CloudWatchClient({});
const bedrock = new BedrockClient({});
const ddbAgg = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE ?? '';
const NAMESPACE = 'AWS/Bedrock';
const E2E = 'InvocationLatency';
const TTFT = 'TimeToFirstToken';
const WINDOWS = [1, 7, 30] as const;
const PERCENTILES = ['p50', 'p95', 'p99'] as const;
const MAX_MODELS = 12;

export type Percentile = (typeof PERCENTILES)[number];

export interface LatencyStat {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  samples: number | null;
  /**
   * Set when CloudWatch returned the window as more than one period bucket, so each percentile is a
   * sample-count-weighted mean of those buckets rather than one exact percentile over the window.
   * Absent means the window came back as a single bucket and the percentile is exact.
   */
  approximated?: true;
  derived?: true;
}

export interface LatencyRow {
  /** Exactly what CloudWatch's `ModelId` dimension held — a model id, or an inference-profile id. */
  modelId: string;
  /** Display name. For profile-routed rows this is the model behind the profile — see resolveLabel. */
  label: string;
  /** Set when `modelId` was an application inference profile rather than a model id. */
  via?: 'inference-profile';
  profileName?: string;
  /** The foundation model the profile routes to. Absent when the profile fans out to several. */
  resolvedModel?: string;
  e2e: LatencyStat;
  ttft: LatencyStat;
  generation: LatencyStat;
}

export type HopStatus = 'measured' | 'unmeasured';

export interface Hop {
  id: string;
  label: string;
  status: HopStatus;
  /** Which field of a LatencyRow carries this hop's number, when measured. */
  metric?: 'ttft' | 'generation';
  note: string;
  /** What the customer would have to instrument for an unmeasured hop. */
  instrument?: string;
}

/**
 * The end-to-end chain, with the observability status of each hop. Only the Bedrock hop is
 * measurable from our own telemetry today; the rest are named so the gap is explicit rather than
 * silently absent. Kept here (not in the page) so the claim lives with the data that backs it.
 */
export function hopModel(): Hop[] {
  return [
    {
      id: 'client',
      label: 'Developer IDE / CLI',
      status: 'unmeasured',
      note: 'Time spent in the agent before and after the model call, plus network and retries. This is the only hop that sees developer-perceived latency.',
      instrument: "Claude Code OpenTelemetry export. The api_request event carries duration_ms and total_retry_duration_ms; per-request TTFT and task duration exist only in beta trace spans.",
    },
    {
      id: 'gateway',
      label: 'LLM gateway',
      status: 'unmeasured',
      note: 'Queue time and proxy overhead ahead of the Bedrock call.',
      instrument: 'LiteLLM Prometheus histograms (total, upstream LLM API, gateway overhead, ASGI queue). Do not aggregate the spend-log response_time field: it means end-to-end for non-streaming calls and time-to-first-token for streaming ones.',
    },
    {
      id: 'bedrock-ttft',
      label: 'Bedrock API → first byte',
      status: 'measured',
      metric: 'ttft',
      note: 'CloudWatch TimeToFirstToken. Published for streaming invocations only.',
    },
    {
      id: 'bedrock-generation',
      label: 'Model generation (streaming tail)',
      status: 'measured',
      metric: 'generation',
      note: 'InvocationLatency minus TimeToFirstToken at the same percentile. Percentiles are not additive, so treat this segment as indicative.',
    },
    {
      id: 'guardrails',
      label: 'Bedrock Guardrails',
      status: 'unmeasured',
      note: 'Guardrail evaluation time is not broken out by CloudWatch, and AWS does not document whether InvocationLatency includes it.',
      instrument: 'Call Converse with trace enabled and record guardrailProcessingLatency per assessment. Note that guardrails do not evaluate tool-use payloads.',
    },
  ];
}

const stripRegion = (modelId: string): string => modelId.replace(/^(us|eu|apac|global)\./, '');

/**
 * An application inference profile as far as this endpoint cares: its id (which is what CloudWatch
 * puts in the `ModelId` dimension for profile-routed traffic), its name, and the distinct
 * foundation models it routes to.
 */
export interface ProfileRef {
  id: string;
  name?: string;
  models: string[];
}

/**
 * CloudWatch reports profile-routed invocations under the profile's **id** — an opaque 12-character
 * string — so a by-model table built straight off the dimension shows rows a reader cannot identify.
 * This resolves the id back to the model it routes to.
 *
 * It refuses to guess in the one case where guessing would be a fabrication: a profile that fans out
 * to more than one distinct foundation model cannot be attributed to any single one of them, so the
 * label falls back to the profile's own name and the model field is left unset. A profile we cannot
 * find at all (deleted since, or the list call failed) keeps its raw id rather than inventing a name.
 */
export function resolveLabel(
  modelId: string,
  profiles: Map<string, ProfileRef>,
): { label: string; via?: 'inference-profile'; profileName?: string; resolvedModel?: string } {
  const p = profiles.get(modelId);
  if (!p) return { label: stripRegion(modelId) };
  const distinct = [...new Set(p.models)];
  const named = p.name ?? p.id;
  if (distinct.length !== 1) {
    return { label: named, via: 'inference-profile', profileName: p.name };
  }
  return {
    label: stripRegion(distinct[0]),
    via: 'inference-profile',
    profileName: p.name,
    resolvedModel: distinct[0],
  };
}

/** Percentile-wise difference, floored at 0. Null when either side is missing. */
export function deriveGeneration(e2e: LatencyStat, ttft: LatencyStat): LatencyStat {
  const diff = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : Math.max(0, a - b);
  return {
    p50: diff(e2e.p50, ttft.p50),
    p95: diff(e2e.p95, ttft.p95),
    p99: diff(e2e.p99, ttft.p99),
    samples: ttft.samples,
    // A segment derived from an approximated input is itself approximated; dropping the flag here
    // would let the page present the weaker number as the firmer one.
    ...(e2e.approximated || ttft.approximated ? { approximated: true as const } : {}),
    derived: true,
  };
}

/** One CloudWatch datapoint: the bucket's start timestamp and its value. */
export interface Point {
  ts: string;
  v: number;
}

/**
 * Fold every bucket CloudWatch returned into one stat.
 *
 * Asking for `Period == the whole window` does **not** guarantee a single datapoint: CloudWatch
 * aligns buckets to its own boundaries, so a 30-day request came back as a 72,397-sample bucket
 * plus an 8-sample sliver covering the last few minutes. Reading `Values[0]` under
 * `ScanBy: TimestampDescending` therefore reported the sliver — 8 samples and a p95 three seconds
 * off — as the whole month. Sample counts are summed; percentiles are weighted by the count of the
 * bucket they came from, which is exact for one bucket and an approximation (flagged) for more.
 * Buckets with no samples are ignored so an empty tail cannot drag a percentile down.
 */
export function combineBuckets(series: Map<string, Point[]>, prefix: string): LatencyStat {
  const counts = series.get(`${prefix}_SampleCount`) ?? [];
  const total = counts.reduce((sum, c) => sum + c.v, 0);
  const contributing = counts.filter((c) => c.v > 0).length;

  const weighted = (stat: Percentile): number | null => {
    const points = series.get(`${prefix}_${stat}`) ?? [];
    let acc = 0;
    let weight = 0;
    for (const p of points) {
      const count = counts.find((c) => c.ts === p.ts)?.v ?? 0;
      if (count > 0 && Number.isFinite(p.v)) {
        acc += p.v * count;
        weight += count;
      }
    }
    return weight > 0 ? Math.round(acc / weight) : null;
  };

  return {
    p50: weighted('p50'),
    p95: weighted('p95'),
    p99: weighted('p99'),
    samples: total > 0 ? total : counts.length > 0 ? 0 : null,
    ...(contributing > 1 ? { approximated: true as const } : {}),
  };
}

/** One MetricDataQuery per (metric, statistic) pair, for the fleet or for one model. */
function queriesFor(prefix: string, metricName: string, days: number, modelId?: string): MetricDataQuery[] {
  const metric = {
    Namespace: NAMESPACE,
    MetricName: metricName,
    ...(modelId ? { Dimensions: [{ Name: 'ModelId', Value: modelId }] } : {}),
  };
  const period = days * 86_400;
  return [...PERCENTILES, 'SampleCount'].map((stat) => ({
    Id: `${prefix}_${stat}`,
    MetricStat: { Metric: metric, Period: period, Stat: stat },
    ReturnData: true,
  }));
}

async function listModelIds(): Promise<string[]> {
  const res = await cw.send(new ListMetricsCommand({ Namespace: NAMESPACE, MetricName: E2E }));
  const ids = (res.Metrics ?? [])
    .map((m) => m.Dimensions?.find((d) => d.Name === 'ModelId')?.Value)
    .filter((v): v is string => Boolean(v));
  return [...new Set(ids)];
}

/**
 * Application inference profiles, keyed by id. Best-effort on purpose: if the call is denied or
 * fails, profile-routed rows keep their raw ids and the rest of the payload is unaffected — a
 * labelling aid must not be able to take the endpoint down.
 */
async function listProfiles(): Promise<Map<string, ProfileRef>> {
  const out = new Map<string, ProfileRef>();
  try {
    let nextToken: string | undefined;
    do {
      const res = await bedrock.send(
        new ListInferenceProfilesCommand({ typeEquals: 'APPLICATION', maxResults: 100, nextToken }),
      );
      for (const p of res.inferenceProfileSummaries ?? []) {
        if (!p.inferenceProfileId) continue;
        out.set(p.inferenceProfileId, {
          id: p.inferenceProfileId,
          name: p.inferenceProfileName,
          models: (p.models ?? [])
            .map((m) => m.modelArn?.split('/').pop())
            .filter((v): v is string => Boolean(v)),
        });
      }
      nextToken = res.nextToken;
    } while (nextToken);
  } catch {
    return out;
  }
  return out;
}

/** Raw PROJDAY items for the tenant's window — same key range the DORA/ROI project tables read. */
async function queryProjdayRaw(tenantId: string, now: Date, windowDays: number): Promise<Record<string, unknown>[]> {
  if (!AGGREGATES_TABLE) return [];
  const { fromSk, toSk } = projdayRange(now, windowDays);
  const out: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddbAgg.send(new QueryCommand({
      TableName: AGGREGATES_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#PROJDAY`, ':from': fromSk, ':to': toSk },
      ExclusiveStartKey: key,
    }));
    out.push(...((res.Items ?? []) as Record<string, unknown>[]));
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // The fleet section is account-wide CloudWatch data and is labelled as such; the project
    // section is the tenant's own PROJDAY rollups, scoped by this claim.
    const tenantId = getTenantId(event);

    const windowDays = Number(event.queryStringParameters?.window ?? 7);
    if (!WINDOWS.includes(windowDays as (typeof WINDOWS)[number])) {
      return badRequest(`window must be one of ${WINDOWS.join(', ')}`);
    }

    const end = new Date();
    const start = new Date(end.getTime() - windowDays * 86_400_000);
    const [allModelIds, profiles, projdayItems, registry] = await Promise.all([
      listModelIds(), listProfiles(),
      queryProjdayRaw(tenantId, end, windowDays).catch((e) => { console.warn('latency: PROJDAY read failed; project section empty', (e as Error).message); return [] as Record<string, unknown>[]; }),
      projectRegistry.listProjects().catch(() => [] as { projectId: string; name: string }[]),
    ]);
    const names = new Map(registry.map((p) => [p.projectId, p.name] as [string, string]));
    const projectRows = buildProjectLatencyRows(projdayItems, names);
    const projectCoverage = latencyCoverage(projdayItems);
    const modelIds = allModelIds.slice(0, MAX_MODELS);

    const queries: MetricDataQuery[] = [
      ...queriesFor('fleet_e2e', E2E, windowDays),
      ...queriesFor('fleet_ttft', TTFT, windowDays),
    ];
    modelIds.forEach((id, i) => {
      queries.push(...queriesFor(`m${i}_e2e`, E2E, windowDays, id));
      queries.push(...queriesFor(`m${i}_ttft`, TTFT, windowDays, id));
    });

    const res = await cw.send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: queries,
        ScanBy: 'TimestampDescending',
      }),
    );

    // Keep every bucket. A window-length period can still be split across CloudWatch's own period
    // boundaries, and the trailing sliver is tiny — see combineBuckets.
    const series = new Map<string, Point[]>();
    for (const r of res.MetricDataResults ?? []) {
      if (!r.Id) continue;
      const points = (r.Timestamps ?? []).map((ts, i) => ({
        ts: new Date(ts).toISOString(),
        v: (r.Values ?? [])[i],
      }));
      series.set(
        r.Id,
        points.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v)),
      );
    }

    const fleetE2e = combineBuckets(series, 'fleet_e2e');
    const fleetTtft = combineBuckets(series, 'fleet_ttft');
    const models: LatencyRow[] = modelIds
      .map((modelId, i) => {
        const e2e = combineBuckets(series, `m${i}_e2e`);
        const ttft = combineBuckets(series, `m${i}_ttft`);
        return {
          modelId,
          ...resolveLabel(modelId, profiles),
          e2e,
          ttft,
          generation: deriveGeneration(e2e, ttft),
        };
      })
      .filter((r) => r.e2e.samples !== null && r.e2e.samples > 0)
      .sort((a, b) => (b.e2e.p95 ?? 0) - (a.e2e.p95 ?? 0));

    const streamingPct =
      fleetE2e.samples && fleetTtft.samples ? Math.round((fleetTtft.samples / fleetE2e.samples) * 100) : null;

    return ok({
      window: windowDays,
      generatedAt: end.toISOString(),
      source: 'CloudWatch AWS/Bedrock (InvocationLatency, TimeToFirstToken)',
      scope: 'aws-account',
      scopeNote:
        'Account-level. CloudWatch publishes no project, user or tenant dimension for these metrics, so the fleet section is a fleet view. Per-project latency is in `projects`, read from the invocation-log rollups for this tenant.',
      fleet: { e2e: fleetE2e, ttft: fleetTtft, generation: deriveGeneration(fleetE2e, fleetTtft) },
      models,
      projects: {
        source: 'invocation-log rollups (PROJDAY): amazon-bedrock-invocationMetrics per call, count + sum + fixed buckets',
        scope: 'tenant',
        window: windowDays,
        rows: projectRows,
        coverage: projectCoverage,
        note: projectCoverage.pct === null
          ? 'No project rollups in this window.'
          : `${projectCoverage.withLatency} of ${projectCoverage.invocations} invocations in this window carry a latency sample (${projectCoverage.pct}%). Calls logged without a response body, and rollups written before latency was collected, have none — they are excluded, not counted as zero.`,
        estimateNote:
          'p50/p95 are read from fixed histogram buckets (250 ms … 64 s) by linear interpolation inside the bucket that holds the rank, so they are estimates to within a bucket span; a value marked open-ended fell in the unbounded top bucket and is a lower bound. Compare against the exact fleet percentiles above.',
      },
      hops: hopModel(),
      coverage: {
        e2eSamples: fleetE2e.samples,
        ttftSamples: fleetTtft.samples,
        streamingPct,
        note:
          streamingPct === null
            ? 'No invocations in this window.'
            : `${fleetTtft.samples} of ${fleetE2e.samples} invocations were streaming (${streamingPct}%); non-streaming calls publish no time-to-first-token.`,
      },
      percentileNote:
        'CloudWatch computes each percentile inside its own period bucket. Where a window came back as more than one bucket the percentile is a sample-count-weighted mean of them and is flagged `approximated`; an unflagged percentile is exact for the window.',
      caveat:
        'Service-side latency of the model call. It says nothing about developer productivity — no evidence links the two.',
    });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('tenant claim')) return badRequest(message);
    console.error('latency: failed', err);
    return serverError('Could not read latency metrics');
  }
};
