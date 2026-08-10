/**
 * CLOAK API adapter + rate limiter.
 *
 * The free plan allows 10 requests/minute, which is the binding constraint on a
 * database scan: one request per column adds up fast. Everything that talks to
 * CLOAK goes through the limiter here so the scan paces itself instead of
 * collecting 429s halfway through a client demo.
 */

const DEFAULT_TIMEOUT_MS = 90_000;

export class CloakError extends Error {
  constructor(message, { code = 'upstream_failed', retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'CloakError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Sliding-window limiter with even pacing.
 *
 * A pure sliding window would let all `limit` calls fire back-to-back and then
 * stall for the rest of the window. That bursty shape trips the CLOAK limiter
 * in practice: if the server counts in fixed per-minute buckets, a burst that
 * straddles a bucket boundary can exceed the quota even though the rolling
 * 60-second count never does. So requests are also spaced at least
 * `windowMs / limit` apart (6s at 10/min), which keeps the rate identical but
 * removes the bursts.
 *
 * `blockFor()` lets a real 429 override our local accounting — the server is
 * always the authority on how much budget is left.
 */
export class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000, pace = true } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.minIntervalMs = pace ? Math.ceil(windowMs / limit) : 0;
    this.hits = [];
    this.blockedUntil = 0;
  }

  /** Milliseconds to wait before another call is allowed (0 if free now). */
  waitMs(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);

