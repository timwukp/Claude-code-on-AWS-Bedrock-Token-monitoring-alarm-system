import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Every rollup writer must persist every token counter its aggregate carries, and all four rollup
 * shapes (USAGE hourly, MODEL, PROJECT, PROJDAY) must carry the same token counters.
 *
 * Why: the hourly USAGE writer stored `cacheWriteTokens` from day one, but the MODEL / PROJECT /
 * PROJDAY writers — the three every pricing surface reads — copied a three-counter list and dropped
 * it, so the one kind the card did not price was also absent from every table pricing reads
 * (2026-10 cache-write omission). A counter that exists in one rollup and not the others is a
 * discrepancy waiting to be priced wrongly; this test makes that state a red build.
 *
 * Static by design: it reads the source so it covers the UpdateExpression strings themselves, which
 * no unit test exercises against DynamoDB.
 */

const ING = join(__dirname);
const SCRIPTS = join(__dirname, '..', '..', 'scripts');
const read = (p: string) => readFileSync(p, 'utf8');

const parseSrc = read(join(ING, 'parse.ts'));
const aggSrc = read(join(ING, 'aggregator.ts'));

/** `*Tokens` and `invocations` fields of an interface declared in parse.ts. */
function countersOf(interfaceName: string): string[] {
  const start = parseSrc.indexOf(`export interface ${interfaceName} `);
  expect(start).toBeGreaterThan(-1);
  const body = parseSrc.slice(start, parseSrc.indexOf('\n}', start));
  return [...body.matchAll(/^\s+(\w+Tokens|invocations):\s*number;/gm)].map((m) => m[1]).sort();
}

/** String constants declared at module level (`const X = '…'`), so a clause shared via a constant is seen inline. */
function stringConstants(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^(?:export )?const (\w+)\s*=\s*'([^']*)'\s*;/gm)) out[m[1]] = m[2];
  return out;
}

/**
 * Field names in the `ADD …` clause of the UpdateExpression inside the named function. The expression
 * may be a concatenation of string literals and module-level string constants (e.g. a shared
 * `CW_CLAUSE`); both are resolved. Identifiers that are not string constants (runtime clauses such as
 * `lat.clause`) are ignored — they must not carry token counters.
 */
function addListOf(src: string, fnName: string): string[] {
  const start = src.indexOf(`function ${fnName}(`);
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  const expr = body.match(/UpdateExpression:\s*([\s\S]*?),\s*\n/);
  expect(expr).not.toBeNull();
  const consts = stringConstants(src);
  const text = expr![1].split('+').map((part) => {
    const p = part.trim();
    const lit = p.match(/^'([^']*)'$/); if (lit) return lit[1];
    const id = p.match(/^(\w+)$/); if (id && consts[id[1]] != null) return consts[id[1]];
    return '';
  }).join(' ');
  const add = text.match(/ADD\s+(.*)$/s);
  expect(add).not.toBeNull();
  return add![1].split(',').map((s) => s.trim().split(/\s+/)[0]).filter((f) => /^(\w+Tokens|invocations)$/.test(f)).sort();
}

const USAGE = countersOf('UsageAggregate');

describe('rollup writers persist every counter their aggregate carries', () => {
  const cases: [string, string][] = [
    ['UsageAggregate', 'upsertUsage'],
    ['UsageAggregate', 'upsertModelRollup'],
    ['ProjectAggregate', 'upsertProjectRollup'],
    ['ProjectDayAggregate', 'upsertProjectDayRollup'],
  ];
  for (const [iface, fn] of cases) {
    it(`${fn} ADDs every counter of ${iface}`, () => {
      expect(addListOf(aggSrc, fn)).toEqual(expect.arrayContaining(countersOf(iface)));
    });
  }
});

describe('all rollup shapes carry the same token counters as the hourly USAGE rollup', () => {
  it('derives a sane counter set from UsageAggregate', () => {
    expect(USAGE).toEqual(expect.arrayContaining(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'invocations']));
  });
  for (const iface of ['ProjectAggregate', 'ProjectDayAggregate']) {
    it(`${iface} carries every counter UsageAggregate carries`, () => {
      expect(countersOf(iface)).toEqual(USAGE);
    });
  }
});

describe('maintenance scripts touch the full counter set', () => {
  it('repair-projday-day.ts COUNTERS lists every PROJDAY counter', () => {
    const src = read(join(SCRIPTS, 'repair-projday-day.ts'));
    const m = src.match(/const COUNTERS = \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const listed = [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
    expect(listed).toEqual(countersOf('ProjectDayAggregate'));
  });
  it('backfill-projday.ts ADD clauses list every PROJDAY counter — or the file says it is superseded', () => {
    const src = read(join(SCRIPTS, 'backfill-projday.ts'));
    // A one-off script that must never be re-run may declare itself superseded instead of being kept current.
    const header = src.slice(0, 2500);
    if (/\bsuperseded\b/i.test(header) && /backfill-cache-write/.test(header)) return;
    const adds = [...src.matchAll(/ADD\s+([^']*)'/g)].map((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0]).filter((f) => /^(\w+Tokens|invocations)$/.test(f)).sort());
    expect(adds.length).toBeGreaterThan(0);
    for (const list of adds) expect(list).toEqual(expect.arrayContaining(countersOf('ProjectDayAggregate')));
  });
});
