/**
 * PostgreSQL connection, introspection and sampling.
 *
 * The scanner is strictly read-only: every session sets
 * `default_transaction_read_only = on` plus a statement timeout, so a demo
 * against a client's database cannot write to it or hang on a huge table.
 */

/** Text-ish types worth scanning. Numeric/boolean/binary columns are skipped. */
const TEXT_DATA_TYPES = ['text', 'character varying', 'character'];
const TEXT_UDT_TYPES = ['citext', 'name'];
const JSON_UDT_TYPES = ['json', 'jsonb'];

const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/**
 * Migration/bookkeeping tables hold no personal data but plenty of text
 * columns, and every column costs a CLOAK request. Skipped by default.
 */
const BOOKKEEPING_TABLES = [
  '_prisma_migrations', 'knex_migrations', 'knex_migrations_lock',
  'schema_migrations', 'ar_internal_metadata', 'flyway_schema_history',
  'alembic_version', 'migrations', 'typeorm_metadata', 'sequelizemeta',
  '__diesel_schema_migrations', 'goose_db_version', 'atlas_schema_revisions',
];

export function buildPgConfig(input = {}) {
  const {
    connectionString,
    host,
    port,
    database,
    user,
    password,
    sslMode = 'auto',
    statementTimeoutMs = 15_000,
    connectionTimeoutMs = 10_000,
  } = input;

  const config = connectionString
    ? { connectionString }
    : {
        host: host || 'localhost',
        port: Number(port) || 5432,
        database: database || undefined,
        user: user || undefined,
        password: password === undefined ? undefined : String(password),
      };

  if (!connectionString && !config.database) {
    throw new Error('Database name is required.');
  }
  if (connectionString && !/^postgres(ql)?:\/\//i.test(connectionString.trim())) {
    throw new Error('Connection string must start with postgres:// or postgresql://');
  }

  config.ssl = resolveSsl(sslMode, connectionString || host || '');
  config.connectionTimeoutMillis = connectionTimeoutMs;
  config.statement_timeout = statementTimeoutMs;
  config.application_name = 'cloak-pii-scanner';
  config.max = 3;
  return config;
}

/**
 * Hosted Postgres (Neon, Supabase, RDS) normally needs TLS but presents a
 * certificate Node won't verify by default, so "require" intentionally skips
 * verification. "verify-full" is available for anyone who needs the real check.
 */
function resolveSsl(sslMode, hint = '') {
  switch (sslMode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
    case 'auto':
    default: {
      const local = /localhost|127\.0\.0\.1|::1|host\.docker\.internal/i.test(hint);
      return local ? false : { rejectUnauthorized: false };
    }
  }
}

/** Quote an SQL identifier: "my table" -> "my table", with internal quotes doubled. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export async function withClient(pool, fn) {
  const client = await pool.connect();
  try {
    // Belt and braces: this session cannot write, and cannot hang forever.
    await client.query('SET default_transaction_read_only = on');
    await client.query("SET statement_timeout = '15s'");
    await client.query("SET idle_in_transaction_session_timeout = '15s'");
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function testConnection(pool) {
  return withClient(pool, async (client) => {
    const { rows } = await client.query(
      'SELECT current_database() AS database, current_user AS "user", version() AS version'
    );
    return rows[0];
  });
}

/**
 * List candidate text columns. Views are excluded by default because sampling a
 * view can be arbitrarily expensive.
 */
