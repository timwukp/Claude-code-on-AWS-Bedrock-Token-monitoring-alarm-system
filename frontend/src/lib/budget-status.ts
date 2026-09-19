import type { GovernanceBudget } from '../api/client';
import type { Tone } from '../components/KpiTile';

export type BudgetState = 'setup-required' | 'no-billing-data' | 'ok' | 'forecast-over' | 'over';

/**
 * AWS Budgets can report "$0" for two very different reasons — nothing spent, or nothing billed to
 * this account (a payer account bills instead). The additive `billingDataAvailable` flag tells them
 * apart; older API builds omit it, in which case a positive amount still proves availability.
 */
export function budgetState(b: GovernanceBudget | null | undefined): BudgetState {
  if (!b || b.error || !(b.limitUsd > 0)) return 'setup-required';
  const available = b.billingDataAvailable ?? (b.actualUsd > 0 || b.forecastedUsd > 0);
  if (!available) return 'no-billing-data';
  if (b.actualUsd > b.limitUsd) return 'over';
  if (b.forecastedUsd > b.limitUsd) return 'forecast-over';
  return 'ok';
}

export const BUDGET_STATUS: Record<BudgetState, { tone: Tone; text: string }> = {
  ok: { tone: 'ok', text: 'On track' },
  'forecast-over': { tone: 'warn', text: 'Forecast over budget' },
  over: { tone: 'danger', text: 'Over budget' },
  'no-billing-data': { tone: 'neutral', text: 'No billing data on this account' },
  'setup-required': { tone: 'info', text: 'Setup required' },
};
