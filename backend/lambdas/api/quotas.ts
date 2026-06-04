import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { ServiceQuotasClient, ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import { ok, serverError } from '../shared/response';
import { computeHeadroom, summarizeThrottles, windowOf, QuotaInfo } from './quota-calc';

const cw = new CloudWatchClient({});
const sq = new ServiceQuotasClient({});

/**
 * GET /v1/quotas — Bedrock token-quota headroom + throttle status.
 *
 * Bedrock enforces per-model tokens-per-minute and max-tokens-per-day quotas (HTTP 429 on
 * breach). This surfaces how close usage is to those limits, plus any observed throttling, so a
 * pilot doesn't silently hit a wall. Note: `InvocationThrottles` often has NO datapoints until a
 * 429 actually occurs — that is the healthy case and is treated as zero (see quota-calc.ts).
 */
export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const [throttles, clientErrors, quotas] = await Promise.all([
      sumMetric('InvocationThrottles'),
      sumMetric('InvocationClientErrors'),
      listTokenQuotas(),
    ]);

    const throttleSummary = summarizeThrottles(throttles, clientErrors);

    // Observed token usage (last minute / last day) to compare against the quotas.
    const [tokensLastMinute, tokensLastDay] = await Promise.all([
      sumTokens(60),
      sumTokens(24 * 60 * 60),
    ]);
    const headroom = quotas
      .map((q) => computeHeadroom(q, q.window === 'minute' ? tokensLastMinute : tokensLastDay))
      // Most useful first: highest utilization, then per-minute (the limit usage hits first).
      .sort((a, b) => b.usedPct - a.usedPct || (a.window === 'minute' ? -1 : 1));

    return ok({ throttles: throttleSummary, headroom });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

/** Sum an AWS/Bedrock metric over the last 24h; returns undefined if there are no datapoints. */
async function sumMetric(metricName: string): Promise<number | undefined> {
  const res = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/Bedrock',
    MetricName: metricName,
    StartTime: new Date(Date.now() - 24 * 60 * 60 * 1000),
    EndTime: new Date(),
    Period: 24 * 60 * 60,
    Statistics: ['Sum'],
  }));
  const dp = res.Datapoints ?? [];
  return dp.length ? dp.reduce((s, d) => s + (d.Sum ?? 0), 0) : undefined;
}

/** Sum input+output tokens over the trailing `seconds` window. */
async function sumTokens(seconds: number): Promise<number> {
  const windows = [
    sumMetric2('InputTokenCount', seconds),
    sumMetric2('OutputTokenCount', seconds),
  ];
  const [inTok, outTok] = await Promise.all(windows);
  return (inTok ?? 0) + (outTok ?? 0);
}

async function sumMetric2(metricName: string, seconds: number): Promise<number | undefined> {
  const res = await cw.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/Bedrock',
    MetricName: metricName,
    StartTime: new Date(Date.now() - seconds * 1000),
    EndTime: new Date(),
    Period: Math.max(60, seconds),
    Statistics: ['Sum'],
  }));
  const dp = res.Datapoints ?? [];
  return dp.length ? dp.reduce((s, d) => s + (d.Sum ?? 0), 0) : undefined;
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
  // Keep a balanced, focused list: top per-minute and top per-day quotas (don't let the larger
  // per-day numbers crowd out the TPM quotas, which are usually the binding limit).
  const byWindow = (w: 'minute' | 'day') =>
    out.filter((q) => q.window === w).sort((a, b) => b.limit - a.limit).slice(0, 8);
  return [...byWindow('minute'), ...byWindow('day')];
}
