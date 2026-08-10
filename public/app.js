'use strict';

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  // A whole-database scan is paced in hours, and "214m" is a number nobody
  // reads correctly at a glance.
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Binary units, because that is what Postgres reports and what admins expect. */
function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 1234567 -> "1.2M", for row estimates that would otherwise dominate a card. */
function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${(v / 1e3).toFixed(v < 1e4 ? 1 : 0)}K`;
  if (v < 1e9) return `${(v / 1e6).toFixed(v < 1e7 ? 1 : 0)}M`;
  return `${(v / 1e9).toFixed(1)}B`;
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'none'];
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };

/**
 * Preferences are cached in localStorage so a selection survives a reload.
 *
 * Deliberately excluded: the CLOAK API key, the database password and the
 * connection string (which can embed a password). Nothing secret is ever
 * written to browser storage.
 */
const STORE_KEY = 'cloak-scanner-prefs-v1';
const DEFAULT_PRESET = 'direct';

function loadPrefs() {
  try {
    const raw = window.localStorage?.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;   // private mode, disabled storage, or corrupt JSON
  }
}

function savePrefs() {
  try {
    window.localStorage?.setItem(STORE_KEY, JSON.stringify({
      selectedTypes: [...state.selectedTypes],
      activePreset: state.activePreset,
      rowsPerColumn: $('rows-per-column')?.value,
      maxColumns: $('max-columns')?.value,
      sslMode: $('ssl-mode')?.value,
      includeJson: $('include-json')?.checked,
      includeViews: $('include-views')?.checked,
      scanAll: $('scan-all')?.checked,
      cloakEndpoint: $('cloak-endpoint')?.value,
      cloakAuthMode: $('cloak-auth')?.value,
      cloakProvider: $('cloak-provider')?.value,
      typesExpanded: state.typesExpanded,
    }));
  } catch {
    /* storage unavailable - preferences simply do not persist */
  }
}

const state = {
  config: null,
  catalogue: null,        // { groups, types, presets }
  selectedTypes: new Set(),
  activePreset: DEFAULT_PRESET,
  typesExpanded: false,
  inventory: null,
  selectedSchemas: new Set(),
  jobId: null,
  poll: null,
  job: null,
};

/* ----------------------------------------------------------------- alerts */

function showAlert(kind, title, message) {
  $('alert-slot').innerHTML =
    `<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">
       <div class="alert-body"><strong>${esc(title)}</strong><span>${esc(message)}</span></div>
     </div>`;
}
function clearAlert() { $('alert-slot').innerHTML = ''; }

function setStatus(id, text, kind) {
  const el = $(id);
  el.className = `inline-status${kind ? ` is-${kind}` : ''}`;
  el.innerHTML = kind === 'busy' ? `<span class="spinner"></span>${esc(text)}` : esc(text);
}

/* -------------------------------------------------------------- transport */

async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (HTTP ${res.status})`);
    err.code = body?.code;
    throw err;
  }
  return body;
}

function connectionPayload() {
  const connectionString = $('connection-string').value.trim();
  const sslMode = $('ssl-mode').value;
  if (connectionString) return { connectionString, sslMode };
  return {
    host: $('db-host').value.trim(),
    port: $('db-port').value.trim(),
    database: $('db-name').value.trim(),
    user: $('db-user').value,
    password: $('db-pass').value,
    sslMode,
  };
}

/**
 * Which column sources are eligible. These reach both /api/inspect and
 * /api/scan, and both endpoints build the column list themselves — so the two
 * must be sent the same flags or the inventory you approved is not the
 * inventory that gets scanned.
 */
function sourcePayload() {
  return {
    includeJson: $('include-json').checked,
    includeViews: $('include-views').checked,
  };
}

function cloakPayload() {
  return {
    cloakEndpoint: $('cloak-endpoint').value.trim(),
    cloakApiKey: $('cloak-key').value.trim(),
    cloakAuthMode: $('cloak-auth').value,
    cloakProvider: $('cloak-provider').value,
  };
}

/* --------------------------------------------------------- entity picker */

