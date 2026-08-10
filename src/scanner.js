/**
 * Scan orchestration.
 *
 * The expensive resource is CLOAK requests (10/min on the free plan), so the
 * scanner spends exactly ONE request per column: the sampled values are joined
 * into a single blob, and each detected entity is attributed back to the value
 * it came from using its character offsets. Empty columns cost nothing.
 */

import { randomUUID } from 'node:crypto';
import { CloakError } from './cloakClient.js';
import { countRows, sampleColumn, withClient } from './db.js';
import {
  SEVERITY_RANK, groupForType, highestSeverity, isKnownType, isSpecialCategory,
  regulationsForType, severityForType,
} from './entityTypes.js';

const VALUE_SEPARATOR = '\n';
const MAX_VALUE_CHARS = 400;
const MAX_BATCH_CHARS = 15_000;

/** Ceiling on the per-column detection list, so the report JSON stays sane. */
const MAX_DETECTIONS_PER_COLUMN = 250;

/**
 * Join sampled values into one blob, remembering where each one landed.
 * Returns { text, spans } where spans[i] = { index, start, end }.
 */
function buildBatch(values, {
  maxValueChars = MAX_VALUE_CHARS,
  maxBatchChars = MAX_BATCH_CHARS,
  separator = VALUE_SEPARATOR,
} = {}) {
  const spans = [];
  let text = '';

  for (let i = 0; i < values.length; i += 1) {
    let value = String(values[i] ?? '');
    if (!value.trim()) continue;
    if (value.length > maxValueChars) value = value.slice(0, maxValueChars);
    // Newlines inside a value would still be offset-correct, but collapsing them
    // keeps one value on one line, which makes the blob easier to reason about.
    value = value.replace(/\s*\n\s*/g, ' ');

    const prefix = text.length ? separator : '';
    if (text.length + prefix.length + value.length > maxBatchChars) break;

    const start = text.length + prefix.length;
    text += prefix + value;
    spans.push({ index: i, start, end: start + value.length });
  }

  return { text, spans };
}

/** Map each entity back to the sampled value it came from, by offset. */
function attributeEntities(entities, spans) {
  const byValue = new Map();
  const unattributed = [];

  for (const entity of entities) {
    const span = spans.find((s) => entity.start >= s.start && entity.start < s.end);
    if (!span) {
      unattributed.push(entity);
      continue;
    }
    if (!byValue.has(span.index)) byValue.set(span.index, []);
    byValue.get(span.index).push({
      ...entity,
      // Re-base offsets so they are relative to the individual value.
      start: entity.start - span.start,
      end: entity.end - span.start,
    });
  }

  return { byValue, unattributed };
}

/** Replace each detected span in a single value with a [TYPE] marker. */
function redactValue(value, entities) {
  const ordered = [...entities].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const entity of ordered) {
    if (entity.start < cursor) continue;
    out += value.slice(cursor, entity.start) + `[${entity.type}]`;
    cursor = entity.end;
  }
  return out + value.slice(cursor);
}

/**
 * Keep only the entity types the operator asked for.
 *
 * NOTE: CLOAK classifies every type it knows about and returns them all; this
 * filter is applied to the response. Selecting fewer types therefore makes the
 * report narrower, not the API call cheaper. If CLOAK later accepts a
 * per-request type list, send it from build_cloak_request and this stays as a
 * belt-and-braces second pass.
 */
function filterEntities(entities, allowedTypes) {
  if (!allowedTypes || allowedTypes.size === 0) return { kept: entities, suppressed: [], unknown: [] };
  const kept = [];
  const suppressed = [];
  const unknown = [];

  for (const entity of entities) {
    const type = String(entity.type).toUpperCase();
    if (allowedTypes.has(type)) {
      kept.push(entity);
    } else if (!isKnownType(type)) {
      // A type the catalogue has never heard of cannot appear in the picker, so
      // the operator had no way to opt into it. Suppressing it would hide a real
      // finding behind a choice they were never offered - report it instead.
      kept.push(entity);
      unknown.push(type);
    } else {
      suppressed.push(entity);
    }
  }
  return { kept, suppressed, unknown };
}

