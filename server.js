/**
 * CLOAK PII Discovery for PostgreSQL — Express server.
 *
 * Holds the DB credentials and the CLOAK key server-side for the duration of a
 * scan only; neither is ever written to disk or echoed back to the browser.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  AUTH_MODES, CloakClient, CloakError, DEFAULT_AUTH_MODE, DEFAULT_PROVIDER,
  PROVIDERS, RateLimiter,
} from './src/cloakClient.js';
import {
  buildPgConfig, listCandidateColumns, redactConnection, summariseStorage, testConnection,
} from './src/db.js';
import { ScanJob, runScan } from './src/scanner.js';
import { ENTITY_TYPES, GROUPS, PRESETS, resolveSelection } from './src/entityTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 4000;
const JOB_TTL_MS = 30 * 60_000;

// Starting assumption only. The real rate depends on the CLOAK plan and is
// discovered from the API during the scan (see the client's plan detection).
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

const app = express();
app.use(express.json({ limit: '256kb' }));
// No caching for the UI: this is a locally-run tool that gets edited, and a
// browser holding a stale app.js/styles.css looks exactly like a broken feature.
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

/** jobId -> { job, pool } */
const jobs = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of jobs) {
    const finished = entry.job.finishedAt ?? 0;
    if (finished && now - finished > JOB_TTL_MS) {
      entry.pool?.end().catch(() => {});
      jobs.delete(id);
    }
  }
}, 60_000).unref();

/**
 * Credentials come from the browser, never from disk. The operator copies the
 * endpoint and key out of their CLOAK dashboard, and both live in memory for
 * the duration of the scan only.
 */
function resolveCloak(body = {}) {
  const authMode = String(body.cloakAuthMode ?? '').trim();
  const provider = String(body.cloakProvider ?? '').trim();
  return {
    endpoint: String(body.cloakEndpoint ?? '').trim(),
    apiKey: String(body.cloakApiKey ?? '').trim(),
    authMode: AUTH_MODES[authMode] ? authMode : DEFAULT_AUTH_MODE,
    provider: PROVIDERS[provider] ? provider : DEFAULT_PROVIDER,
  };
}

function fail(res, status, message, code = 'bad_request') {
  return res.status(status).json({ error: message, code });
}

// ---------------------------------------------------------------------------

app.get('/api/config', (_req, res) => {
  res.json({
    rateLimit: RATE_LIMIT,
    rateWindowMs: RATE_WINDOW_MS,
    authModes: Object.entries(AUTH_MODES).map(([id, m]) => ({ id, label: m.label })),
    defaultAuthMode: DEFAULT_AUTH_MODE,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, label: p.label, defaultAuthMode: p.defaultAuthMode, endpointHint: p.endpointHint,
    })),
    defaultProvider: DEFAULT_PROVIDER,
  });
});

/** The full entity taxonomy, its groupings and the ready-made presets. */
app.get('/api/entity-types', (_req, res) => {
  res.json({ groups: GROUPS, types: ENTITY_TYPES, presets: PRESETS });
});

/**
 * One throwaway detection, to prove the endpoint, key and auth header work
 * before committing to a scan that costs one request per column.
 */
app.post('/api/test-cloak', async (req, res) => {
  const { endpoint, apiKey, authMode, provider } = resolveCloak(req.body);
  if (!endpoint || !apiKey) {
    return fail(res, 400, 'Endpoint and API key are both required.', 'not_configured');
  }

  const cloak = new CloakClient({
    endpoint, apiKey, authMode, provider,
    limiter: new RateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS }),
  });

  try {
    const result = await cloak.detect('Contact Jane Doe on 07700 900341 or jane@example.com.');
    res.json({
      ok: true,
      entities: result.entities.length,
      types: [...new Set(result.entities.map((e) => e.type))],
      processingTimeMs: result.processingTimeMs,
      plan: cloak.plan,
      quota: cloak.quota,
      raw: cloak.lastRaw,
    });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code ?? 'upstream_failed' });
  }
});

/** Connect, verify, and return the inventory of scannable columns. */
app.post('/api/inspect', async (req, res) => {
  const { connection = {}, includeJson = true, includeViews = false } = req.body ?? {};
  let pool;
  try {
    pool = new pg.Pool(buildPgConfig(connection));
  } catch (err) {
    return fail(res, 400, err.message, 'bad_connection');
  }

  try {
    const info = await testConnection(pool);
    const columns = await listCandidateColumns(pool, { includeJson, includeViews });
    const storage = await summariseStorage(pool);

    const tables = new Map();
    for (const col of columns) {
      const key = `${col.schema}.${col.table}`;
      if (!tables.has(key)) tables.set(key, { schema: col.schema, table: col.table, columns: 0 });
      tables.get(key).columns += 1;
    }
    const schemas = [...new Set(columns.map((c) => c.schema))].sort();

    res.json({
      server: { database: info.database, user: info.user, version: String(info.version).split(' ').slice(0, 2).join(' ') },
      target: redactConnection(connection),
      schemas,
      tables: [...tables.values()].sort((a, b) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table)),
      columns,
      storage,
      totals: { schemas: schemas.length, tables: tables.size, columns: columns.length },
    });
  } catch (err) {
    return fail(res, 502, friendlyPgError(err), 'connect_failed');
  } finally {
    pool.end().catch(() => {});
  }
});

