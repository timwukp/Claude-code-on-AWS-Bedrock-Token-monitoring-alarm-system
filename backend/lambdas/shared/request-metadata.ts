/**
 * Pure helpers for building and attaching Bedrock `requestMetadata` tags (no AWS calls, so they
 * unit-test offline). This is "Mapping A" from docs/ATTRIBUTION.md: the tags the CALLING
 * application must stamp onto each InvokeModel/Converse call so the monitoring system can later
 * attribute usage per project / per user.
 *
 * Why this exists: there is no server-side way to enforce these tags — Bedrock only logs what the
 * caller sends, and IAM has no condition key for `requestMetadata` (see docs/INTEGRATION.md). The
 * practical control is a thin, validated SDK wrapper that callers run before every Bedrock call.
 *
 * Design goals: dependency-light (operates on a plain input object, no @aws-sdk import required),
 * strict about Bedrock's documented limits, and defensive about PII landing in long-lived logs.
 */

/** Bedrock's documented limits for requestMetadata (keys/values are strings). */
export const MAX_PAIRS = 16;
export const MAX_KEY_LENGTH = 256;
export const MAX_VALUE_LENGTH = 256;
/** Keep tags as short, stable codes — names get resolved later via the mapping CSV (Layer 3). */
export const RECOMMENDED_MAX_VALUE_LENGTH = 64;

/** Keys/values Bedrock accepts: letters, numbers, and a small safe punctuation set. */
const SAFE_KEY = /^[A-Za-z0-9_.:/=+@-]+$/;
/** Rough email shape — values matching this are almost certainly PII and are rejected. */
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface MetadataInput {
  /** Tenant scope key — mirrors the dashboard's tenant isolation. */
  tenant: string;
  /** Opaque project code (e.g. `proj-bravo`), resolved to a name via the mapping CSV. */
  project_id: string;
  /** Opaque user code (e.g. `u-2001`). MUST NOT be an email or other PII. */
  user_id: string;
  /** Optional extra tags (e.g. `team`, `env`). Same validation rules apply. */
  tags?: Record<string, string>;
}

/** A non-fatal advisory raised while building metadata (e.g. a value was truncated/sanitized). */
export interface MetadataWarning {
  key: string;
  message: string;
}

export interface BuildResult {
  /** The validated map ready to drop into a Bedrock request as `requestMetadata`. */
  metadata: Record<string, string>;
  warnings: MetadataWarning[];
}

/** Thrown when input cannot be made into valid metadata (missing field, PII, too many pairs). */
export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataValidationError';
  }
}

const REQUIRED_KEYS = ['tenant', 'project_id', 'user_id'] as const;

/**
 * Strip control characters and trim. Returns the cleaned value plus whether anything was removed
 * (so the caller can be warned that what lands in the log differs from what was passed in).
 */
function sanitizeValue(raw: string): { value: string; changed: boolean } {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return { value: stripped, changed: stripped !== raw };
}

/**
 * Build a validated `requestMetadata` map from {tenant, project_id, user_id, ...tags}.
 *
 * - Required fields must be non-empty strings, else {@link MetadataValidationError}.
 * - Keys must match Bedrock's allowed character set and length.
 * - An email-like `user_id` (or any value) is rejected outright — use an opaque id.
 * - Control characters are stripped and over-length values are truncated, each with a warning.
 * - The total pair count must not exceed Bedrock's limit ({@link MAX_PAIRS}).
 *
 * It never silently drops a key: anything unsafe is either fixed (with a warning) or throws.
 */
