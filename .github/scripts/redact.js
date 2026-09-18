'use strict';
/**
 * redact.js — the one place a workflow scrubs text before it is POSTed to GitHub.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * GitHub's secret masking is a scrubber on the *runner's log stream*. A body that
 * `actions/github-script` builds in JavaScript and hands to `issues.createComment`
 * never passes through it. On 2026-09-18 that gap put this AWS account's id into 38
 * comments on a public repository: the UI QA agent narrates its own uploads
 * ("published report to s3://token-monitor-qa-reports-<id>/pr-43/…"), the workflow
 * embedded that narration verbatim in a "Full agent output" block, and the job log —
 * where the same string appeared correctly as `token-monitor-qa-reports-***` —
 * gave every reader the impression the value was contained.
 *
 * So the rule this file encodes: **any agent-authored string goes through `redact()`
 * before it leaves the runner, and `findSecrets()` is asserted on the final body.**
 * A remote agent's free text is untrusted output — it can echo anything it saw in
 * its environment, not just the value we know about today.
 *
 * There is deliberately ONE copy of the pattern list. Two copies is the failure this
 * repository has already hit in other guises: the copies drift, the newer surface is
 * scanned by the older list, and both scanners report "clean".
 */

/**
 * AWS's published documentation placeholders. Masking them is noise, not safety, and
 * a scrubber that mangles the example account people are *supposed* to write is a
 * scrubber that gets removed.
 */
const DOC_ACCOUNTS = new Set(['123456789012', '111122223333', '999988887777']);

/** Exact-shape credentials: no context needed, a match is a match. */
const KEY_RULES = [
  [/AKIA[0-9A-Z]{16}/g, '<AWS_ACCESS_KEY>'],
  [/ASIA[0-9A-Z]{16}/g, '<AWS_TEMP_KEY>'],
  [/(aws_secret_access_key\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40}/gi, '$1<AWS_SECRET_KEY>'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '<GITHUB_PAT>'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/g, '<GITHUB_TOKEN>'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '<ANTHROPIC_KEY>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<JWT>'],
];

/**
 * A 12-digit run that is not one of AWS's example accounts.
 *
 * Note there is NO "an AWS-ish word must appear on the same line" guard here, unlike
 * a source-file scanner where a bare 12-digit run is usually a digest or a fixture.
 * The string that leaked was `s3://token-monitor-qa-reports-<12 digits>/` — no "aws",
 * no "account", no "arn:" on the line. In a comment body an over-mask costs a mangled
 * number in a QA transcript; an under-mask is the leak. So: mask on shape.
 */
const BARE_12 = /(?<![0-9A-Za-z_])[0-9]{12}(?![0-9A-Za-z_])/g;

/**
 * Scrub `text`. `opts.accountId` (default `process.env.AWS_ACCOUNT_ID`) is replaced
 * with `<ACCOUNT_ID>` by literal substring match first, so it is caught even where it
 * is glued to other characters and the shape rule below would not see it.
 */
function redact(text, opts) {
  if (text === null || text === undefined || text === '') return text;
  let out = String(text);

  const acct = (opts && opts.accountId) || process.env.AWS_ACCOUNT_ID || '';
  if (/^[0-9]{12}$/.test(acct)) out = out.split(acct).join('<ACCOUNT_ID>');

  for (const [re, sub] of KEY_RULES) out = out.replace(re, sub);
  out = out.replace(BARE_12, (m) => (DOC_ACCOUNTS.has(m) ? m : '<ACCOUNT_ID>'));
  return out;
}

/**
 * What `redact()` did NOT clean, as `{label, sample}` rows. The caller asserts this is
 * empty on the *final* body and degrades the comment if it is not — a redactor that is
 * merely called is a redactor nobody notices has stopped working.
 */
function findSecrets(text) {
  const out = [];
  if (!text) return out;
  const s = String(text);
  for (const [re, label] of KEY_RULES) {
    const m = s.match(new RegExp(re.source, re.flags.replace('g', '')));
    if (m) out.push({ label: label, sample: m[0].slice(0, 12) + '…' });
  }
  for (const m of s.matchAll(BARE_12)) {
    if (!DOC_ACCOUNTS.has(m[0])) {
      out.push({ label: '<ACCOUNT_ID>', sample: m[0].slice(0, 4) + '………' });
      break;
    }
  }
  return out;
}

module.exports = { redact, findSecrets, DOC_ACCOUNTS };