/** Start a scan. Returns a job id to poll. */
app.post('/api/scan', async (req, res) => {
  const {
    connection = {},
    schemas = [],
    rowsPerColumn = 40,
    maxColumns = 60,
    includeJson = true,
    includeViews = false,
    entityTypes = [],
  } = req.body ?? {};

  const selection = resolveSelection(entityTypes);
  const { endpoint, apiKey, authMode, provider } = resolveCloak(req.body);
  if (!endpoint || !apiKey) {
    return fail(res, 400, 'API endpoint and API key are both required.', 'not_configured');
  }

  let pool;
  try {
    pool = new pg.Pool(buildPgConfig(connection));
  } catch (err) {
    return fail(res, 400, err.message, 'bad_connection');
  }

  let columns;
  try {
    columns = await listCandidateColumns(pool, { includeJson, includeViews });
  } catch (err) {
    pool.end().catch(() => {});
    return fail(res, 502, friendlyPgError(err), 'connect_failed');
  }

  if (schemas.length) {
    const allowed = new Set(schemas);
    columns = columns.filter((c) => allowed.has(c.schema));
  }
  const cap = resolveColumnCap(maxColumns);
  const limited = cap === null ? columns : columns.slice(0, cap);

  if (!limited.length) {
    pool.end().catch(() => {});
    return fail(res, 400, 'No text columns matched the selected scope.', 'empty_scope');
  }

  // RATE_LIMIT is only a starting assumption: the real limit depends on the
  // caller's CLOAK plan and is discovered from the API during the scan.
  const cloak = new CloakClient({
    endpoint,
    apiKey,
    authMode,
    provider,
    limiter: new RateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS }),
  });

  const job = new ScanJob({
    scope: {
      schemas, rowsPerColumn, maxColumns,
      entityTypes: selection.types,
      allEntityTypes: selection.all,
    },
    redactedTarget: redactConnection(connection),
  });
  job.logLine('info', `Target ${job.target.value}`);
  job.logLine('info', `Detection API: ${PROVIDERS[provider].label} at ${endpoint}`);
  job.logLine('info', selection.all
    ? `Reporting all ${selection.types.length} entity types.`
    : `Reporting ${selection.types.length} selected entity type(s); others are classified but suppressed.`);
  if (selection.unknown.length) {
    job.logLine('warn', `Ignored unknown entity type(s): ${selection.unknown.join(', ')}`);
  }
  if (columns.length > limited.length) {
    job.logLine('warn', `Scope capped at ${limited.length} of ${columns.length} candidate columns.`);
  }

  jobs.set(job.id, { job, pool });
  res.status(202).json({
    jobId: job.id,
    columns: limited.length,
    estimatedRequests: limited.length,
    entityTypes: selection.types.length,
  });

  // Fire and forget; the client polls /api/scan/:id.
  runScan({
    job, pool, cloak, columns: limited,
    rowsPerColumn: clampRows(rowsPerColumn),
    allowedTypes: new Set(selection.types),
  })
    .catch((err) => {
      job.status = 'error';
      job.error = { message: err.message, code: 'scan_failed' };
    })
    .finally(() => {
      pool.end().catch(() => {});
    });
});

app.get('/api/scan/:id', (req, res) => {
  const entry = jobs.get(req.params.id);
  if (!entry) return fail(res, 404, 'Unknown or expired job.', 'not_found');
  res.json(entry.job.toJSON());
});

app.post('/api/scan/:id/cancel', (req, res) => {
  const entry = jobs.get(req.params.id);
  if (!entry) return fail(res, 404, 'Unknown or expired job.', 'not_found');
  entry.job.cancel();
  res.json({ ok: true });
});

app.use((err, _req, res, _next) => {
  const status = err instanceof CloakError ? 502 : 500;
  res.status(status).json({ error: err.message || 'Unexpected error', code: err.code ?? 'unknown' });
});

/**
 * How many columns the scan may touch, or null for "every one of them".
 *
 * 0 is the caller explicitly asking for a whole-database scan, so it is not
 * clamped — the 500 ceiling exists to stop a mistyped number becoming an
 * unbounded bill, not to overrule a deliberate choice. Everything else is
 * clamped, including the garbage that a number input can still produce.
 */
function resolveColumnCap(value) {
  if (value === 0 || value === '0' || value === 'all' || value === null) return null;
  // Number('') is 0, which would otherwise clamp to a 1-column scan rather
  // than falling back to the default.
  if (value === '' || value === undefined) return 60;
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.max(1, Math.min(Math.trunc(n), 500));
}

function clampRows(value) {
  const n = Number(value) || 40;
  return Math.max(5, Math.min(n, 500));
}

/** Turn pg's terse errors into something a demo audience can act on. */
function friendlyPgError(err) {
  const code = err?.code;
  const map = {
    ECONNREFUSED: 'Connection refused — check the host and port, and that Postgres is accepting TCP connections.',
    ENOTFOUND: 'Host not found — check the hostname in the connection details.',
    ETIMEDOUT: 'Connection timed out — the host may be behind a firewall or VPN.',
    '28P01': 'Authentication failed — wrong username or password.',
    '28000': 'Authentication rejected — check pg_hba.conf rules for this user/host.',
    '3D000': 'That database does not exist on the server.',
    '42501': 'Permission denied — the user cannot read the catalog or that table.',
    '57014': 'Query cancelled by the 15s statement timeout.',
  };
  if (map[code]) return map[code];
  if (/self.signed certificate|certificate/i.test(err?.message ?? '')) {
    return 'TLS certificate not trusted — set SSL mode to "Require (skip verification)".';
  }
  if (/SSL/i.test(err?.message ?? '') && /required/i.test(err?.message ?? '')) {
    return 'The server requires SSL — set SSL mode to "Require".';
  }
  return err?.message || 'Could not connect to PostgreSQL.';
}

app.listen(PORT, () => {
  console.log(`\n  CLOAK PII Discovery for PostgreSQL -> http://localhost:${PORT}`);
  console.log('  Enter your CLOAK endpoint and API key in the browser.\n');
});
