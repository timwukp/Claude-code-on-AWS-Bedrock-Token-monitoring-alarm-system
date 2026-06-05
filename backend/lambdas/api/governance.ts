import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { BudgetsClient, DescribeBudgetCommand } from '@aws-sdk/client-budgets';
import { ok, serverError } from '../shared/response';

const budgets = new BudgetsClient({});
const ACCOUNT_ID = process.env.ACCOUNT_ID!;
const BUDGET_NAME = process.env.BEDROCK_BUDGET_NAME; // e.g. bedrock-monthly-dev
// Enforcement posture surfaced to the dashboard (set by the stack).
const AUTO_CONTAINMENT = process.env.ENABLE_AUTO_CONTAINMENT === 'true';
const BUDGET_ACTION_THRESHOLD = process.env.BUDGET_ACTION_THRESHOLD_PCT; // string or undefined

/**
 * GET /v1/governance — read-only cost-governance posture for the dashboard:
 *  - Bedrock budget limit, actual + forecasted spend (from AWS Budgets).
 *  - Enforcement status: whether the Budget Action hard-stop and per-principal containment are
 *    armed (config), so operators can see the guardrails without opening the AWS console.
 *
 * Read-only: it never changes any control. Missing budget (e.g. fresh deploy) degrades gracefully.
 */
export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    let budget: any = null;
    if (BUDGET_NAME) {
      try {
        const res = await budgets.send(new DescribeBudgetCommand({ AccountId: ACCOUNT_ID, BudgetName: BUDGET_NAME }));
        const b = res.Budget;
        budget = {
          name: b?.BudgetName,
          limitUsd: num(b?.BudgetLimit?.Amount),
          actualUsd: num(b?.CalculatedSpend?.ActualSpend?.Amount),
          forecastedUsd: num(b?.CalculatedSpend?.ForecastedSpend?.Amount),
          timeUnit: b?.TimeUnit,
        };
        if (budget.limitUsd > 0) {
          budget.actualPct = Math.round((budget.actualUsd / budget.limitUsd) * 1000) / 10;
          budget.forecastedPct = Math.round((budget.forecastedUsd / budget.limitUsd) * 1000) / 10;
        }
      } catch (e) {
        budget = { error: 'budget not found or not yet populated', name: BUDGET_NAME };
      }
    }

    const enforcement = {
      autoContainment: AUTO_CONTAINMENT,
      budgetActionArmed: !!BUDGET_ACTION_THRESHOLD,
      budgetActionThresholdPct: BUDGET_ACTION_THRESHOLD ? Number(BUDGET_ACTION_THRESHOLD) : null,
      mode: AUTO_CONTAINMENT ? 'enforce' : 'notify-only',
    };

    return ok({ budget, enforcement });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