    let wait = 0;
    if (this.hits.length >= this.limit) {
      wait = this.windowMs - (now - this.hits[0]) + 50;
    }
    const last = this.hits[this.hits.length - 1];
    if (last !== undefined) {
      wait = Math.max(wait, this.minIntervalMs - (now - last));
    }
    if (this.blockedUntil > now) {
      wait = Math.max(wait, this.blockedUntil - now);
    }
    return Math.max(0, wait);
  }

  record(now = Date.now()) {
    this.hits.push(now);
  }

  /**
   * Adopt a rate discovered from the API. Returns true if anything changed, so
   * the caller can log it once rather than on every 429.
   */
  reconfigure({ limit, windowMs }) {
    const nextLimit = Number(limit) > 0 ? Number(limit) : this.limit;
    const nextWindow = Number(windowMs) > 0 ? Number(windowMs) : this.windowMs;
    if (nextLimit === this.limit && nextWindow === this.windowMs) return false;
    this.limit = nextLimit;
    this.windowMs = nextWindow;
    if (this.minIntervalMs > 0) this.minIntervalMs = Math.ceil(nextWindow / nextLimit);
    return true;
  }

  /** Honour a server-side 429: refuse to issue anything until `ms` have passed. */
  blockFor(ms, now = Date.now()) {
    this.blockedUntil = Math.max(this.blockedUntil, now + Math.max(0, ms));
  }

  async acquire(onWait) {
    for (;;) {
      const wait = this.waitMs();
      if (wait <= 0) break;
      if (onWait) onWait(wait);
      await sleep(wait);
    }
    this.record();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How the API key is presented. Exactly ONE auth header is sent — sending
 * several "just in case" breaks any gateway that parses `Authorization`
 * itself.
 *
 * Seen in the wild: an endpoint replying
 *   "Invalid key=value pair (missing equal-sign) in Authorization header"
 * to `Authorization: Bearer <key>`, because the layer in front of it expects a
 * signed `key=value` Authorization header of its own. Endpoints like that need
 * the `x-api-key` mode, with no Authorization header at all.
 */
export const AUTH_MODES = {
  bearer: { label: 'Authorization: Bearer <key>', header: (k) => ({ Authorization: `Bearer ${k}` }) },
  'x-api-key': { label: 'x-api-key: <key>', header: (k) => ({ 'x-api-key': k }) },
  raw: { label: 'Authorization: <key>', header: (k) => ({ Authorization: k }) },
};

export const DEFAULT_AUTH_MODE = 'bearer';

/**
 * Request bodies, per provider. Responses are handled by one parser (see
 * readEntity) because it already covers both shapes.
 *
 * ADD A PROVIDER HERE — this is the only place that knows a wire format.
 */
/**
 * Known request-body shapes, tried in this order when the provider is `auto`.
 * Providers disagree only on the request; one parser handles every response.
 */
const BODY_SHAPES = [
  { id: 'list', label: 'text as a list', build: (text) => ({ text: [text] }) },
  { id: 'string', label: 'text as a string', build: (text) => ({ text }) },
  { id: 'content', label: 'content as a string', build: (text) => ({ content: text }) },
];

export const PROVIDERS = {
  auto: {
    label: 'Auto-detect',
    defaultAuthMode: 'x-api-key',
    endpointHint: '',
    shape: null,   // resolved on the first successful request
  },
  cloak: {
    label: 'CLOAK',
    defaultAuthMode: 'bearer',
    endpointHint: 'https://api.cloak-ai.co/api/v1/detect',
    shape: 'string',
  },
};

export const DEFAULT_PROVIDER = 'auto';

function buildRequest(text, apiKey, authMode, shape) {
  const mode = AUTH_MODES[authMode] ?? AUTH_MODES[DEFAULT_AUTH_MODE];
  return {
    body: shape.build(text),
    headers: {
      ...mode.header(apiKey),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
}

/**
 * The response for a single-element `text` list may arrive either as a bare
 * object or wrapped one level (a list, or under results/data). Unwrap to the
 * object that carries `entities` before mapping it.
 */
function unwrapResult(payload) {
  if (Array.isArray(payload)) return payload[0] ?? {};
  for (const key of ['results', 'data', 'items', 'detections']) {
    const nested = payload?.[key];
    if (Array.isArray(nested) && nested.length && !nested[0]?.type) return nested[0];
  }
  return payload ?? {};
}

/**
 * Providers label the same concepts differently. Everything downstream — the
 * severity ranking, the detection profile, the regulation mapping — speaks the
 * CLOAK taxonomy, so incoming labels are translated to it here.
 *
 * Add a row when a provider returns a label the catalogue does not know; the
 * scan log names any label that arrives unmapped.
 */
const LABEL_ALIASES = {
  NAME: 'PERSON_NAME',
  NAME_GIVEN: 'PERSON_NAME',
  NAME_FAMILY: 'PERSON_NAME',
  FULL_NAME: 'PERSON_NAME',
  EMAIL_ADDRESS: 'EMAIL',
  PHONE: 'PHONE_NUMBER',
  TELEPHONE: 'PHONE_NUMBER',
  STREET_ADDRESS: 'ADDRESS',
  LOCATION_ADDRESS: 'ADDRESS',
  POSTCODE: 'ZIP_CODE',
  POSTAL_CODE: 'ZIP_CODE',
  DOB: 'DATE_OF_BIRTH',
  BIRTH_DATE: 'DATE_OF_BIRTH',
  CREDIT_CARD_NUMBER: 'CREDIT_CARD',
  CARD_NUMBER: 'CREDIT_CARD',
  CVV_CODE: 'CVV',
  BANK_ACCOUNT: 'BANK_ACCOUNT_NUMBER',
  IP: 'IP_ADDRESS',
  SSN_NUMBER: 'SSN',
  PASSPORT_NUMBER: 'PASSPORT',
  DRIVERS_LICENSE: 'DRIVING_LICENSE',
  DRIVER_LICENSE: 'DRIVING_LICENSE',
  ORG: 'ORGANIZATION',
  COMPANY: 'ORGANIZATION',
};

function canonicalType(label) {
  const raw = String(label ?? 'PII').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return { type: LABEL_ALIASES[raw] ?? raw, original: raw };
}

/**
 * Read one entity from whichever shape the provider uses.
 *
 * One common shape is:
 *   { text, best_label, labels: { LABEL: score }, location: { stt_idx, end_idx } }
 * Note `stt_idx`/`end_idx` index the ORIGINAL text, while the `_processed`
 * pair indexes the redacted output — only the former lines up with what we sent.
 */
function readEntity(e) {
  const label = e?.best_label ?? e?.type ?? e?.label ?? e?.entity_type ?? 'PII';
  const { type, original } = canonicalType(label);

  const loc = e?.location ?? {};
  const start = firstInt(e?.start, loc.stt_idx, loc.start, e?.start_index, e?.begin);
  const end = firstInt(e?.end, loc.end_idx, loc.end, e?.end_index, e?.stop);

  // Some APIs score every candidate label; take the score for the chosen one.
  const scored = e?.labels && typeof e.labels === 'object'
    ? e.labels[label] ?? Math.max(...Object.values(e.labels).filter(Number.isFinite), 0)
    : undefined;

  return {
    type,
    original,
    text: String(e?.text ?? e?.value ?? ''),
    start,
    end,
    confidence: clampConfidence(scored ?? e?.confidence ?? e?.score),
  };
}

function firstInt(...values) {
  for (const v of values) if (Number.isInteger(v)) return v;
  return null;
}

function normalize(raw) {
  const payload = unwrapResult(raw);
  const entities = Array.isArray(payload?.entities) ? payload.entities : [];
  const mapped = entities.map(readEntity)
    .filter((e) => e.text && e.start !== null && e.end !== null);

  return {
    entities: mapped,
    redactedText: typeof payload?.redacted_text === 'string' ? payload.redacted_text
      : typeof payload?.processed_text === 'string' ? payload.processed_text : '',
    processingTimeMs: Number(payload?.processing_time_ms ?? payload?.processingTimeMs) || 0,
  };
}

function clampConfidence(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n > 1) n /= 100;
  return Math.round(Math.min(Math.max(n, 0), 1) * 10000) / 10000;
}

export class CloakClient {
  constructor({
    endpoint, apiKey, limiter,
    authMode = DEFAULT_AUTH_MODE,
    provider = DEFAULT_PROVIDER,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }) {
    if (!endpoint) throw new CloakError('CLOAK endpoint is not set.', { code: 'not_configured' });
    if (!apiKey) throw new CloakError('CLOAK API key is not set.', { code: 'not_configured' });
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.authMode = AUTH_MODES[authMode] ? authMode : DEFAULT_AUTH_MODE;
    this.provider = PROVIDERS[provider] ? provider : DEFAULT_PROVIDER;
    this.providerLabel = PROVIDERS[this.provider].label;

    // A named provider pins the shape; `auto` walks the list until one is
    // accepted, then sticks with it for the rest of the scan.
    const pinned = PROVIDERS[this.provider].shape;
    this.shapeIndex = pinned ? BODY_SHAPES.findIndex((s) => s.id === pinned) : 0;
    this.shapeLocked = Boolean(pinned);
    this.limiter = limiter ?? new RateLimiter();
    this.timeoutMs = timeoutMs;
    this.requestCount = 0;
    this.rateLimitHits = 0;
    /** What we have learned about the caller's plan at runtime. */
    this.plan = { limit: this.limiter.limit, windowMs: this.limiter.windowMs, name: null, source: 'configured' };
    this.quota = null;   // { wordsLimit, wordsUsed }
    this.lastRaw = '';   // last raw response body, truncated - for the API test
    this.onPlanChange = null;
  }

  /**
   * Detect over one blob of text.
   *
   * `onWait(ms, info)` is called whenever the caller has to wait — either
   * because the local pacer is holding back, or because the server returned a
   * 429 and we are backing off before retrying. A 429 is retried rather than
   * surfaced, because losing a column mid-scan means a gap in the report.
   */
  get shape() {
    return BODY_SHAPES[Math.min(this.shapeIndex, BODY_SHAPES.length - 1)];
  }

  /**
   * Try the next body shape. Returns false once the options are exhausted.
   * Only `auto` negotiates; a named provider fails loudly instead of silently
   * sending a shape its API never asked for.
   */
  #nextShape() {
    if (this.shapeLocked || this.shapeIndex >= BODY_SHAPES.length - 1) return false;
    this.shapeIndex += 1;
    return true;
  }

  /**
   * Detect over one blob of text.
   *
   * A 400 means the body shape was wrong, not that the text was bad, so in
   * auto mode we walk to the next candidate and try again. The winning shape is
   * then locked in, so the negotiation costs at most a few requests once per
   * scan rather than per column.
   */
  async detect(text, options = {}) {
    for (;;) {
      try {
        const value = await this.#detectWithShape(text, options);
        this.shapeLocked = true;
        return value;
      } catch (err) {
        if (err?.code === 'bad_request' && this.#nextShape()) {
          if (options.onWait) options.onWait(0, { reason: 'shape_retry', shape: this.shape.id });
          continue;
        }
        throw err;
      }
    }
  }

  async #detectWithShape(text, { onWait, maxRetries = 4 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.#attempt(text, onWait);
      if (!result.rateLimited) return result.value;

      // The server is the authority: park the local limiter for its retry hint.
      // Without a usable hint, back off by the pacing interval and escalate.
      // The 1s floor stops a "Retry in 0s" reply turning into a hot loop.
      // The rate limit is plan-dependent; adopt whatever the API just told us.
      this.#adoptPlan(result.plan, '429 response');

      const hinted = result.retryAfterMs || 0;
      const floor = Math.max(this.limiter.minIntervalMs, 1000);
      const backoff = Math.min(
        hinted > 0 ? Math.max(hinted, floor) : floor * (attempt + 1),
        60_000
      );
      this.limiter.blockFor(backoff);
      this.rateLimitHits += 1;

      if (attempt >= maxRetries) {
        throw new CloakError(result.message, { code: 'rate_limited', retryAfterMs: backoff });
      }
      if (onWait) onWait(backoff, { reason: 'rate_limited', attempt: attempt + 1 });
      await sleep(backoff);
    }
  }

  #adoptPlan(discovered, source) {
    if (!discovered) return;
    const changed = this.limiter.reconfigure(discovered);
    const named = discovered.plan && discovered.plan !== this.plan.name;
    if (!changed && !named) return;

    this.plan = {
      limit: this.limiter.limit,
      windowMs: this.limiter.windowMs,
      name: discovered.plan ?? this.plan.name,
      source,
    };
    if (this.onPlanChange) this.onPlanChange(this.plan);
  }

  async #attempt(text, onWait) {
    await this.limiter.acquire(onWait ? (ms) => onWait(ms, { reason: 'pacing' }) : undefined);
    this.requestCount += 1;

    const { body, headers } = buildRequest(text, this.apiKey, this.authMode, this.shape);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new CloakError(`${this.providerLabel} request timed out.`, { code: 'timeout' });
      }
      throw new CloakError(`Could not reach ${this.providerLabel}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const quota = parseQuota(response.headers);
    if (quota) this.quota = quota;
    this.#adoptPlan(parseRateHeaders(response.headers), 'response headers');

    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.trim();
      try {
        const parsed = JSON.parse(raw);
        detail = String(parsed?.error ?? parsed?.message ?? detail);
      } catch {
        /* keep raw text */
      }
      if (response.status === 429) {
        // Signalled to the retry loop rather than thrown, so one 429 does not
        // cost us the column.
        return {
          rateLimited: true,
          message: detail || `${this.providerLabel} rate limit reached.`,
          retryAfterMs: parseRetryAfter(detail, response.headers.get('retry-after')),
          plan: parsePlanLimit(detail),
        };
      }
      if (response.status === 401 || response.status === 403) {
        throw new CloakError(detail || 'The API rejected the key.', { code: 'unauthorized' });
      }
      // Some endpoints reject `Authorization: Bearer` at the gateway, before the
      // request reaches the service. Name the actual cause rather than leaving
      // the operator staring at a header-parser error.
      if (/Authorization header|key=value pair|SignedHeaders|AWS4-HMAC/i.test(detail)) {
        throw new CloakError(
          `${detail} — the endpoint rejected the "${AUTH_MODES[this.authMode].label}" ` +
          'scheme at the gateway. Switch the auth header mode (x-api-key is the usual fix) ' +
          'and check the provider docs for the header they expect.',
          { code: 'auth_scheme' }
        );
      }
      throw new CloakError(
        `${this.providerLabel} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` +
        (response.status === 400
          ? ` — tried every known request shape against this endpoint, so the URL path is the`
            + ' likely problem rather than the body.'
          : ''),
        { code: response.status === 400 ? 'bad_request' : 'upstream_failed' }
      );
    }

    this.lastRaw = raw.slice(0, 600);
    try {
      return { rateLimited: false, value: normalize(JSON.parse(raw)) };
    } catch {
      throw new CloakError('CLOAK returned a non-JSON response.');
    }
  }
}

const WINDOW_MS = {
  sec: 1000, second: 1000, s: 1000,
  min: 60_000, minute: 60_000, m: 60_000,
  hour: 3_600_000, hr: 3_600_000, h: 3_600_000,
  day: 86_400_000, d: 86_400_000,
};

/**
 * The rate limit is plan-dependent, and the API sends no rate-limit headers, so
 * the 429 body is the only place it is stated:
 *
 *   "Rate limit exceeded (10 requests/min on free plan). Retry in 5s."
 *
 * Parsing it lets the scanner adopt the caller's actual plan instead of relying
 * on whatever CLOAK_RATE_LIMIT happened to be configured.
 */
function parsePlanLimit(message) {
  const text = String(message ?? '');
  const rate = /(\d+)\s*requests?\s*(?:per|\/)\s*([a-z]+)/i.exec(text);
  if (!rate) return null;

  const windowMs = WINDOW_MS[rate[2].toLowerCase()];
  if (!windowMs) return null;

  const plan = /on\s+(?:the\s+)?([a-z0-9][a-z0-9 _-]*?)\s+plan/i.exec(text);
  return {
    limit: Number(rate[1]),
    windowMs,
    plan: plan ? plan[1].trim().toLowerCase() : null,
  };
}

/** Standard-ish rate headers, in case CLOAK starts sending them. */
function parseRateHeaders(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  const limit = Number(get('x-ratelimit-limit') ?? get('ratelimit-limit'));
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const windowSeconds = Number(get('x-ratelimit-window') ?? get('ratelimit-window'));
  return {
    limit,
    windowMs: Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds * 1000 : 60_000,
    plan: null,
  };
}

/** The API reports a word quota on every response; worth surfacing on a big scan. */
function parseQuota(headers) {
  const get = (name) => headers?.get?.(name) ?? null;
  const rawLimit = get('x-words-limit');
  const rawUsed = get('x-words-used');
  // Number(null) is 0, so absent headers must be rejected before conversion -
  // otherwise a missing quota renders as a very alarming "0 / 0".
  if (rawLimit === null || rawUsed === null || rawLimit === '' || rawUsed === '') return null;
  const limit = Number(rawLimit);
  const used = Number(rawUsed);
  if (!Number.isFinite(limit) || !Number.isFinite(used) || limit <= 0) return null;
  return { wordsLimit: limit, wordsUsed: used };
}

/** Pull "Retry in 6s" out of the message, or fall back to the Retry-After header. */
function parseRetryAfter(message, header) {
  const fromMessage = /retry in (\d+)\s*s/i.exec(String(message ?? ''));
  if (fromMessage) return Number(fromMessage[1]) * 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return 0;
}