function renderPresets() {
  $('preset-row').innerHTML = state.catalogue.presets.map((p) =>
    `<button type="button" class="preset${state.activePreset === p.id ? ' is-on' : ''}"
       data-preset="${esc(p.id)}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join('');
}

function renderTypePicker() {
  const q = $('type-filter').value.trim().toLowerCase();
  const { groups, types } = state.catalogue;

  const html = groups.map((group) => {
    const inGroup = types.filter((t) => t.group === group.id);
    const visible = q
      ? inGroup.filter((t) => t.id.toLowerCase().includes(q) || t.label.toLowerCase().includes(q))
      : inGroup;
    if (!visible.length) return '';

    const on = inGroup.filter((t) => state.selectedTypes.has(t.id)).length;
    return `<div class="type-group">
      <div class="type-group-head" data-group="${esc(group.id)}" role="button" tabindex="0"
           title="Toggle the whole group">
        <span class="type-group-name">${esc(group.label)}</span>
        <span class="type-group-count">${on}/${inGroup.length}</span>
      </div>
      <div class="type-list">
        ${visible.map((t) => `
          <label class="type-item" title="${esc(t.label)}${t.regulations.length ? ' · ' + t.regulations.join(', ') : ''}">
            <input type="checkbox" data-type="${esc(t.id)}" ${state.selectedTypes.has(t.id) ? 'checked' : ''} />
            <span class="type-item-name">${esc(t.id)}</span>
            ${t.special ? '<span class="special-mark" title="GDPR Article 9 special category">ART9</span>' : ''}
            <span class="sev-dot d-${esc(t.severity)}" title="${esc(t.severity)}"></span>
          </label>`).join('')}
      </div>
    </div>`;
  }).join('');

  $('type-groups').innerHTML = html || '<div class="empty-state"><strong>No entity types match</strong></div>';
  updatePickerCount();
}

function updatePickerCount() {
  const total = state.catalogue.types.length;
  const n = state.selectedTypes.size;
  $('picker-count').innerHTML = `<strong>${n}</strong> of ${total} entity types selected`;
  updateProfileSummary();
}

/** The one-line description shown while the profile panel is collapsed. */
function updateProfileSummary() {
  const el = $('types-summary');
  if (!el || !state.catalogue) return;
  const total = state.catalogue.types.length;
  const n = state.selectedTypes.size;
  const preset = state.catalogue.presets.find((p) => p.id === state.activePreset);

  el.innerHTML = `<span class="profile-summary">
    <span class="profile-chip${preset ? '' : ' is-custom'}">${esc(preset ? preset.label : 'Custom')}</span>
    <span><strong>${n}</strong> of ${total} entity types will be reported</span>
  </span>`;
}

function setTypesExpanded(expanded) {
  state.typesExpanded = expanded;
  $('types-body').classList.toggle('is-collapsed', !expanded);
  $('btn-toggle-types').setAttribute('aria-expanded', String(expanded));
  $('toggle-types-label').textContent = expanded ? 'Done' : 'Customise';
  $('btn-select-all').classList.toggle('is-hidden', !expanded);
  $('btn-select-none').classList.toggle('is-hidden', !expanded);
  savePrefs();
}

function applyPreset(id) {
  const preset = state.catalogue.presets.find((p) => p.id === id);
  if (!preset) return;
  state.activePreset = id;
  state.selectedTypes = new Set(preset.types);
  renderPresets();
  renderTypePicker();
  updateBudget();
  savePrefs();
}

function markCustomPreset() {
  const match = state.catalogue.presets.find((p) =>
    p.types.length === state.selectedTypes.size && p.types.every((t) => state.selectedTypes.has(t)));
  state.activePreset = match ? match.id : null;
  renderPresets();
  updateProfileSummary();
  savePrefs();
}

/**
 * Point the endpoint and auth header at the selected provider.
 *
 * The endpoint is replaced when it is blank, when it is another provider's
 * default, or when it is the same host with a different path — that last case
 * is the one that matters: a half-remembered base URL missing its path is not a
 * working endpoint, and silently leaving it there produces a confusing 400
 * several minutes into a scan.
 */
function applyProviderDefaults(providers, { keepEndpoint = false } = {}) {
  const p = providers.find((x) => x.id === $('cloak-provider').value);
  if (!p) return;

  const el = $('cloak-endpoint');
  el.placeholder = p.endpointHint ?? '';

  if (!keepEndpoint && p.endpointHint) {
    const current = el.value.trim();
    const knownDefault = providers.some((x) => x.endpointHint === current);
    if (!current || knownDefault || sameHost(current, p.endpointHint)) {
      el.value = p.endpointHint;
    }
    if (p.defaultAuthMode) $('cloak-auth').value = p.defaultAuthMode;
  }

  warnOnEndpointMismatch(providers);
  savePrefs();
}

/**
 * Choose a select value that actually exists as an option.
 *
 * A cached preference outlives the option it names: remove a provider and the
 * stored id points at nothing, which sets the select to "" and renders it blank
 * rather than falling back. Anything unrecognised is discarded here.
 */
function pickOption(options, preferred, fallback) {
  const has = (id) => id && options.some((o) => o.id === id);
  if (has(preferred)) return preferred;
  if (has(fallback)) return fallback;
  return options[0].id;
}

function sameHost(a, b) {
  try { return new URL(a).host === new URL(b).host; } catch { return false; }
}

/** Flag "right host, wrong path" before it costs a scan. */
function warnOnEndpointMismatch(providers) {
  const p = providers.find((x) => x.id === $('cloak-provider').value);
  const current = $('cloak-endpoint').value.trim();
  const hint = p?.endpointHint;
  const el = $('endpoint-warning');
  if (!el) return;

  if (hint && current && sameHost(current, hint) && !current.replace(/\/+$/, '').endsWith(pathOf(hint))) {
    el.innerHTML = `<span class="inline-status is-error">Expected path <span class="mono">${esc(pathOf(hint))}</span>
      — current URL looks incomplete.</span>`;
  } else {
    el.innerHTML = '';
  }
}

function pathOf(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

/** Prove the endpoint, key and auth header before spending a whole scan. */
async function testApi() {
  const cloak = cloakPayload();
  if (!cloak.cloakEndpoint || !cloak.cloakApiKey) {
    setStatus('test-api-status', 'Enter the endpoint and key first.', 'error');
    return;
  }

  $('btn-test-api').disabled = true;
  setStatus('test-api-status', 'Calling the API…', 'busy');
  try {
    const r = await api('/api/test-cloak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cloak),
    });
    const detail = r.types.length ? ` (${r.types.slice(0, 4).join(', ')})` : '';
    setStatus('test-api-status',
      `Works — ${plural(r.entities, 'entity', 'entities')} detected in ${r.processingTimeMs}ms${detail}`,
      'ok');
    // Zero entities on a sample that plainly contains a name, phone and email
    // means the response shape is not being read correctly - show the body.
    if (r.entities === 0 && r.raw) {
      showAlert('warn', 'Connected, but nothing was detected',
        `The API answered without flagging the test sample, so the response shape may not match. `
        + `Raw response: ${r.raw}`);
    } else {
      clearAlert();
    }
  } catch (err) {
    setStatus('test-api-status', '', '');
    showAlert('error', 'API test failed', explainApiError(err));
  } finally {
    $('btn-test-api').disabled = false;
  }
}

/** Turn the vaguer gateway errors into something actionable. */
function explainApiError(err) {
  const msg = err.message ?? String(err);
  if (/missing authentication token/i.test(msg)) {
    return `${msg} — despite the wording this usually means the URL path does not exist, ` +
      'not that the key is missing. Check the endpoint has its final path segment ' +
      '(e.g. /detect) rather than just the base URL.';
  }
  if (/not authorized|explicit deny/i.test(msg)) {
    return `${msg} — the path exists but the key was rejected. Check the key itself and the ` +
      'auth header mode.';
  }
  return msg;
}

/* ------------------------------------------------------- step 1: inspect */

async function inspect() {
  clearAlert();
  const conn = connectionPayload();
  if (!conn.connectionString && !conn.database) {
    setStatus('inspect-status', 'Enter a connection string, or host + database.', 'error');
    return;
  }

  $('btn-inspect').disabled = true;
  setStatus('inspect-status', 'Connecting…', 'busy');

  try {
    const data = await api('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: conn, ...sourcePayload() }),
    });

    state.inventory = data;
    state.selectedSchemas = new Set(data.schemas);
    setStatus('inspect-status', `Connected to ${data.server.database} as ${data.server.user}`, 'ok');
    $('panel-connect').classList.add('is-done');
    $('header-meta').innerHTML =
      `<span>${esc(data.server.version)}</span><span class="dot"></span><span>${esc(data.target.value)}</span>`;

    renderScope();
    $('panel-types').classList.remove('is-hidden');
    $('panel-scope').classList.remove('is-hidden');
    $('panel-types').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    setStatus('inspect-status', '', '');
    showAlert('error', 'Could not connect', err.message);
  } finally {
    $('btn-inspect').disabled = false;
  }
}

/* --------------------------------------------------------- step 3: scope */

function renderScope() {
  const inv = state.inventory;
  $('scope-sub').textContent =
    `${plural(inv.totals.columns, 'text column', 'text columns')} across ` +
    `${plural(inv.totals.tables, 'table', 'tables')} in ` +
    `${plural(inv.totals.schemas, 'schema', 'schemas')}` +
    (inv.storage ? ` · ${fmtBytes(inv.storage.databaseBytes)} on disk.` : '.');

  const size = storageForSelection();
  $('inventory-stats').innerHTML = [
    stat(inv.totals.schemas, 'Schemas'),
    stat(inv.totals.tables, 'Tables'),
    stat(inv.totals.columns, 'Text columns', 'is-brand'),
    // Only offered when the catalog was readable; a restricted role still gets
    // the rest of the inventory rather than a card reading "—".
    size ? stat(fmtBytes(size.bytes), 'Data size', '', size.note) : '',
    size && size.rows ? stat(fmtCount(size.rows), 'Rows (est.)', '',
      size.rowsPartial ? 'Some tables never analysed' : 'From planner statistics') : '',
  ].join('');

  $('schema-select').innerHTML = inv.schemas.map((s) => {
    const count = inv.columns.filter((c) => c.schema === s).length;
    return `<button type="button" class="preset${state.selectedSchemas.has(s) ? ' is-on' : ''}"
              data-schema="${esc(s)}">${esc(s)} · ${count}</button>`;
  }).join('');

  updateBudget();
}

function stat(value, label, cls = '', note = '') {
  return `<div class="stat ${cls}"><div class="stat-value">${esc(value)}</div>
          <div class="stat-label">${esc(label)}</div>
          ${note ? `<div class="stat-note">${esc(note)}</div>` : ''}</div>`;
}

/**
 * On-disk size for the schemas currently in scope.
 *
 * Storage is reported per schema by the server, and scope is chosen per schema,
 * so the card follows the selection rather than always showing the whole
 * database — otherwise picking one schema out of six would leave a size that
 * has nothing to do with what is about to be scanned.
 */
function storageForSelection() {
  const storage = state.inventory?.storage;
  if (!storage) return null;

  // "All" is about coverage, not about how it was chosen: selecting every
  // schema by hand is the same scope as ticking Entire database, and must not
  // produce a note comparing the total against itself.
  const inScope = isFullScan() || !state.selectedSchemas.size
    ? storage.schemas
    : storage.schemas.filter((s) => state.selectedSchemas.has(s.schema));
  const all = inScope.length === storage.schemas.length;

  const bytes = inScope.reduce((sum, s) => sum + s.bytes, 0);
  const rows = inScope.reduce((sum, s) => sum + s.rows, 0);

  return {
    bytes,
    rows,
    rowsPartial: inScope.some((s) => s.rowsPartial),
    // Tables and indexes on disk - not the volume of text the scan reads, which
    // is far smaller. pg_database_size covers system catalogs too, so it is
    // normally a little larger than the sum of user schemas.
    note: all
      ? `Tables and indexes${storage.databaseBytes > bytes
          ? ` · ${fmtBytes(storage.databaseBytes)} with catalogs` : ''}`
      : `of ${fmtBytes(storage.schemas.reduce((t, s) => t + s.bytes, 0))} in all schemas`,
  };
}

const isFullScan = () => Boolean($('scan-all')?.checked);

/**
 * A full scan means every schema and no column cap, so it takes over the two
 * controls that would otherwise narrow it. They are disabled rather than
 * hidden — the operator can still see the values they will go back to.
 */
function applyFullScanMode() {
  const full = isFullScan();
  const inv = state.inventory;

  $('max-columns').disabled = full;
  $('schema-select').classList.toggle('is-locked', full);

  if (full && inv) state.selectedSchemas = new Set(inv.schemas);
  if (inv) renderScope();
  else updateBudget();
  savePrefs();
}

function selectedColumnCount() {
  const inv = state.inventory;
  if (!inv) return 0;
  if (isFullScan()) return inv.columns.length;
  const inScope = inv.columns.filter((c) => state.selectedSchemas.has(c.schema));
  return Math.min(inScope.length, Number($('max-columns').value) || 60);
}

function updateBudget() {
  const cfg = state.config ?? { rateLimit: 10, rateWindowMs: 60000 };
  const n = selectedColumnCount();
  const perWindow = cfg.rateLimit;
  const windowS = Math.round(cfg.rateWindowMs / 1000);
  // Requests are paced windowMs/limit apart (6s at 10/min), so the estimate is
  // spacing-driven rather than "a burst then a stall".
  const spacing = perWindow > 0 ? cfg.rateWindowMs / perWindow / 1000 : 0;
  const seconds = n > 0 ? (n - 1) * spacing + 2 : 0;
  const typeCount = state.selectedTypes.size;
  const totalTypes = state.catalogue?.types.length ?? 0;

  // A whole-database scan is the one case where the estimate is the warning:
  // at 6s per column an unbounded scope can run for hours, and that is much
  // better learned here than forty minutes in.
  const full = isFullScan();
  $('budget').classList.toggle('is-warn', full && seconds > 1800);

  $('budget').innerHTML =
    `<svg class="icon" viewBox="0 0 24 24"><path d="M13 2L4 13.5h7L10 22l9-11.5h-7z"/></svg>
     <span>${full ? '<strong>Entire database</strong> — ' : ''}<strong>${plural(n, 'column', 'columns')}</strong> in scope — at most
     <strong>${plural(n, 'CLOAK request', 'CLOAK requests')}</strong> (one per column;
     empty columns are skipped for free). At ${perWindow} requests / ${windowS}s that is roughly
     <strong>${fmtDuration(seconds * 1000)}</strong> — requests are paced evenly, and the
     scanner adopts your real plan limit if the API reports a different one. Reporting
     <strong>${typeCount}</strong> of ${totalTypes} entity types.</span>`;
}

/* ---------------------------------------------------------- step 4: scan */

async function startScan() {
  clearAlert();
  const cloak = cloakPayload();
  if (!cloak.cloakEndpoint) {
    setStatus('scan-status', 'API endpoint is required.', 'error'); return;
  }
  if (!cloak.cloakApiKey) {
    setStatus('scan-status', 'API key is required.', 'error'); return;
  }
  if (state.selectedTypes.size === 0) {
    setStatus('scan-status', 'Select at least one entity type to report.', 'error'); return;
  }

  $('btn-scan').disabled = true;
  setStatus('scan-status', 'Starting…', 'busy');

  try {
    const { jobId } = await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection: connectionPayload(),
        ...cloak,
        // An empty schema list and a 0 cap both mean "no restriction" to the
        // server, which is exactly what a full-database scan asks for.
        schemas: isFullScan() ? [] : [...state.selectedSchemas],
        entityTypes: [...state.selectedTypes],
        rowsPerColumn: Number($('rows-per-column').value) || 40,
        maxColumns: isFullScan() ? 0 : Number($('max-columns').value) || 60,
        ...sourcePayload(),
      }),
    });

    state.jobId = jobId;
    window.Favicon?.setProgress(0);
    window.Favicon?.scanning();
    setStatus('scan-status', '', '');
    $('panel-progress').classList.remove('is-hidden');
    $('btn-cancel').classList.remove('is-hidden');
    $('panel-results').classList.add('is-hidden');
    $('panel-progress').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    poll();
  } catch (err) {
    setStatus('scan-status', '', '');
    window.Favicon?.idle();
    showAlert('error', 'Could not start the scan', err.message);
    $('btn-scan').disabled = false;
  }
}

function poll() {
  clearInterval(state.poll);
  state.poll = setInterval(refreshJob, 1000);
  refreshJob();
}

async function refreshJob() {
  if (!state.jobId) return;
  try {
    const job = await api(`/api/scan/${state.jobId}`);
    state.job = job;
    renderProgress(job);

    if (['done', 'error', 'cancelled'].includes(job.status)) {
      clearInterval(state.poll);
      state.poll = null;
      window.Favicon?.idle();
      setDocTitle(null);
      $('btn-scan').disabled = false;
      $('btn-cancel').classList.add('is-hidden');
      $('panel-progress').classList.add('is-done');
      renderReport(job);
      if (job.status === 'error') showAlert('error', 'Scan failed', job.error?.message ?? 'Unknown error');
      else if (job.status === 'cancelled') showAlert('warn', 'Scan cancelled', 'Partial results are shown below.');
    }
  } catch (err) {
    clearInterval(state.poll);
    state.poll = null;
    window.Favicon?.idle();
    setDocTitle(null);
    $('btn-scan').disabled = false;
    showAlert('error', 'Lost track of the scan', err.message);
  }
}

/** A long scan usually runs in a background tab; keep the tab itself informative. */
const BASE_TITLE = 'CLOAK — PII Discovery for PostgreSQL';
function setDocTitle(percent) {
  document.title = percent === null || percent === undefined
    ? BASE_TITLE
    : `(${percent}%) Scanning — CLOAK Discovery`;
}

function renderProgress(job) {
  const { done, total, skipped } = job.progress;
  const fraction = total ? done / total : 0;
  window.Favicon?.setProgress(fraction);
  if (job.status === 'running' || job.status === 'queued') {
    setDocTitle(Math.round(fraction * 100));
  }
  $('progress-bar').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $('progress-phase').textContent = job.phase;

  const waiting = job.waitingUntil && job.waitingUntil > Date.now()
    ? `<span>Rate limit <strong>${Math.ceil((job.waitingUntil - Date.now()) / 1000)}s</strong></span>` : '';

  $('progress-meta').innerHTML =
    `<span><strong>${done}</strong> / ${total} columns</span>
     <span>Requests <strong>${job.requestCount}</strong></span>
     <span>Skipped <strong>${skipped}</strong></span>
     <span>Elapsed <strong>${fmtDuration((job.finishedAt ?? Date.now()) - job.startedAt)}</strong></span>
     ${waiting}`;

  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = job.log.map((l) =>
    `<span class="log-line log-${esc(l.level)}">${esc(l.message)}</span>`).join('');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

async function cancelScan() {
  if (!state.jobId) return;
  $('btn-cancel').disabled = true;
  try { await api(`/api/scan/${state.jobId}/cancel`, { method: 'POST' }); }
  catch { /* the poll surfaces it */ }
  finally { $('btn-cancel').disabled = false; }
}

/* ------------------------------------------------------- step 5: report */

function renderReport(job) {
  $('panel-results').classList.remove('is-hidden');
  const s = job.summary;

  $('report-sub').textContent =
    `${job.target?.value ?? ''} — ${plural(s.columnsScanned, 'column', 'columns')} scanned, ` +
    `${plural(s.entitiesFound, 'entity', 'entities')} classified.`;

  $('report').innerHTML = [
    sectionSummary(job, s),
    sectionSeverity(s),
    sectionTypes(s),
    sectionRegulations(s),
    sectionFindings(),
    sectionMethod(job),
  ].join('');

  bindReportControls();
}

/* --- 1. executive summary ------------------------------------------------ */

function sectionSummary(job, s) {
  return `<div class="report-section">
    <div class="report-title"><span class="n">1</span>Executive summary</div>
    <div class="stat-row">
      ${stat(s.columnsScanned, 'Columns scanned')}
      ${stat(s.columnsWithPii, 'Columns with PII', s.columnsWithPii ? 'is-critical' : 'is-ok')}
      ${stat(s.tablesAffected, 'Tables affected')}
      ${stat(s.entitiesFound, 'Entities found', 'is-brand')}
      ${stat(s.distinctTypes.length, 'Distinct types')}
      ${stat(s.specialCategoryColumns, 'Art. 9 columns', s.specialCategoryColumns ? 'is-critical' : '')}
    </div>
    ${renderUnscanned(job)}
    <p class="report-note">
      ${s.columnsWithPii
        ? `<strong>${pct(s.columnsWithPii, s.columnsScanned)}%</strong> of scanned columns contain personal data.
           ${s.columnsClean} clean, ${s.columnsSkipped} skipped as empty.
           ${plural(s.valuesSampled, 'value', 'values')} sampled in total across ${plural(job.requestCount, 'CLOAK request', 'CLOAK requests')}.`
        : 'No personal data was detected in any sampled value.'}
    </p>
  </div>`;
}

/** Columns the scan could not classify. Stated plainly - a gap is not a clean bill. */
function renderUnscanned(job) {
  const rows = job.unscanned ?? [];
  if (!rows.length) return '';
  return `<div class="alert alert-warn" style="margin-top:4px">
    <div class="alert-body">
      <strong>${plural(rows.length, 'column was', 'columns were')} not classified</strong>
      <span>These were skipped because of an error, so their contents are unknown — they are
        <em>not</em> confirmed clean. Re-run the scan to cover them.</span>
      <ul style="margin:6px 0 0; padding-left:18px">
        ${rows.slice(0, 12).map((r) => `<li><span class="mono">${esc(r.schema)}.${esc(r.table)}.${esc(r.column)}</span>
          — ${esc(r.reason)}</li>`).join('')}
        ${rows.length > 12 ? `<li>…and ${rows.length - 12} more</li>` : ''}
      </ul>
    </div>
  </div>`;
}

/* --- 2. severity --------------------------------------------------------- */

function sectionSeverity(s) {
  const total = Object.values(s.bySeverity).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const bar = SEV_ORDER.filter((k) => s.bySeverity[k]).map((k) =>
    `<span class="s-${k}" style="width:${pct(s.bySeverity[k], total)}%" title="${k}: ${s.bySeverity[k]}"></span>`).join('');
  const legend = SEV_ORDER.filter((k) => s.bySeverity[k]).map((k) =>
    `<span class="key"><span class="swatch" style="background:var(--${k})"></span>
      ${k} · <strong>${s.bySeverity[k]}</strong></span>`).join('');

  return `<div class="report-section">
    <div class="report-title"><span class="n">2</span>Risk distribution</div>
    <div class="sev-bar">${bar}</div>
    <div class="sev-legend">${legend}</div>
    <p class="report-note">Each column takes the severity of the most sensitive entity type found in it.</p>
  </div>`;
}

/* --- 3. entity type breakdown ------------------------------------------- */

function sectionTypes(s) {
  if (!s.distinctTypes.length) return '';
  const max = Math.max(...s.distinctTypes.map((t) => t.count));

  const rows = s.distinctTypes.map((t) => `<tr>
    <td><span class="mono"><strong>${esc(t.type)}</strong></span>
        ${t.special ? '<span class="special-tag">ART9</span>' : ''}</td>
    <td><span class="sev sev-${esc(t.severity)}">${esc(t.severity)}</span></td>
    <td class="num">${t.count}</td>
    <td class="num">${t.tableCount}</td>
    <td class="num">${t.columns.length}</td>
    <td><div class="bar-cell"><div class="bar-track">
      <div class="bar-fill" style="width:${pct(t.count, max)}%"></div></div></div></td>
    <td>${t.regulations.map((r) => `<span class="reg-tag">${esc(r)}</span>`).join(' ')}</td>
  </tr>`).join('');

  return `<div class="report-section">
    <div class="report-title"><span class="n">3</span>Entity types identified
      <span class="report-note">(${s.distinctTypes.length})</span></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr>
        <th>Entity type</th><th>Severity</th><th class="num">Count</th>
        <th class="num">Tables</th><th class="num">Columns</th><th>Share</th><th>Regulations</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/* --- 4. regulatory exposure ---------------------------------------------- */

function sectionRegulations(s) {
  if (!s.regulations?.length) return '';
  const chips = s.regulations.map((r) => `<div class="stat">
    <div class="stat-value">${r.columns}</div>
    <div class="stat-label">${esc(r.name)} columns</div></div>`).join('');

  return `<div class="report-section">
    <div class="report-title"><span class="n">4</span>Regulatory exposure</div>
    <div class="stat-row">${chips}</div>
    <p class="report-note">Columns holding at least one entity type associated with each regime.
      Indicative mapping for triage — not a compliance assessment.</p>
  </div>`;
}

/* --- 5. detailed findings ------------------------------------------------ */

function sectionFindings() {
  return `<div class="report-section">
    <div class="report-title"><span class="n">5</span>Detailed findings</div>
    <div class="toolbar">
      <input class="input input-search" id="filter" type="search"
             placeholder="Filter by table, column or entity type…" />
      <label class="switch"><input type="checkbox" id="show-clean" /> Show clean columns</label>
      <label class="switch"><input type="checkbox" id="reveal" /> Reveal raw values</label>
    </div>
    <div id="findings"></div>
  </div>`;
}

function renderFindings() {
  const job = state.job;
  if (!job || !$('findings')) return;
  const showClean = $('show-clean')?.checked;
  const reveal = $('reveal')?.checked;
  const q = ($('filter')?.value ?? '').trim().toLowerCase();

  let rows = job.findings.filter((f) => showClean || f.entityCount > 0);
  if (q) {
    rows = rows.filter((f) =>
      `${f.schema}.${f.table}.${f.column}`.toLowerCase().includes(q) ||
      f.types.some((t) => t.type.toLowerCase().includes(q)));
  }

  if (!rows.length) {
    $('findings').innerHTML = `<div class="empty-state">
      <strong>${job.findings.length ? 'Nothing matches that filter' : 'No personal data found'}</strong>
      <span>${job.findings.length
        ? 'Try a different table, column or entity type.'
        : 'None of the sampled values were classified as a selected entity type.'}</span></div>`;
    return;
  }

  const groups = new Map();
  for (const f of rows) {
    const key = `${f.schema}.${f.table}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    const best = (g) => Math.min(...g.map((f) => SEV_RANK[f.severity] ?? 4));
    return best(a[1]) - best(b[1]) || a[0].localeCompare(b[0]);
  });

  $('findings').innerHTML = ordered.map(([table, items]) => {
    const worst = items.reduce((acc, f) => (SEV_RANK[f.severity] < SEV_RANK[acc] ? f.severity : acc), 'none');
    const entities = items.reduce((sum, f) => sum + f.entityCount, 0);
    const est = items[0].estimatedRows;
    items.sort((a, b) => (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4) || b.entityCount - a.entityCount);

    return `<div class="table-group">
      <div class="table-group-head">
        <span class="sev sev-${esc(worst)}">${esc(worst)}</span>
        <span class="table-group-name">${esc(table)}</span>
        <span class="table-group-meta">${plural(items.length, 'column', 'columns')} ·
          ${plural(entities, 'entity', 'entities')}${est !== null && est !== undefined
            ? ` · ~${Number(est).toLocaleString()} rows` : ''}</span>
      </div>
      ${items.map((f) => renderFinding(f, reveal)).join('')}
    </div>`;
  }).join('');
}

function renderFinding(f, reveal) {
  const detail = f.types.length ? `<div class="type-detail">
    <div class="type-detail-row is-head">
      <span>Entity type</span><span>Count</span><span>Values</span><span>Confidence</span><span>Examples</span>
    </div>
    ${f.types.map((t) => `<div class="type-detail-row">
      <span class="t-name">
        <span class="sev-dot d-${esc(t.severity)}"></span>${esc(t.type)}
        ${t.special ? '<span class="special-tag">ART9</span>' : ''}
      </span>
      <span class="num">${t.count}</span>
      <span class="num">${t.valuesAffected}</span>
      <span class="t-conf num">${confidenceLabel(t)}</span>
      <span class="t-samples">${reveal
        ? esc((t.samples ?? []).join(' · '))
        : (t.samples ?? []).map((v) => esc(maskValue(v))).join(' · ')}</span>
    </div>`).join('')}
  </div>` : '';

  const samples = f.examples.map((ex) => reveal
    ? `<div class="sample is-raw">${esc(ex.raw)}</div>`
    : `<div class="sample">${tokenize(ex.redacted)}</div>`).join('');

  const all = renderAllDetections(f, reveal);

  return `<div class="finding${f.entityCount ? '' : ' is-clean'}">
    <div class="finding-head">
      <span class="sev sev-${esc(f.severity)}">${esc(f.severity)}</span>
      <span class="finding-col">${esc(f.column)}</span>
      <span class="finding-type">${esc(f.dataType)}</span>
      ${(f.regulations ?? []).map((r) => `<span class="reg-tag">${esc(r)}</span>`).join(' ')}
      <span class="finding-stats">
        <span><strong>${f.valuesWithPii}</strong>/${f.valuesSampled} values</span>
        <span><strong>${f.coverage}%</strong> hit rate</span>
        ${(f.detections ?? []).length
          ? `<button type="button" class="count-toggle" data-detections
               title="Show every detection in this column"><strong>${f.entityCount}</strong> entities</button>`
          : `<span><strong>${f.entityCount}</strong> entities</span>`}
      </span>
    </div>
    ${detail}
    ${samples ? `<div class="samples">${samples}</div>` : ''}
    ${all}
  </div>`;
}

/**
 * Every individual detection in the column, not just a preview.
 *
 * Collapsed by default so a wide report stays readable, and masked unless
 * "Reveal raw values" is on — the point of the tool is to find personal data,
 * not to spray it across the screen by default.
 */
function renderAllDetections(f, reveal) {
  const rows = f.detections ?? [];
  if (!rows.length) return '';

  const body = rows.map((d, i) => `<tr>
    <td class="num">${i + 1}</td>
    <td><span class="sev-dot d-${esc(severityOf(f, d.type))}"></span>
        <span class="mono">${esc(d.type)}</span></td>
    <td class="detect-value">${reveal ? esc(d.text) : esc(maskValue(d.text))}</td>
    <td class="num">${Math.round((d.confidence ?? 0) * 100)}%</td>
    <td class="num">${d.value + 1}</td>
  </tr>`).join('');

  return `<details class="detections" data-detections-panel>
    <summary>All ${plural(rows.length, 'detection', 'detections')}${
      f.detectionsTruncated ? ' (first 250)' : ''}${reveal ? '' : ' — masked'}</summary>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th class="num">#</th><th>Type</th><th>Value</th>
          <th class="num">Confidence</th><th class="num">Row</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </details>`;
}

/** Severity of a type within this finding, for the colour dot. */
function severityOf(f, type) {
  return f.types.find((t) => t.type === type)?.severity ?? 'medium';
}

/** j••••@e•••••.com — enough to recognise a value without exposing it. */
function maskValue(value) {
  const s = String(value ?? '');
  if (s.length <= 2) return '••';
  return s.replace(/[^\s@._+-]/g, (ch, i) => (i === 0 || i === s.length - 1 ? ch : '•'));
}

function confidenceLabel(t) {
  if (t.minConfidence === undefined) return '—';
  const min = Math.round(t.minConfidence * 100);
  const max = Math.round(t.maxConfidence * 100);
  return min === max ? `${max}%` : `${min}–${max}%`;
}

function tokenize(text) {
  return esc(text).replace(/\[([A-Z0-9_/]+)\]/g, (m) => `<span class="token">${m}</span>`);
}

/* --- 6. method ----------------------------------------------------------- */

function sectionMethod(job) {
  const scope = job.scope ?? {};
  const types = scope.allEntityTypes
    ? `all ${scope.entityTypes?.length ?? 0} entity types`
    : `${scope.entityTypes?.length ?? 0} selected entity types`;

  return `<div class="report-section">
    <div class="report-title"><span class="n">6</span>Method &amp; caveats</div>
    <div class="table-wrap"><table class="data-table"><tbody>
      <tr><th>Target</th><td class="mono">${esc(job.target?.value ?? '')}</td></tr>
      <tr><th>Schemas</th><td>${esc((scope.schemas ?? []).join(', ') || 'all')}</td></tr>
      <tr><th>Detection profile</th><td>${esc(types)}</td></tr>
      <tr><th>Sampling</th><td>Up to ${esc(scope.rowsPerColumn ?? 40)} non-null values per column,
        taken with a plain <code>LIMIT</code> (not random sampling)</td></tr>
      <tr><th>CLOAK requests</th><td>${job.requestCount} — one per non-empty column</td></tr>
      <tr><th>Suppressed</th><td>${job.suppressedCount ?? 0} detections outside the selected profile</td></tr>
      <tr><th>Rate-limit waits</th><td>${job.rateLimitHits ?? 0} — requests are paced to stay inside the plan quota</td></tr>
      <tr><th>Not classified</th><td>${(job.unscanned ?? []).length} column(s)</td></tr>
      <tr><th>Duration</th><td>${fmtDuration((job.finishedAt ?? Date.now()) - job.startedAt)}</td></tr>
      <tr><th>Access</th><td>Read-only session, 15s statement timeout</td></tr>
    </tbody></table></div>
    <p class="report-note">
      Sampling uses <code>LIMIT</code> rather than <code>ORDER BY random()</code>, because random
      ordering forces a full table scan. Findings are therefore evidence of presence, not proof of
      absence — a column can hold personal data in rows the sample never read. Row counts are
      PostgreSQL <code>reltuples</code> estimates.
    </p>
  </div>`;
}

function bindReportControls() {
  $('filter')?.addEventListener('input', renderFindings);
  $('show-clean')?.addEventListener('change', renderFindings);
  $('reveal')?.addEventListener('change', renderFindings);

  // The entity count doubles as the disclosure control - it is the number
  // people reach for when they want to see what was actually found.
  $('findings')?.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-detections]');
    if (!trigger) return;
    const panel = trigger.closest('.finding')?.querySelector('[data-detections-panel]');
    if (!panel) return;
    panel.open = !panel.open;
    if (panel.open) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  renderFindings();
}

/* ----------------------------------------------------------------- export */

function download(name, mime, content) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  if (!state.job) return;
  download('cloak-pii-report.json', 'application/json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    target: state.job.target,
    scope: state.job.scope,
    summary: state.job.summary,
    findings: state.job.findings,
  }, null, 2));
}

function exportCsv() {
  if (!state.job) return;
  const head = ['schema', 'table', 'column', 'data_type', 'severity', 'special_category',
    'regulations', 'values_sampled', 'values_with_pii', 'coverage_pct', 'entity_count', 'entity_types'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(cell).join(',')];
  for (const f of state.job.findings) {
    lines.push([f.schema, f.table, f.column, f.dataType, f.severity,
      f.hasSpecialCategory ? 'yes' : 'no', (f.regulations ?? []).join(' '),
      f.valuesSampled, f.valuesWithPii, f.coverage, f.entityCount,
      f.types.map((t) => `${t.type}:${t.count}`).join(' ')].map(cell).join(','));
  }
  download('cloak-pii-report.csv', 'text/csv', lines.join('\n'));
}

/* ------------------------------------------------------------------- init */

async function init() {
  window.Favicon?.idle();

  const prefs = loadPrefs();

  try {
    state.config = await api('/api/config');
    const modes = state.config.authModes ?? [];
    if (modes.length) {
      $('cloak-auth').innerHTML = modes
        .map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
      $('cloak-auth').value = pickOption(modes, prefs?.cloakAuthMode, state.config.defaultAuthMode);
    }

    const providers = state.config.providers ?? [];
    if (providers.length) {
      $('cloak-provider').innerHTML = providers
        .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
      $('cloak-provider').value = pickOption(providers, prefs?.cloakProvider, state.config.defaultProvider);
      $('cloak-provider').addEventListener('change', () => applyProviderDefaults(providers));
      $('cloak-endpoint').addEventListener('input', () => warnOnEndpointMismatch(providers));
      applyProviderDefaults(providers, { keepEndpoint: true });
    }
  } catch { /* the built-in defaults are fine */ }

  if (prefs) {
    if (prefs.rowsPerColumn) $('rows-per-column').value = prefs.rowsPerColumn;
    if (prefs.maxColumns) $('max-columns').value = prefs.maxColumns;
    if (prefs.sslMode) $('ssl-mode').value = prefs.sslMode;
    if (prefs.cloakEndpoint) $('cloak-endpoint').value = prefs.cloakEndpoint;
    // Checkboxes need an explicit typeof test: `prefs.includeViews &&` would
    // never restore an unchecked box, and `?? true` would fight the markup's
    // own default. Absent means "leave the markup alone".
    if (typeof prefs.includeJson === 'boolean') $('include-json').checked = prefs.includeJson;
    if (typeof prefs.includeViews === 'boolean') $('include-views').checked = prefs.includeViews;
    if (typeof prefs.scanAll === 'boolean') $('scan-all').checked = prefs.scanAll;
  }

  $('scan-all').addEventListener('change', applyFullScanMode);
  applyFullScanMode();

  // Changing a source flag changes which columns exist, so the inventory shown
  // in step 3 goes stale the moment one is toggled. Re-inspect if we already
  // have one; otherwise just remember the choice for the first inspect.
  for (const id of ['include-json', 'include-views']) {
    $(id).addEventListener('change', () => {
      savePrefs();
      if (state.inventory) inspect();
    });
  }

  try {
    state.catalogue = await api('/api/entity-types');
    const known = new Set(state.catalogue.types.map((t) => t.id));

    // Restore a cached selection if it still matches the catalogue, otherwise
    // start from the default preset rather than an empty or stale list.
    const cached = (prefs?.selectedTypes ?? []).filter((t) => known.has(t));
    if (cached.length) {
      state.selectedTypes = new Set(cached);
      state.activePreset = prefs.activePreset ?? null;
      markCustomPreset();
      renderPresets();
      renderTypePicker();
    } else {
      // Fall back through the presets rather than ever landing on an empty
      // selection, which would block the scan with nothing to report.
      applyPreset(DEFAULT_PRESET);
      if (state.selectedTypes.size === 0) applyPreset('all');
      if (state.selectedTypes.size === 0) {
        state.selectedTypes = new Set(known);
        state.activePreset = null;
        renderPresets();
        renderTypePicker();
      }
    }

    setTypesExpanded(Boolean(prefs?.typesExpanded));
  } catch {
    showAlert('warn', 'Could not load the entity catalogue',
      'The scan will fall back to reporting every entity type.');
  }

  $('btn-test-api').addEventListener('click', testApi);
  $('btn-inspect').addEventListener('click', inspect);
  $('btn-scan').addEventListener('click', startScan);
  $('btn-cancel').addEventListener('click', cancelScan);
  $('btn-export-json').addEventListener('click', exportJson);
  $('btn-export-csv').addEventListener('click', exportCsv);
  $('btn-print').addEventListener('click', () => window.print());

  $('btn-toggle-types').addEventListener('click', () => setTypesExpanded(!state.typesExpanded));

  $('btn-select-all').addEventListener('click', () => applyPreset('all'));
  $('btn-select-none').addEventListener('click', () => {
    state.selectedTypes = new Set();
    markCustomPreset();
    renderTypePicker();
    updateBudget();
  });

  $('preset-row').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (btn) applyPreset(btn.getAttribute('data-preset'));
  });

  $('type-filter').addEventListener('input', renderTypePicker);

  $('type-groups').addEventListener('change', (e) => {
    const box = e.target.closest('[data-type]');
    if (!box) return;
    const id = box.getAttribute('data-type');
    if (box.checked) state.selectedTypes.add(id); else state.selectedTypes.delete(id);
    markCustomPreset();
    updatePickerCount();
    updateBudget();
    // Refresh only the group counters, so the checkbox does not lose focus.
    const head = box.closest('.type-group')?.querySelector('.type-group-count');
    if (head) {
      const groupId = box.closest('.type-group').querySelector('.type-group-head').getAttribute('data-group');
      const inGroup = state.catalogue.types.filter((t) => t.group === groupId);
      head.textContent = `${inGroup.filter((t) => state.selectedTypes.has(t.id)).length}/${inGroup.length}`;
    }
  });

  $('type-groups').addEventListener('click', (e) => {
    const head = e.target.closest('[data-group]');
    if (!head) return;
    const groupId = head.getAttribute('data-group');
    const inGroup = state.catalogue.types.filter((t) => t.group === groupId);
    const allOn = inGroup.every((t) => state.selectedTypes.has(t.id));
    for (const t of inGroup) {
      if (allOn) state.selectedTypes.delete(t.id); else state.selectedTypes.add(t.id);
    }
    markCustomPreset();
    renderTypePicker();
    updateBudget();
  });

  $('schema-select').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-schema]');
    // pointer-events would also stop this, but the guard keeps the rule in the
    // logic rather than resting on a style that is easy to edit away.
    if (!btn || isFullScan()) return;
    const name = btn.getAttribute('data-schema');
    if (state.selectedSchemas.has(name)) state.selectedSchemas.delete(name);
    else state.selectedSchemas.add(name);
    // Full re-render rather than toggling the class: the size and row cards are
    // scoped to the selection, so they have to move with it too.
    renderScope();
  });

  for (const id of ['max-columns', 'rows-per-column']) {
    $(id).addEventListener('input', () => { updateBudget(); savePrefs(); });
  }
  for (const id of ['ssl-mode', 'cloak-endpoint', 'cloak-auth']) {
    $(id).addEventListener('change', savePrefs);
  }

  $('connection-string').addEventListener('input', () => {
    $('fields-disclosure').classList.toggle('is-hidden', $('connection-string').value.trim().length > 0);
  });
}

init();