function columnRef(column) {
  return { schema: column.schema, table: column.table, column: column.column };
}

function summariseColumn({ values, entities, spans, maxExamples = 3 }) {
  const { byValue, unattributed } = attributeEntities(entities, spans);

  const typeCounts = new Map();
  const typeConfidence = new Map();
  const typeValues = new Map();
  const typeSamples = new Map();

  for (const entity of entities) {
    const type = entity.type;
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    if (!typeConfidence.has(type)) typeConfidence.set(type, []);
    typeConfidence.get(type).push(entity.confidence ?? 0);
    if (!typeSamples.has(type)) typeSamples.set(type, new Set());
    if (typeSamples.get(type).size < 8 && entity.text) typeSamples.get(type).add(entity.text);
  }
  for (const [index, found] of byValue) {
    for (const type of new Set(found.map((e) => e.type))) {
      if (!typeValues.has(type)) typeValues.set(type, new Set());
      typeValues.get(type).add(index);
    }
  }

  // Every individual detection, with the sampled value it came from — this is
  // what the report's "all detections" view lists. Examples below stay a short
  // preview of whole values; this is the itemised record.
  const detections = [];
  let detectionsTruncated = false;
  for (const [index, found] of byValue) {
    for (const entity of found) {
      if (detections.length >= MAX_DETECTIONS_PER_COLUMN) { detectionsTruncated = true; break; }
      detections.push({
        type: entity.type,
        text: entity.text,
        confidence: entity.confidence ?? 0,
        value: index,
      });
    }
    if (detectionsTruncated) break;
  }

  const examples = [];
  for (const [index, found] of byValue) {
    if (examples.length >= maxExamples) break;
    const raw = String(values[index] ?? '').slice(0, MAX_VALUE_CHARS).replace(/\s*\n\s*/g, ' ');
    examples.push({
      raw,
      redacted: redactValue(raw, found),
      types: [...new Set(found.map((e) => e.type))],
    });
  }

  const types = [...typeCounts.entries()]
    .map(([type, count]) => {
      const confidences = typeConfidence.get(type) ?? [0];
      return {
        type,
        count,
        severity: severityForType(type),
        group: groupForType(type),
        regulations: regulationsForType(type),
        special: isSpecialCategory(type),
        valuesAffected: typeValues.get(type)?.size ?? 0,
        minConfidence: Math.min(...confidences),
        maxConfidence: Math.max(...confidences),
        avgConfidence: Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) / 1000,
        samples: [...(typeSamples.get(type) ?? [])],
      };
    })
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count);

  const sampled = spans.length;
  const matched = byValue.size;

  return {
    types,
    entityCount: entities.length,
    valuesSampled: sampled,
    valuesWithPii: matched,
    coverage: sampled ? Math.round((matched / sampled) * 100) : 0,
    severity: highestSeverity(types.map((t) => t.type)),
    detections,
    detectionsTruncated,
    regulations: [...new Set(types.flatMap((t) => t.regulations))].sort(),
    hasSpecialCategory: types.some((t) => t.special),
    examples,
    unattributedCount: unattributed.length,
  };
}

export class ScanJob {
  constructor({ scope, redactedTarget }) {
    this.id = randomUUID();
    this.status = 'queued';
    this.phase = 'Queued';
    this.scope = scope;
    this.target = redactedTarget;
    this.progress = { done: 0, total: 0, skipped: 0 };
    this.findings = [];
    this.log = [];
    this.error = null;
    this.requestCount = 0;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.cancelled = false;
    this.waitingUntil = 0;
    this.suppressedCount = 0;
    this.rateLimitHits = 0;
    /** Discovered at runtime from the API - the limit depends on the plan. */
    this.plan = null;
    this.quota = null;
    /** Columns the scan could not classify, so the report can say so explicitly. */
    this.unscanned = [];
    /** Provider labels with no catalogue entry - surfaced, never silently dropped. */
    this.unknownTypes = [];
  }

