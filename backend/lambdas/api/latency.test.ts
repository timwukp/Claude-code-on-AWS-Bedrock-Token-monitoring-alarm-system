import {
  combineBuckets,
  deriveGeneration,
  hopModel,
  LatencyStat,
  Point,
  ProfileRef,
  resolveLabel,
} from './latency';

const stat = (p50: number | null, p95: number | null, p99: number | null, samples: number | null): LatencyStat =>
  ({ p50, p95, p99, samples });

/** Build the per-query series map the handler hands to combineBuckets. */
const series = (entries: Record<string, Point[]>): Map<string, Point[]> => new Map(Object.entries(entries));

describe('deriveGeneration', () => {
  it('subtracts percentile-wise and marks the result derived', () => {
    const g = deriveGeneration(stat(3880, 24818, 56389, 12198), stat(2213, 8080, 22140, 7967));
    expect(g).toEqual({ p50: 1667, p95: 16738, p99: 34249, samples: 7967, derived: true });
  });

  it('reports the streaming sample count, not the end-to-end one', () => {
    // The segment only exists for streaming calls, so quoting the larger e2e count beside it would
    // overstate how much data the number rests on.
    const g = deriveGeneration(stat(1000, 2000, 3000, 50_000), stat(400, 900, 1200, 12));
    expect(g.samples).toBe(12);
  });

  it('floors at zero rather than reporting a negative segment', () => {
    // The two metrics are published over different populations (all calls vs streaming calls), so
    // at a given percentile first-byte can legitimately exceed end-to-end. That is a coverage
    // artefact, not a negative duration.
    const g = deriveGeneration(stat(1000, 2000, 3000, 100), stat(1500, 2000, 9999, 40));
    expect(g.p50).toBe(0);
    expect(g.p95).toBe(0);
    expect(g.p99).toBe(0);
  });

  it('returns null for a percentile either side is missing, without poisoning the others', () => {
    const g = deriveGeneration(stat(1000, null, 3000, 100), stat(400, 900, null, 40));
    expect(g.p50).toBe(1000 - 400);
    expect(g.p95).toBeNull();
    expect(g.p99).toBeNull();
  });

  it('returns an all-null segment when there was no traffic at all', () => {
    const g = deriveGeneration(stat(null, null, null, null), stat(null, null, null, null));
    expect(g).toEqual({ p50: null, p95: null, p99: null, samples: null, derived: true });
  });
});

