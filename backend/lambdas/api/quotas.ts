import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  CloudWatchClient, GetMetricStatisticsCommand, ListMetricsCommand,
} from '@aws-sdk/client-cloudwatch';
import { ServiceQuotasClient, ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import { ok, serverError } from '../shared/response';
import {
  computeHeadroom, summarizeThrottles, windowOf, QuotaInfo, matchQuotaForModel, modelKeywords,
} from './quota-calc';

const cw = new CloudWatchClient({});
const sq = new ServiceQuotasClient({});

/**
 * GET /v1/quotas — Bedrock token-quota headroom + throttle status, for the models you ACTUALLY
 * use. We list the ModelIds that have CloudWatch token metrics (i.e. real traffic), sum each
 * model's own usage, and match it to that model's per-minute / per-day Service Quotas limit.
 *
 * This avoids the trap of comparing account-wide total usage against every model's quota. Models
 * with no traffic are omitted (they'd all read 0% and add noise). Note: `InvocationThrottles`
 * has no datapoints until a 429 actually occurs — treated as zero (the healthy case).
 */
export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const [throttles, clientErrors, activeModels, quotas] = await Promise.all([
      sumMetric('InvocationThrottles'),
      sumMetric('InvocationClientErrors'),
      listActiveModelIds(),
      listTokenQuotas(),
    ]);

    const throttleSummary = summarizeThrottles(throttles, clientErrors);

    // For each model with real traffic, compute its own per-minute and per-day usage, then match
    // it to that model's quotas.
    // Region variants of one model (us./global.) share the same quota; merge their usage so each
    // (quota, window) appears once with the combined usage.
    const byKey = new Map<string, { modelId: string; q: typeof quotas[number]; used: number }>();
    for (const modelId of activeModels) {
      const [perMin, perDay] = await Promise.all([
        sumTokensForModel(modelId, 60),
        sumTokensForModel(modelId, 24 * 60 * 60),
      ]);
      for (const window of ['minute', 'day'] as const) {
        const q = matchQuotaForModel(quotas, modelId, window);
        if (!q) continue;
        const used = window === 'minute' ? perMin : perDay;
        const key = `${q.name}`;
        const prev = byKey.get(key);
        if (prev) prev.used += used;
        else byKey.set(key, { modelId: q.name, q, used });
      }
    }

    // Highest utilization first; cap the list.
    const rows = [...byKey.values()]
      .map(({ q, used }) => computeHeadroom(q, used))
      .sort((a, b) => b.usedPct - a.usedPct)
      .slice(0, 12);
    return ok({ throttles: throttleSummary, headroom: rows });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

/** ModelIds that have AWS/Bedrock token metrics — i.e. models with real traffic in this account. */
async function listActiveModelIds(): Promise<string[]> {
  const res = await cw.send(new ListMetricsCommand({ Namespace: 'AWS/Bedrock', MetricName: 'InputTokenCount' }));
  const ids = new Set<string>();
  for (const m of res.Metrics ?? []) {
    const dim = (m.Dimensions ?? []).find((d) => d.Name === 'ModelId');
    if (dim?.Value) ids.add(dim.Value);
  }
  return [...ids];
}

/** Sum an AWS/Bedrock metric (account-wide, no dimension) over the last 24h. */
async function sumMetric(metricName: string): Promise<number | undefined> {
  const res = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/Bedrock', MetricName: metricName,
    StartTime: new Date(Date.now() - 24 * 60 * 60 * 1000), EndTime: new Date(),
    Period: 24 * 60 * 60, Statistics: ['Sum'],
  }));
  const dp = res.Datapoints ?? [];
  return dp.length ? dp.reduce((s, d) => s + (d.Sum ?? 0), 0) : undefined;
}

/** Sum input+output tokens for ONE model over the trailing `seconds` window. */
async function sumTokensForModel(modelId: string, seconds: number): Promise<number> {
  const one = async (metricName: string) => {
    const res = await cw.send(new GetMetricStatisticsCommand({
      Namespace: 'AWS/Bedrock', MetricName: metricName,
      Dimensions: [{ Name: 'ModelId', Value: modelId }],
      StartTime: new Date(Date.now() - seconds * 1000), EndTime: new Date(),
      Period: Math.max(60, seconds), Statistics: ['Sum'],
    }));
    return (res.Datapoints ?? []).reduce((s, d) => s + (d.Sum ?? 0), 0);
  };
  const [inTok, outTok] = await Promise.all([one('InputTokenCount'), one('OutputTokenCount')]);
  return inTok + outTok;
}

/** List Bedrock per-model token quotas (TPM + per-day) from Service Quotas. */
async function listTokenQuotas(): Promise<QuotaInfo[]> {
  const out: QuotaInfo[] = [];
  let token: string | undefined;
  do {
    const res = await sq.send(new ListServiceQuotasCommand({ ServiceCode: 'bedrock', NextToken: token, MaxResults: 100 }));
    for (const q of res.Quotas ?? []) {
      const w = windowOf(q.QuotaName ?? '');
      if (w && typeof q.Value === 'number') {
        out.push({ name: q.QuotaName!, limit: q.Value, window: w, adjustable: !!q.Adjustable });
      }
    }
    token = res.NextToken;
  } while (token);
  return out;
}

// re-export for tooling/tests that import from the handler module
export { modelKeywords };