  logLine(level, message) {
    this.log.push({ at: Date.now(), level, message });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  cancel() {
    this.cancelled = true;
    this.phase = 'Cancelling…';
  }

  toJSON() {
    return {
      id: this.id,
      status: this.status,
      phase: this.phase,
      progress: this.progress,
      findings: this.findings,
      log: this.log.slice(-120),
      error: this.error,
      requestCount: this.requestCount,
      target: this.target,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      waitingUntil: this.waitingUntil,
      suppressedCount: this.suppressedCount,
      rateLimitHits: this.rateLimitHits,
      unscanned: this.unscanned,
      unknownTypes: this.unknownTypes,
      plan: this.plan,
      quota: this.quota,
      summary: this.summary(),
    };
  }

  summary() {
    const withPii = this.findings.filter((f) => f.entityCount > 0);
    const tables = new Set(withPii.map((f) => `${f.schema}.${f.table}`));
    const types = new Map();
    for (const finding of withPii) {
      for (const t of finding.types) types.set(t.type, (types.get(t.type) ?? 0) + t.count);
    }
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of withPii) {
      if (bySeverity[finding.severity] !== undefined) bySeverity[finding.severity] += 1;
    }

    // Where each type appears, so the report can show a type -> location matrix.
    const locations = new Map();
    for (const finding of withPii) {
      for (const t of finding.types) {
        if (!locations.has(t.type)) locations.set(t.type, { columns: [], tables: new Set() });
        locations.get(t.type).columns.push(`${finding.schema}.${finding.table}.${finding.column}`);
        locations.get(t.type).tables.add(`${finding.schema}.${finding.table}`);
      }
    }

    const regulations = new Map();
    for (const finding of withPii) {
      for (const reg of finding.regulations ?? []) {
        if (!regulations.has(reg)) regulations.set(reg, new Set());
        regulations.get(reg).add(`${finding.schema}.${finding.table}.${finding.column}`);
      }
    }

    return {
      columnsScanned: this.progress.done,
      columnsUnscanned: this.unscanned.length,
      columnsWithPii: withPii.length,
      columnsClean: this.findings.length - withPii.length,
      columnsSkipped: this.progress.skipped,
      tablesAffected: tables.size,
      schemasAffected: new Set(withPii.map((f) => f.schema)).size,
      entitiesFound: withPii.reduce((sum, f) => sum + f.entityCount, 0),
      valuesSampled: this.findings.reduce((sum, f) => sum + f.valuesSampled, 0),
      specialCategoryColumns: withPii.filter((f) => f.hasSpecialCategory).length,
      distinctTypes: [...types.entries()]
        .map(([type, count]) => ({
          type,
          count,
          severity: severityForType(type),
          group: groupForType(type),
          regulations: regulationsForType(type),
          special: isSpecialCategory(type),
          columns: locations.get(type)?.columns ?? [],
          tableCount: locations.get(type)?.tables.size ?? 0,
        }))
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count),
      regulations: [...regulations.entries()]
        .map(([name, cols]) => ({ name, columns: cols.size }))
        .sort((a, b) => b.columns - a.columns),
      bySeverity,
    };
  }
}

/**
 * Run the scan. One CLOAK request per non-empty column; empty columns are
 * skipped without spending the request budget.
 */