describe('combineBuckets', () => {
  const A = '2026-08-19T13:25:00.000Z';
  const B = '2026-09-18T13:25:00.000Z';

  it('does not let a trailing sliver bucket speak for the whole window', () => {
    // The regression fixture, taken verbatim from a live 30-day GetMetricData call: CloudWatch split
    // the window into a 72,397-sample bucket and an 8-sample sliver covering the last ~3 minutes.
    // Reading Values[0] under ScanBy=TimestampDescending reported the sliver as the month.
    const s = combineBuckets(
      series({
        e_p95: [
          { ts: B, v: 36064.98 },
          { ts: A, v: 33050.63 },
        ],
        e_SampleCount: [
          { ts: B, v: 8 },
          { ts: A, v: 72397 },
        ],
      }),
      'e',
    );
    expect(s.samples).toBe(72405);
    // Weighted by count, so the 72,397-sample bucket dominates instead of being discarded.
    expect(s.p95).toBe(Math.round((36064.98 * 8 + 33050.63 * 72397) / 72405));
    expect(s.p95).toBe(33051);
    expect(s.approximated).toBe(true);
  });

  it('is exact and unflagged when the window came back as one bucket', () => {
    const s = combineBuckets(
      series({ e_p50: [{ ts: A, v: 3870.4 }], e_SampleCount: [{ ts: A, v: 12053 }] }),
      'e',
    );
    expect(s.p50).toBe(3870);
    expect(s.samples).toBe(12053);
    expect(s.approximated).toBeUndefined();
  });

  it('ignores buckets that carry no samples rather than averaging their percentile in', () => {
    // An empty bucket has no percentile to contribute; weighting it as if it did would pull the
    // number toward a period in which nothing happened.
    const s = combineBuckets(
      series({
        e_p95: [
          { ts: B, v: 1 },
          { ts: A, v: 5000 },
        ],
        e_SampleCount: [
          { ts: B, v: 0 },
          { ts: A, v: 100 },
        ],
      }),
      'e',
    );
    expect(s.p95).toBe(5000);
    expect(s.samples).toBe(100);
    expect(s.approximated).toBeUndefined(); // only one bucket actually contributed
  });

  it('pairs each percentile with its own bucket, not by position', () => {
    // The two queries can come back in different orders; zipping by index would cross-weight them.
    const s = combineBuckets(
      series({
        e_p95: [
          { ts: A, v: 1000 },
          { ts: B, v: 2000 },
        ],
        e_SampleCount: [
          { ts: B, v: 3 },
          { ts: A, v: 1 },
        ],
      }),
      'e',
    );
    expect(s.p95).toBe(Math.round((1000 * 1 + 2000 * 3) / 4));
  });

  it('reports zero samples as zero, and a metric that returned nothing as null', () => {
    const empty = combineBuckets(series({ e_SampleCount: [{ ts: A, v: 0 }] }), 'e');
    expect(empty.samples).toBe(0);
    expect(empty.p95).toBeNull();

    const absent = combineBuckets(series({}), 'e');
    expect(absent.samples).toBeNull();
    expect(absent.p95).toBeNull();
  });

  it('keeps each metric prefix separate', () => {
    const s = series({
      fleet_e2e_p95: [{ ts: A, v: 9000 }],
      fleet_e2e_SampleCount: [{ ts: A, v: 10 }],
      fleet_ttft_p95: [{ ts: A, v: 2000 }],
      fleet_ttft_SampleCount: [{ ts: A, v: 7 }],
    });
    expect(combineBuckets(s, 'fleet_e2e').p95).toBe(9000);
    expect(combineBuckets(s, 'fleet_ttft').p95).toBe(2000);
    expect(combineBuckets(s, 'fleet_ttft').samples).toBe(7);
  });
});

describe('deriveGeneration approximation flag', () => {
  it('propagates approximated from either side', () => {
    const approx: LatencyStat = { p50: 1000, p95: 2000, p99: 3000, samples: 10, approximated: true };
    expect(deriveGeneration(approx, stat(400, 900, 1200, 8)).approximated).toBe(true);
    expect(deriveGeneration(stat(1000, 2000, 3000, 10), approx).approximated).toBe(true);
  });

  it('leaves the flag off when both sides are exact', () => {
    expect(deriveGeneration(stat(1000, 2000, 3000, 10), stat(400, 900, 1200, 8)).approximated).toBeUndefined();
  });
});

describe('hopModel', () => {
  const hops = hopModel();

  it('describes the whole chain in request order', () => {
    // The page draws the diagram straight from this array, so the order *is* the chain.
    expect(hops.map((h) => h.id)).toEqual([
      'client',
      'gateway',
      'bedrock-ttft',
      'bedrock-generation',
      'guardrails',
    ]);
  });

  it('claims exactly two measured hops — both inside Bedrock', () => {
    const measured = hops.filter((h) => h.status === 'measured');
    expect(measured.map((h) => h.id)).toEqual(['bedrock-ttft', 'bedrock-generation']);
  });

  it('gives every measured hop a distinct field of the payload to read', () => {
    // Two hops mapping to the same metric would draw one number twice and look like evidence.
    const metrics = hops.filter((h) => h.status === 'measured').map((h) => h.metric);
    expect(metrics).toEqual(['ttft', 'generation']);
    expect(new Set(metrics).size).toBe(metrics.length);
  });

  it('never attaches a metric to an unmeasured hop', () => {
    // This is the guard against the diagram quietly borrowing a Bedrock number for a dark hop.
    for (const h of hops.filter((x) => x.status === 'unmeasured')) {
      expect(h.metric).toBeUndefined();
    }
  });

  it('tells the reader what would light up each unmeasured hop', () => {
    const dark = hops.filter((h) => h.status === 'unmeasured');
    expect(dark.map((h) => h.id)).toEqual(['client', 'gateway', 'guardrails']);
    for (const h of dark) {
      expect(h.instrument && h.instrument.length).toBeGreaterThan(0);
    }
  });

  it('labels and explains every hop', () => {
    for (const h of hops) {
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.note.length).toBeGreaterThan(0);
    }
  });

  it('warns against the gateway field that means two different things', () => {
    // LiteLLM's spend-log `response_time` is end-to-end for non-streaming calls and
    // time-to-first-token for streaming ones, so averaging it mixes two measurements.
    const gateway = hops.find((h) => h.id === 'gateway');
    expect(gateway?.instrument).toContain('response_time');
  });

  it('returns a fresh array so a caller cannot mutate the shared model', () => {
    const a = hopModel();
    a[0].label = 'mutated';
    expect(hopModel()[0].label).not.toBe('mutated');
  });
});

