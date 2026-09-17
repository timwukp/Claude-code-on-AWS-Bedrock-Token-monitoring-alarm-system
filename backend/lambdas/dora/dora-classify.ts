/**
 * Pure classifiers for DORA inputs (no I/O), ported from the reference implementation's
 * `pr_classifier.py` and extended with AI-assistant attribution that scans commit trailers,
 * the PR body AND the author (the reference only looked at the PR body).
 */
import { AssistedBy } from './types';

const REVERT_TITLE_RE = /^revert\b/i;
const HOTFIX_TITLE_RE = /^(hotfix\b|\[hotfix\])/i;
const HOTFIX_BRANCH_RE = /^(hotfix|patch)([/_-]|$)/i;

const lower = (xs: readonly string[] | undefined) => (xs ?? []).map((l) => (l ?? '').toLowerCase());

/** A PR that undoes a previous change (counts as a change failure). */
export function isRevertPr(title: string | null | undefined, labels?: readonly string[]): boolean {
  if (lower(labels).includes('revert')) return true;
  return !!title && REVERT_TITLE_RE.test(title.trim());
}

/** A PR shipped to repair production (counts as a failure AND as a recovery event for MTTR). */
export function isHotfixPr(
  title: string | null | undefined,
  headRef: string | null | undefined,
  labels?: readonly string[],
): boolean {
  const ls = lower(labels);
  if (ls.includes('hotfix') || ls.includes('incident')) return true;
  if (title && HOTFIX_TITLE_RE.test(title.trim())) return true;
  if (headRef && HOTFIX_BRANCH_RE.test(headRef.trim())) return true;
  return false;
}

/** Labels that mark an issue as an incident for CFR / MTTR purposes. */
export const INCIDENT_LABELS = ['incident', 'bug'] as const;

/** GitHub's issues API also returns PRs (with a `pull_request` key) — those are excluded. */
export function isIncidentIssue(issue: { labels?: readonly string[]; pull_request?: unknown }): boolean {
  if (issue.pull_request) return false;
  const ls = lower(issue.labels);
  return INCIDENT_LABELS.some((l) => ls.includes(l));
}

export interface AiDetectionInput {
  /** PR author login, e.g. 'timwukp' or 'amazon-q-developer[bot]'. */
  author?: string | null;
  /** PR body (markdown). */
  body?: string | null;
  /** Full commit messages of the PR's commits (trailers live at the end of each). */
  commitMessages?: readonly string[];
}

export interface AiDetection {
  assistedBy: AssistedBy;
  /** Every signal that fired, in precedence order — kept on the item for debugging. */
  signals: string[];
}

interface Rule {
  tool: Exclude<AssistedBy, null>;
  signal: string;
  re: RegExp;
}

// Commit-trailer patterns (checked per commit message). Real examples seen in the tracked repos:
//   "Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
//   "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
const TRAILER_RULES: Rule[] = [
  { tool: 'claude-code', signal: 'trailer:claude', re: /co-authored-by:\s*claude\b|<noreply@anthropic\.com>/i },
  { tool: 'copilot', signal: 'trailer:copilot', re: /co-authored-by:\s*(github-)?copilot\b/i },
  { tool: 'kiro', signal: 'trailer:kiro', re: /co-authored-by:\s*kiro\b/i },
  { tool: 'amazon-q', signal: 'trailer:amazon-q', re: /co-authored-by:\s*amazon[- ]q\b/i },
];

// PR-body markers. Real examples: "🤖 Generated with [Claude Code](…)", "built with Kiro",
// "Amazon Q Developer". Word boundaries keep "kiro" from matching inside other words.
const BODY_RULES: Rule[] = [
  { tool: 'claude-code', signal: 'body:claude-code', re: /claude[- ]code|generated with \[?claude|co-authored-by:\s*claude/i },
  { tool: 'kiro', signal: 'body:kiro', re: /\bkiro\b/i },
  { tool: 'amazon-q', signal: 'body:amazon-q', re: /\bamazon[- ]q\b/i },
  { tool: 'copilot', signal: 'body:copilot', re: /\bcopilot\b/i },
];

// Bot authors. GitHub bot logins end in "[bot]".
const AUTHOR_RULES: Rule[] = [
  { tool: 'amazon-q', signal: 'author:amazon-q-bot', re: /^amazon-q[\w-]*\[bot\]$/i },
  { tool: 'copilot', signal: 'author:copilot-bot', re: /copilot.*\[bot\]$/i },
  { tool: 'claude-code', signal: 'author:claude-bot', re: /claude.*\[bot\]$/i },
  { tool: 'kiro', signal: 'author:kiro-bot', re: /kiro.*\[bot\]$/i },
];

/**
 * Attribute a PR to an AI assistant. Precedence: commit trailers (strongest evidence — the tool
 * wrote code) > author bot > body markers (weakest — a body may merely *mention* a tool). The
 * first tool found in that order wins; all fired signals are returned.
 */
export function detectAssistedBy(input: AiDetectionInput): AiDetection {
  const signals: string[] = [];
  let assistedBy: AssistedBy = null;
  const hit = (rule: Rule) => {
    signals.push(rule.signal);
    if (!assistedBy) assistedBy = rule.tool;
  };

  for (const msg of input.commitMessages ?? []) {
    for (const r of TRAILER_RULES) if (r.re.test(msg) && !signals.includes(r.signal)) hit(r);
  }
  const author = (input.author ?? '').trim();
  if (author) for (const r of AUTHOR_RULES) if (r.re.test(author)) hit(r);
  const body = input.body ?? '';
  if (body) for (const r of BODY_RULES) if (r.re.test(body)) hit(r);

  return { assistedBy, signals };
}
