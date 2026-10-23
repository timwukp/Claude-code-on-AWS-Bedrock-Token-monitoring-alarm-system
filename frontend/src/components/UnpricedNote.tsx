import { UnpricedModel } from '../api/client';
import { fmtInt, fmtTokens } from '../lib/format';

/**
 * Names the models the rate card has no row for. Their usage is inside every dollar figure on the page at $0,
 * so a page that shows them must say so — a silent $0 is how OpenAI usage read as free before feature-36.
 */
export function UnpricedNote({ models, scope }: { models: UnpricedModel[] | undefined; scope: string }) {
  if (!models || models.length === 0) return null;
  const list = models.map((m) => `${m.modelId} (${fmtTokens(m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens)} tokens, ${fmtInt(m.invocations)} call${m.invocations === 1 ? '' : 's'})`).join(' · ');
  return (
    <p className="muted" role="note" data-testid="unpriced-note" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
      <span className="badge warning" style={{ marginRight: 6 }}>unpriced</span>
      {models.length === 1 ? '1 model' : `${models.length} models`} in {scope} {models.length === 1 ? 'has' : 'have'} no row on the rate card and {models.length === 1 ? 'is' : 'are'} counted at $0 in every figure here: {list}. Add the published rate to the card (backend/lambdas/api/cost-calc.ts) or treat the totals as a floor.
    </p>
  );
}