export function buildRequestMetadata(input: MetadataInput): BuildResult {
  if (input == null || typeof input !== 'object') {
    throw new MetadataValidationError('Metadata input must be an object.');
  }

  const warnings: MetadataWarning[] = [];
  const metadata: Record<string, string> = {};

  // Merge required fields and optional tags into one flat map, required first.
  const pairs: Array<[string, unknown]> = [
    ['tenant', input.tenant],
    ['project_id', input.project_id],
    ['user_id', input.user_id],
    ...Object.entries(input.tags ?? {}),
  ];

  const seen = new Set<string>();
  for (const [key, rawValue] of pairs) {
    if (seen.has(key)) {
      throw new MetadataValidationError(`Duplicate metadata key "${key}".`);
    }
    seen.add(key);

    const isRequired = (REQUIRED_KEYS as readonly string[]).includes(key);

    // Validate key shape/length.
    if (!SAFE_KEY.test(key)) {
      throw new MetadataValidationError(`Metadata key "${key}" contains unsupported characters.`);
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new MetadataValidationError(`Metadata key "${key}" exceeds ${MAX_KEY_LENGTH} characters.`);
    }

    // Require a string value; reject missing/empty required fields.
    if (rawValue === undefined || rawValue === null) {
      if (isRequired) throw new MetadataValidationError(`Missing required metadata field "${key}".`);
      continue;
    }
    if (typeof rawValue !== 'string') {
      throw new MetadataValidationError(`Metadata value for "${key}" must be a string.`);
    }

    const { value: sanitized, changed } = sanitizeValue(rawValue);
    if (changed) {
      warnings.push({ key, message: 'Removed control characters / surrounding whitespace.' });
    }

    if (sanitized.length === 0) {
      if (isRequired) throw new MetadataValidationError(`Required metadata field "${key}" is empty.`);
      warnings.push({ key, message: 'Empty after sanitization — tag omitted.' });
      continue;
    }

    // Reject obvious PII. Bedrock logs may be retained for years; an email is the classic leak.
    if (EMAIL_LIKE.test(sanitized)) {
      throw new MetadataValidationError(
        `Metadata value for "${key}" looks like an email address (PII). ` +
          'Use an opaque id (e.g. "u-2001"), not an email.',
      );
    }

    // Enforce hard length cap (truncate, warn); advise on the soft cap.
    let value = sanitized;
    if (value.length > MAX_VALUE_LENGTH) {
      value = value.slice(0, MAX_VALUE_LENGTH);
      warnings.push({ key, message: `Truncated to ${MAX_VALUE_LENGTH} characters.` });
    } else if (value.length > RECOMMENDED_MAX_VALUE_LENGTH) {
      warnings.push({
        key,
        message: `Longer than the recommended ${RECOMMENDED_MAX_VALUE_LENGTH} chars — prefer short, stable codes.`,
      });
    }

    metadata[key] = value;
  }

  const pairCount = Object.keys(metadata).length;
  if (pairCount > MAX_PAIRS) {
    throw new MetadataValidationError(`Too many metadata pairs (${pairCount}); Bedrock allows ${MAX_PAIRS}.`);
  }

  return { metadata, warnings };
}

/**
 * Minimal structural type for a Bedrock InvokeModel/Converse command input. Typed loosely so we
 * don't take a dependency on `@aws-sdk/client-bedrock-runtime`; the real `*CommandInput` types are
 * structurally compatible (they already carry an optional `requestMetadata?: Record<string,string>`).
 */
export interface BedrockRequestLike {
  requestMetadata?: Record<string, string>;
  [key: string]: unknown;
}

export interface WrapOptions {
  /**
   * When the input already carries `requestMetadata`, by default the built tags win on key
   * conflicts (the wrapper is the authoritative source). Set false to keep the caller's existing
   * values where keys overlap.
   */
  overrideExisting?: boolean;
}

/**
 * Inject validated `requestMetadata` into a Bedrock command input. Returns a NEW object (does not
 * mutate the caller's input) so it's safe to reuse a base request.
 *
 * Usage:
 *   const { input } = withRequestMetadata(baseInput, { tenant, project_id, user_id });
 *   await client.send(new InvokeModelCommand(input));
 */
export function withRequestMetadata<T extends BedrockRequestLike>(
  request: T,
  metadata: MetadataInput,
  options: WrapOptions = {},
): { input: T & { requestMetadata: Record<string, string> }; warnings: MetadataWarning[] } {
  if (request == null || typeof request !== 'object') {
    throw new MetadataValidationError('Bedrock request input must be an object.');
  }
  const overrideExisting = options.overrideExisting ?? true;
  const { metadata: built, warnings } = buildRequestMetadata(metadata);

  const existing = request.requestMetadata ?? {};
  const merged = overrideExisting ? { ...existing, ...built } : { ...built, ...existing };

  return { input: { ...request, requestMetadata: merged }, warnings };
}