export async function runScan({ job, pool, cloak, columns, rowsPerColumn, allowedTypes }) {
  job.status = 'running';
  job.progress.total = columns.length;

  // The plan-dependent rate limit is only stated in a 429 body, so the client
  // discovers it at runtime and tells us when it changes.
  job.plan = cloak.plan ?? null;
  if (cloak.onPlanChange !== undefined) {
    cloak.onPlanChange = (plan) => {
      job.plan = plan;
      const perWindow = Math.round(plan.windowMs / 1000);
      job.logLine('warn',
        `Detected plan limit: ${plan.limit} requests/${perWindow}s` +
        (plan.name ? ` on the ${plan.name} plan` : '') +
        ` — pacing adjusted (${plan.source}).`);
    };
  }
  job.logLine('info', `Scanning ${columns.length} text column(s), sampling up to ${rowsPerColumn} value(s) each.`);

  const rowCountCache = new Map();

  try {
    await withClient(pool, async (client) => {
      for (const column of columns) {
        if (job.cancelled) break;

        const label = `${column.schema}.${column.table}.${column.column}`;
        job.phase = `Sampling ${label}`;

        let values = [];
        try {
          values = await sampleColumn(client, column, rowsPerColumn);
        } catch (err) {
          job.logLine('warn', `${label}: could not sample (${err.message})`);
          job.unscanned.push({ ...columnRef(column), reason: `Could not sample: ${err.message}` });
          job.progress.done += 1;
          continue;
        }

        const tableKey = `${column.schema}.${column.table}`;
        if (!rowCountCache.has(tableKey)) {
          try {
            rowCountCache.set(tableKey, await countRows(client, column));
          } catch {
            rowCountCache.set(tableKey, null);
          }
        }

        const { text, spans } = buildBatch(values);
        if (!text) {
          job.progress.done += 1;
          job.progress.skipped += 1;
          job.logLine('muted', `${label}: no non-empty values, skipped (no request used)`);
          continue;
        }

        job.phase = `Classifying ${label}`;
        let result;
        try {
          result = await cloak.detect(text, {
            onWait: (ms, info = {}) => {
              job.waitingUntil = Date.now() + ms;
              const seconds = Math.ceil(ms / 1000);
              if (info.reason === 'rate_limited') {
                job.rateLimitHits += 1;
                job.phase = `Rate limited — retrying ${label} in ${seconds}s (attempt ${info.attempt + 1})`;
                job.logLine('warn', `${label}: rate limited, retrying in ${seconds}s`);
              } else {
                job.phase = `Pacing — next request in ${seconds}s (${label})`;
              }
            },
          });
          job.waitingUntil = 0;
        } catch (err) {
          job.waitingUntil = 0;
          if (err instanceof CloakError && err.code === 'unauthorized') throw err;
          job.logLine('warn', `${label}: ${err.message}`);
          job.unscanned.push({ ...columnRef(column), reason: err.message });
          job.progress.done += 1;
          continue;
        }

        job.requestCount = cloak.requestCount;
        if (cloak.quota) job.quota = cloak.quota;
        if (cloak.plan) job.plan = cloak.plan;

        const { kept, suppressed, unknown } = filterEntities(result.entities, allowedTypes);
        job.suppressedCount += suppressed.length;
        for (const type of unknown) {
          if (!job.unknownTypes.includes(type)) {
            job.unknownTypes.push(type);
            job.logLine('warn', `Unrecognised entity type "${type}" reported as-is (not in the catalogue).`);
          }
        }

        const summary = summariseColumn({ values, entities: kept, spans });
        job.findings.push({
          schema: column.schema,
          table: column.table,
          column: column.column,
          dataType: column.dataType,
          estimatedRows: rowCountCache.get(tableKey),
          processingTimeMs: result.processingTimeMs,
          ...summary,
        });

        job.progress.done += 1;
        if (summary.entityCount > 0) {
          job.logLine(
            'hit',
            `${label}: ${summary.entityCount} entit${summary.entityCount === 1 ? 'y' : 'ies'} ` +
              `across ${summary.valuesWithPii}/${summary.valuesSampled} sampled values ` +
              `(${summary.types.map((t) => t.type).join(', ')})`
          );
        } else {
          job.logLine('muted', `${label}: clean`);
        }
      }
    });

    job.status = job.cancelled ? 'cancelled' : 'done';
    job.phase = job.cancelled ? 'Cancelled' : 'Complete';
  } catch (err) {
    job.status = 'error';
    job.phase = 'Failed';
    job.error = { message: err.message, code: err.code ?? 'scan_failed' };
    job.logLine('error', err.message);
  } finally {
    job.finishedAt = Date.now();
    job.waitingUntil = 0;
  }

  return job;
}