describe('resolveLabel', () => {
  const profiles = (...refs: ProfileRef[]): Map<string, ProfileRef> =>
    new Map(refs.map((r) => [r.id, r]));

  it('leaves a foundation model id alone apart from the region prefix', () => {
    expect(resolveLabel('us.anthropic.claude-sonnet-4-6', new Map())).toEqual({
      label: 'anthropic.claude-sonnet-4-6',
    });
  });

  it('resolves an inference-profile id to the model it routes to', () => {
    // This is the defect qa found: CloudWatch reports profile-routed traffic under the profile id,
    // so the table showed opaque 12-character strings as if they were model names.
    const m = profiles({ id: 'c5xf7omvk87g', name: 'team-a-sonnet', models: ['anthropic.claude-sonnet-4-6'] });
    expect(resolveLabel('c5xf7omvk87g', m)).toEqual({
      label: 'anthropic.claude-sonnet-4-6',
      via: 'inference-profile',
      profileName: 'team-a-sonnet',
      resolvedModel: 'anthropic.claude-sonnet-4-6',
    });
  });

  it('collapses a profile that lists the same model once per region', () => {
    const m = profiles({
      id: 'yxhaeann9pmz',
      name: 'team-b-nova',
      models: ['amazon.nova-lite-v1:0', 'amazon.nova-lite-v1:0', 'amazon.nova-lite-v1:0'],
    });
    expect(resolveLabel('yxhaeann9pmz', m).label).toBe('amazon.nova-lite-v1:0');
  });

  it('refuses to name a single model for a profile that fans out to several', () => {
    // Picking the first would be a fabrication: the latency in the row is a mix of both models.
    const m = profiles({ id: 'multi01', name: 'team-c-mixed', models: ['model.a', 'model.b'] });
    const r = resolveLabel('multi01', m);
    expect(r.label).toBe('team-c-mixed');
    expect(r.resolvedModel).toBeUndefined();
    expect(r.via).toBe('inference-profile');
  });

  it('falls back to the profile id when a multi-model profile has no name', () => {
    const m = profiles({ id: 'multi02', models: ['model.a', 'model.b'] });
    expect(resolveLabel('multi02', m).label).toBe('multi02');
  });

  it('keeps an unknown id verbatim rather than inventing a name', () => {
    // A profile deleted since the metrics were published, or a failed/denied list call, must not
    // turn into a guess — the raw id at least tells the reader what CloudWatch actually reported.
    const r = resolveLabel('gone9999abcd', profiles({ id: 'other', models: ['model.a'] }));
    expect(r).toEqual({ label: 'gone9999abcd' });
    expect(r.via).toBeUndefined();
  });

  it('strips the region prefix off the resolved model too', () => {
    const m = profiles({ id: 'p1', name: 'p', models: ['eu.anthropic.claude-haiku-4-5-20251001-v1:0'] });
    expect(resolveLabel('p1', m).label).toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
  });
});
