# CLOAK — PII Discovery for PostgreSQL

Point it at a PostgreSQL database and it reports **which columns contain personal data**, what
kind, and how prevalent it is — classified by the CLOAK detection API.

Connect → choose a detection profile → scan → hand over a JSON / CSV / PDF report.

```
Connect  ──▶  Inspect schema  ──▶  Sample values  ──▶  Classify with CLOAK  ──▶  Report
```

---

## Contents

- [Quick start](#quick-start)
- [Providers](#providers)
- [How it works](#how-it-works)
- [Detection profile](#detection-profile)
- [The report](#the-report)
- [Rate limits](#rate-limits)
- [Try it on a real database](#try-it-on-a-real-database)
- [Security](#security)
- [Project layout](#project-layout)
- [API](#api)
- [Known limitations](#known-limitations)

---

## Quick start

**Requirements:** Node 18+ and a PostgreSQL database you can reach.

```bash
git clone <this-repo>
cd pii-db-scanner
npm install
npm start
```

Open **http://localhost:4000** and fill in four things:

| Field | Where it comes from |
| --- | --- |
| **Connection string** | `postgresql://user:password@host:5432/database` — or use the separate host / port / database / user / password fields |
| **SSL mode** | `Auto` suits most cases. Hosted Postgres (Neon, Supabase, RDS) needs TLS, which `Auto` already selects for non-local hosts |
| **Provider** | Leave on **Auto-detect** unless you want an explicit failure; picking a named provider fills in its endpoint path and auth header |
| **API endpoint** | CLOAK: `https://api.cloak-ai.co/api/v1/detect` — or whatever your dashboard shows |
| **Auth header** | CLOAK uses `Authorization: Bearer`; endpoints behind a gateway usually want `x-api-key`. Exactly one header is sent |
| **API key** | From your provider's dashboard |

Use **Test API** before scanning — it spends one request to confirm the endpoint, key, auth
header and response shape all line up, and shows the raw response if nothing is detected.

There is **no `.env` and no config file**. Credentials are entered in the browser, held in
memory for the duration of the scan, and never written to disk.

Override the port with `PORT=8080 npm start`.

---

## Providers

Detection APIs agree on the idea and disagree on the wire format. **Auto-detect** (the
default) works that out for you: it tries each known request shape until one is accepted,
then locks it in for the rest of the scan, so the negotiation costs a couple of requests once
rather than per column.

| Shape | Request body | Used by |
| --- | --- | --- |
| `list` | `{ text: [...] }` | APIs that validate `text` as a list |
| `string` | `{ text: "..." }` | CLOAK |
| `content` | `{ content: "..." }` | Common alternative |

Pin a specific provider if you prefer an explicit failure over negotiation:

| Provider | Endpoint | Auth |
| --- | --- | --- |
| **CLOAK** | `https://api.cloak-ai.co/api/v1/detect` | `Authorization: Bearer` |

Picking a named provider fills in its endpoint and auth header. If the endpoint is the right
host with the wrong path — a base URL missing `/detect`, say — the field flags it before
you spend a scan finding out.

Adding a provider means one entry in `BODY_SHAPES`/`PROVIDERS` in `src/cloakClient.js` — the
only place that knows a wire format. One parser reads every response.

Provider labels are translated into the CLOAK taxonomy so severity, the detection profile and
the regulation mapping all speak one vocabulary (`NAME` → `PERSON_NAME`,
`EMAIL_ADDRESS` → `EMAIL`, and so on; see `LABEL_ALIASES`). A label with no catalogue entry is
reported as-is and named in the scan log — never silently dropped, because a type that cannot
appear in the picker is one the operator was never given the chance to select.

## How it works

1. **Connects read-only.** Every session sets `default_transaction_read_only = on`, a 15s
   `statement_timeout` and an idle-transaction timeout. The scanner cannot write.
2. **Finds candidate columns** from `information_schema` — `text`, `varchar`, `char`, `citext`,
   `json`/`jsonb`. Numeric, boolean and binary columns are skipped, and base tables only
   (sampling a view can be arbitrarily expensive).
3. **Samples values** — 40 non-null values per column by default. Framework bookkeeping
   tables (`_prisma_migrations`, `knex_migrations`, `flyway_schema_history`, …) are skipped,
   since they hold no personal data but plenty of text columns.
4. **Classifies with CLOAK** — exactly **one request per column**. The sampled values are
   joined into a single blob and each detected entity is attributed back to the value it came
   from using character offsets. Empty columns are skipped without spending a request.
5. **Reports** — grouped by table, ranked most sensitive first, exportable.

---

## Detection profile

All **60 CLOAK entity types** are selectable, in eight groups:

| Group | Count | Examples |
| --- | --- | --- |
| Identity & demographics | 12 | `PERSON_NAME`, `DATE_OF_BIRTH`, `NATIONALITY`, `RELIGION` |
| Government IDs | 6 | `AADHAAR`, `PASSPORT`, `PAN`, `SSN`, `DRIVING_LICENSE`, `VOTER_ID` |
| Contact & location | 6 | `EMAIL`, `PHONE_NUMBER`, `ADDRESS`, `GEOLOCATION` |
| Financial & payment | 12 | `CREDIT_CARD`, `CVV`, `BANK_ACCOUNT_NUMBER`, `UPI_ID`, `IBAN` |
| Health | 6 | `PATIENT_ID`, `HEALTH_INSURANCE_ID`, `DRUG`, `BLOOD_TYPE` |
| Technical & credentials | 9 | `PASSWORD`, `API_KEY`, `IP_ADDRESS`, `DEVICE_ID` |
| Employment & business | 4 | `EMPLOYEE_ID`, `ORGANIZATION`, `COMPANY_TAX_ID/GST/VAT` |
| Temporal & contextual | 5 | `DATE`, `TIME`, `DURATION`, `EVENT_NAME` |

The panel is collapsed by default and shows a one-line summary. **Direct identifiers** is the
starting profile — government IDs plus name, username, date of birth, email, phone, address
and geolocation.

One-click presets: **Everything · Direct identifiers · Payment (PCI DSS) · Health (HIPAA) ·
Government IDs · Secrets & devices · GDPR special category · GDPR-relevant**.

> **The profile filters the report, not the request.** CLOAK classifies every type it knows on
> every call, so narrowing the profile makes findings cleaner but does **not** reduce API usage
> or scan time. The report states how many detections your profile suppressed.

### Severity

| Severity | Meaning | Examples |
| --- | --- | --- |
| **Critical** | Account takeover, payment, government identity, health ID | `CREDIT_CARD`, `AADHAAR`, `PASSWORD`, `PATIENT_ID` |
| **High** | Directly identifies or locates a person | `PERSON_NAME`, `EMAIL`, `ADDRESS`, `IP_ADDRESS` |
| **Medium** | Identifying in combination, or commercially sensitive | `AGE`, `GENDER`, `MONEY`, `ORGANIZATION` |
| **Low** | Weak signals, meaningful only alongside something else | `DATE`, `TIME`, `URL`, `ZODIAC_SIGN` |

A column takes the severity of the most sensitive type in it. Unknown types default to medium
rather than being dropped, so a newly added CLOAK type still surfaces. Nine types are flagged
**ART9** (GDPR Article 9 special category).

---

## The report

| Section | Contents |
| --- | --- |
| 1. Executive summary | Columns scanned / with PII, tables affected, entities found, distinct types, Art. 9 columns |
| 2. Risk distribution | Severity spread across affected columns |
| 3. Entity types identified | Per type: count, severity, tables, columns, share, regulations |
| 4. Regulatory exposure | Column counts per regime (GDPR, PCI DSS, HIPAA, DPDP, GLBA) |
| 5. Detailed findings | Per column: per-type counts, values affected, confidence ranges, redacted examples |
| 6. Method & caveats | Target, scope, profile, sampling method, requests, suppressed detections, duration |

Each column carries an **All N detections** list — every individual match with its type,
confidence and the sampled row it came from, not just a preview. Collapsed by default so a
wide report stays readable.

Values are masked by default: redacted examples show `[CREDIT_CARD]`, and the detection list
shows `t••••@•••••.com` — enough to recognise a value without exposing it. **Reveal raw
values** shows the underlying data when you need to prove a finding. **Print / PDF** produces a clean
handover document. Columns that could not be classified are listed explicitly — a gap is not a
clean bill of health.

The regulatory mapping is an indicative triage aid, not a compliance assessment.

---

## Rate limits

The scan spends **one CLOAK request per column**, so the plan's request rate drives the
duration. On the free plan (10 requests/minute):

| Columns in scope | Approximate time |
| --- | --- |
| 10 | ~1 minute |
| 30 | ~3 minutes |
| 60 | ~6 minutes |

**The limit is discovered at runtime.** The API sends no rate-limit headers, but states the
figure in its 429 body (`Rate limit exceeded (10 requests/min on free plan)`). The scanner
parses that, adopts the rate and window, re-paces itself and logs the change — so on a higher
plan the scan simply speeds up, with nothing to configure.

Requests are **paced evenly** (one every `window ÷ limit`, so 6s apart at 10/min) rather than
fired as a burst. A burst can trip a server-side per-minute bucket even when the rolling count
is legal. If a 429 still arrives it is **retried with backoff** using the API's own retry hint,
so a rate limit never costs you a column.

The API's word quota (`x-words-limit` / `x-words-used`) is shown live and in the report.

**For a live demo, narrow the scope** — one or two schemas, and cap the column count.

---

## Try it on a real database

```bash
createdb cloak_demo
psql -d cloak_demo -f scripts/seed-demo-db.sql
```

Creates `public`, `billing` and `clinical` schemas with a deliberate mix: names, emails, phones
and addresses; card numbers, CVVs and bank accounts; MRNs, clinician names and dictation — plus
clean columns, so the report shows both signal and its absence. All data is fictional.

Then connect with `postgresql://localhost:5432/cloak_demo`.

The seed file also contains a commented-out read-only role, which is the right way to point
this at anything real.

---

## Security

- **Read-only by construction.** Every session sets `default_transaction_read_only = on`. Only
  `SELECT` is ever issued; identifiers are quoted and row limits parameterised.
- **No credentials on disk.** The CLOAK key, database password and connection string are held
  in memory for the scan and never persisted. Browser storage caches only non-secret
  preferences (entity profile, rows per column, SSL mode, endpoint).
- **Connection strings are redacted** (`user:****@host`) everywhere they are displayed or
  logged.
- **Sampled values never reach the logs** — the scan log records counts and types only.
- **Nothing leaves your machine** except the sampled values sent to CLOAK for classification.

Point it at a read-only role wherever you can. Least privilege still applies.

---

## Project layout

```
server.js                 Express app: API routes + static hosting
src/
  cloakClient.js          CLOAK adapter, rate limiter, plan detection
  db.js                   Connection, introspection, sampling
  scanner.js              Scan orchestration, batching, attribution, scoring
  entityTypes.js          The 60-type taxonomy, groups, severities, presets
public/
  index.html              Single-page UI
  styles.css              Visual system
  app.js                  UI logic and report rendering
  favicon.js              Live favicon: logo when idle, arcs while scanning
scripts/
  seed-demo-db.sql        Fictional demo database
```

No build step, no bundler, no framework. Two runtime dependencies: `express` and `pg`.

---

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config` | Rate-limit defaults, providers and auth modes |
| `POST /api/test-cloak` | One throwaway detection to validate endpoint, key and auth |
| `GET /api/entity-types` | The 60-type taxonomy, groups and presets |
| `POST /api/inspect` | Connect, verify, return schemas / tables / columns |
| `POST /api/scan` | Start a scan → `{ jobId }` |
| `GET /api/scan/:id` | Poll status, progress, log and findings |
| `POST /api/scan/:id/cancel` | Stop a running scan, keeping partial results |

Job state is in memory and expires 30 minutes after completion.

---

## Known limitations

- **Not yet run against a live PostgreSQL server.** The SQL and error handling are written
  against real Postgres behaviour but have not been exercised on a live instance — use the seed
  script above for a quick real-world check before pointing it at anything that matters.
- **Sampling uses `LIMIT`, not random ordering.** `ORDER BY random()` forces a full table scan,
  which is not something to run against a client's production database. Findings are therefore
  evidence of presence, not proof of absence: a column can hold personal data in rows the
  sample never read.
- **Row counts are estimates** (`reltuples`), not exact `COUNT(*)`.
- **Values are truncated** at 400 characters, and each column's batch is capped at 15,000
  characters.
- **Detection quality is CLOAK's.** This tool samples, batches and reports; it performs no
  classification of its own.