export async function listCandidateColumns(
  pool,
  { includeJson = true, includeViews = false, includeBookkeeping = false } = {}
) {
  const udts = includeJson ? [...TEXT_UDT_TYPES, ...JSON_UDT_TYPES] : TEXT_UDT_TYPES;
  const tableTypes = includeViews ? ['BASE TABLE', 'VIEW'] : ['BASE TABLE'];

  const sql = `
    SELECT c.table_schema  AS schema,
           c.table_name    AS table,
           c.column_name   AS column,
           c.data_type     AS "dataType",
           c.udt_name      AS "udtName"
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
     WHERE c.table_schema <> ALL($1)
       AND t.table_type   =  ANY($2)
       AND (c.data_type   =  ANY($3) OR c.udt_name = ANY($4))
       AND lower(c.table_name) <> ALL($5)
     ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

  const skip = includeBookkeeping ? [] : BOOKKEEPING_TABLES;

  return withClient(pool, async (client) => {
    const { rows } = await client.query(sql, [SYSTEM_SCHEMAS, tableTypes, TEXT_DATA_TYPES, udts, skip]);
    return rows;
  });
}

/**
 * On-disk size and estimated row counts, per schema.
 *
 * Read from the catalog (`pg_total_relation_size`, `reltuples`) rather than by
 * counting anything, so it costs the same on a 200GB database as on an empty
 * one — a real `count(*)` across a client's production tables is exactly the
 * kind of query this tool must never run.
 *
 * Two caveats worth knowing when reading the number:
 *  - It includes indexes and TOAST, because that is what the database actually
 *    occupies. It is not the volume of text that gets sampled.
 *  - `reltuples` is a planner estimate maintained by ANALYZE, and is -1 on a
 *    table that has never been analysed (PG14+). Those come back as null rather
 *    than as a confident wrong number.
 *
 * Returns null if the role cannot read the catalog, so a restricted account
 * still gets an inventory instead of a failed inspect.
 */
export async function summariseStorage(pool) {
  const sql = `
    SELECT n.nspname AS schema,
           sum(pg_total_relation_size(c.oid))::bigint AS bytes,
           count(*)::int AS tables,
           sum(CASE WHEN c.reltuples < 0 THEN 0 ELSE c.reltuples END)::bigint AS rows,
           bool_or(c.reltuples < 0) AS "rowsPartial"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = ANY('{r,p,m}')
       AND n.nspname <> ALL($1)
     GROUP BY n.nspname
     ORDER BY n.nspname`;

  try {
    return await withClient(pool, async (client) => {
      const { rows } = await client.query(sql, [SYSTEM_SCHEMAS]);
      const { rows: db } = await client.query(
        'SELECT pg_database_size(current_database())::bigint AS bytes'
      );
      return {
        databaseBytes: Number(db[0]?.bytes ?? 0),
        schemas: rows.map((r) => ({
          schema: r.schema,
          bytes: Number(r.bytes ?? 0),
          tables: Number(r.tables ?? 0),
          rows: Number(r.rows ?? 0),
          rowsPartial: Boolean(r.rowsPartial),
        })),
      };
    });
  } catch {
    return null;
  }
}

/**
 * Sample non-null values from one column.
 *
 * Uses a plain LIMIT rather than ORDER BY random(): on a large table random
 * ordering forces a full scan, which is not something to run against a client's
 * production database during a demo. This means we sample the rows the planner
 * returns first — fine for discovery, and stated plainly in the UI.
 */
export async function sampleColumn(client, { schema, table, column }, limit = 40) {
  const sql = `SELECT ${quoteIdent(column)}::text AS value
                 FROM ${quoteIdent(schema)}.${quoteIdent(table)}
                WHERE ${quoteIdent(column)} IS NOT NULL
                LIMIT $1`;
  const { rows } = await client.query(sql, [limit]);
  return rows
    .map((r) => (r.value === null || r.value === undefined ? '' : String(r.value)))
    .filter((v) => v.trim().length > 0);
}

export async function countRows(client, { schema, table }) {
  const { rows } = await client.query(
    `SELECT reltuples::bigint AS estimate
       FROM pg_class
      WHERE oid = to_regclass($1)`,
    [`${quoteIdent(schema)}.${quoteIdent(table)}`]
  );
  const estimate = Number(rows[0]?.estimate ?? -1);
  return Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
}

/** Never let a password reach a log line or an API response. */
export function redactConnection(input = {}) {
  if (input.connectionString) {
    return {
      kind: 'connectionString',
      value: String(input.connectionString).replace(/:\/\/([^:@/]+):([^@/]*)@/, '://$1:****@'),
    };
  }
  return {
    kind: 'fields',
    value: `${input.user ?? ''}@${input.host ?? ''}:${input.port ?? 5432}/${input.database ?? ''}`,
  };
}
