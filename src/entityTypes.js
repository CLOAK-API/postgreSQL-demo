/**
 * The CLOAK entity taxonomy.
 *
 * Every type the API can return, grouped for the selection UI and tagged with a
 * severity and the regulations that typically care about it. `special` marks
 * GDPR Article 9 special-category data, which carries a higher bar than
 * ordinary personal data.
 *
 * Severity drives how findings are ranked in the report:
 *   critical — direct account takeover / payment / government identity / health ID
 *   high     — directly identifies a person, or locates them
 *   medium   — identifying in combination, or commercially sensitive
 *   low      — weak signals, usually only meaningful alongside something else
 */

export const GROUPS = [
  { id: 'identity',   label: 'Identity & demographics', icon: 'user' },
  { id: 'government', label: 'Government IDs',          icon: 'badge' },
  { id: 'contact',    label: 'Contact & location',      icon: 'pin' },
  { id: 'financial',  label: 'Financial & payment',     icon: 'card' },
  { id: 'health',     label: 'Health',                  icon: 'heart' },
  { id: 'technical',  label: 'Technical & credentials', icon: 'key' },
  { id: 'business',   label: 'Employment & business',   icon: 'building' },
  { id: 'temporal',   label: 'Temporal & contextual',   icon: 'clock' },
];

/** [type, group, severity, regulations, special?] */
const CATALOGUE = [
  // --- Identity & demographics --------------------------------------------
  ['PERSON_NAME',            'identity',   'high',     ['GDPR', 'DPDP', 'HIPAA']],
  ['USERNAME',               'identity',   'high',     ['GDPR', 'DPDP']],
  ['DATE_OF_BIRTH',          'identity',   'high',     ['GDPR', 'DPDP', 'HIPAA']],
  ['AGE',                    'identity',   'medium',   ['GDPR', 'HIPAA']],
  ['GENDER',                 'identity',   'medium',   ['GDPR']],
  ['NATIONALITY',            'identity',   'high',     ['GDPR'], true],
  ['MARITAL_STATUS',         'identity',   'medium',   ['GDPR']],
  ['RELIGION',               'identity',   'critical', ['GDPR'], true],
  ['ZODIAC_SIGN',            'identity',   'low',      []],
  ['PHYSICAL_ATTRIBUTE',     'identity',   'high',     ['GDPR'], true],
  ['LANGUAGE',               'identity',   'low',      ['GDPR']],
  ['OCCUPATION',             'identity',   'medium',   ['GDPR']],

  // --- Government IDs ------------------------------------------------------
  ['AADHAAR',                'government', 'critical', ['DPDP']],
  ['PASSPORT',               'government', 'critical', ['GDPR', 'DPDP']],
  ['PAN',                    'government', 'critical', ['DPDP']],
  ['SSN',                    'government', 'critical', ['HIPAA', 'GLBA']],
  ['DRIVING_LICENSE',        'government', 'critical', ['GDPR', 'DPDP']],
  ['VOTER_ID',               'government', 'critical', ['DPDP']],

  // --- Contact & location --------------------------------------------------
  ['EMAIL',                  'contact',    'high',     ['GDPR', 'DPDP', 'HIPAA']],
  ['PHONE_NUMBER',           'contact',    'high',     ['GDPR', 'DPDP', 'HIPAA']],
  ['ADDRESS',                'contact',    'high',     ['GDPR', 'DPDP', 'HIPAA']],
  ['LOCATION',               'contact',    'medium',   ['GDPR']],
  ['ZIP_CODE',               'contact',    'medium',   ['GDPR', 'HIPAA']],
  ['GEOLOCATION',            'contact',    'high',     ['GDPR', 'DPDP']],

  // --- Financial & payment -------------------------------------------------
  ['CREDIT_CARD',            'financial',  'critical', ['PCI DSS']],
  ['CVV',                    'financial',  'critical', ['PCI DSS']],
  ['CARD_EXPIRY_DATE',       'financial',  'critical', ['PCI DSS']],
  ['BANK_ACCOUNT_NUMBER',    'financial',  'critical', ['PCI DSS', 'GLBA']],
  ['UPI_ID',                 'financial',  'critical', ['DPDP']],
  ['SWIFT_CODE',             'financial',  'high',     ['GLBA']],
  ['ROUTING_NUMBER',         'financial',  'critical', ['PCI DSS', 'GLBA']],
  ['IFSC',                   'financial',  'high',     ['DPDP']],
  ['IBAN',                   'financial',  'critical', ['PCI DSS', 'GDPR']],
  ['CRYPTO_WALLET_ADDRESS',  'financial',  'critical', ['GDPR']],
  ['CREDIT_SCORE',           'financial',  'high',     ['GLBA', 'GDPR']],
  ['MONEY',                  'financial',  'medium',   []],

  // --- Health --------------------------------------------------------------
  ['BLOOD_TYPE',             'health',     'high',     ['HIPAA', 'GDPR'], true],
  ['DOSE',                   'health',     'high',     ['HIPAA', 'GDPR'], true],
  ['DRUG',                   'health',     'high',     ['HIPAA', 'GDPR'], true],
  ['INJURY',                 'health',     'high',     ['HIPAA', 'GDPR'], true],
  ['HEALTH_INSURANCE_ID',    'health',     'critical', ['HIPAA', 'GDPR'], true],
  ['PATIENT_ID',             'health',     'critical', ['HIPAA', 'GDPR'], true],

  // --- Technical & credentials ---------------------------------------------
  ['PASSWORD',               'technical',  'critical', ['GDPR', 'PCI DSS']],
  ['API_KEY',                'technical',  'critical', ['PCI DSS']],
  ['IP_ADDRESS',             'technical',  'high',     ['GDPR', 'DPDP']],
  ['MAC_ADDRESS',            'technical',  'high',     ['GDPR']],
  ['DEVICE_ID',              'technical',  'high',     ['GDPR', 'DPDP']],
  ['VEHICLE_ID',             'technical',  'medium',   ['GDPR']],
  ['URL',                    'technical',  'low',      []],
  ['FILENAME',               'technical',  'low',      []],
  ['REFERENCE_ID',           'technical',  'low',      []],

  // --- Employment & business ------------------------------------------------
  ['EMPLOYEE_ID',            'business',   'high',     ['GDPR', 'DPDP']],
  ['ORGANIZATION',           'business',   'medium',   []],
  ['BUSINESS_REGISTRATION_NUMBER', 'business', 'medium', []],
  ['COMPANY_TAX_ID/GST/VAT', 'business',   'high',     []],

  // --- Temporal & contextual ------------------------------------------------
  ['DATE',                   'temporal',   'low',      ['HIPAA']],
  ['TIME',                   'temporal',   'low',      []],
  ['DATE_INTERVAL',          'temporal',   'low',      []],
  ['DURATION',               'temporal',   'low',      []],
  ['EVENT_NAME',             'temporal',   'low',      []],
];

export const ENTITY_TYPES = CATALOGUE.map(([id, group, severity, regulations, special = false]) => ({
  id,
  group,
  severity,
  regulations,
  special,
  label: humanise(id),
}));

const ENTITY_BY_ID = new Map(ENTITY_TYPES.map((t) => [t.id, t]));

export function isKnownType(type) {
  return ENTITY_BY_ID.has(String(type ?? '').toUpperCase());
}

export const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** COMPANY_TAX_ID/GST/VAT -> "Company tax ID / GST / VAT" */
function humanise(id) {
  return String(id)
    .split('/')
    .map((part) => {
      const words = part.replace(/_/g, ' ').trim().toLowerCase();
      const cased = words.charAt(0).toUpperCase() + words.slice(1);
      return cased
        .replace(/\b(id|ssn|pan|cvv|upi|ifsc|iban|url|ip|mac|api|gst|vat)\b/gi, (m) => m.toUpperCase())
        .replace(/\bAadhaar\b/i, 'Aadhaar');
    })
    .join(' / ');
}

/**
 * Severity for a type. Anything CLOAK returns that is not in the catalogue is
 * treated as medium rather than dropped, so a newly added entity type still
 * shows up in the report instead of silently disappearing.
 */
export function severityForType(type) {
  return ENTITY_BY_ID.get(String(type).toUpperCase())?.severity ?? 'medium';
}

export function groupForType(type) {
  return ENTITY_BY_ID.get(String(type).toUpperCase())?.group ?? 'other';
}

export function regulationsForType(type) {
  return ENTITY_BY_ID.get(String(type).toUpperCase())?.regulations ?? [];
}

export function isSpecialCategory(type) {
  return Boolean(ENTITY_BY_ID.get(String(type).toUpperCase())?.special);
}

export function highestSeverity(types) {
  let best = 'none';
  for (const type of types) {
    const sev = severityForType(type);
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[best]) best = sev;
  }
  return best;
}

const byGroup = (group) => ENTITY_TYPES.filter((t) => t.group === group).map((t) => t.id);
const byRegulation = (reg) => ENTITY_TYPES.filter((t) => t.regulations.includes(reg)).map((t) => t.id);

/**
 * Ready-made selections, so a demo can be scoped in one click.
 * Definitions may overlap (a group plus a few extras); `unique` below keeps the
 * resulting list free of duplicates.
 */
const unique = (types) => [...new Set(types)];

const PRESET_DEFS = [
  { id: 'all', label: 'Everything', hint: 'All 60 entity types', types: ENTITY_TYPES.map((t) => t.id) },
  {
    id: 'direct',
    label: 'Direct identifiers',
    hint: 'Who the person is, and how to reach them',
    types: [...byGroup('government'), 'PERSON_NAME', 'USERNAME', 'DATE_OF_BIRTH',
            'EMAIL', 'PHONE_NUMBER', 'ADDRESS', 'GEOLOCATION'],
  },
  { id: 'pci', label: 'Payment (PCI DSS)', hint: 'Cardholder and bank data', types: [...byGroup('financial')] },
  {
    id: 'phi',
    label: 'Health (HIPAA)',
    hint: 'Clinical data plus the identifiers that attach it to a person',
    types: [...byGroup('health'), 'PERSON_NAME', 'DATE_OF_BIRTH', 'AGE', 'ZIP_CODE', 'PATIENT_ID'],
  },
  { id: 'government', label: 'Government IDs', hint: 'National identity numbers', types: byGroup('government') },
  {
    id: 'credentials',
    label: 'Secrets & devices',
    hint: 'Credentials and technical identifiers that leak into free text',
    types: ['PASSWORD', 'API_KEY', 'IP_ADDRESS', 'MAC_ADDRESS', 'DEVICE_ID', 'CRYPTO_WALLET_ADDRESS'],
  },
  {
    id: 'special',
    label: 'GDPR special category',
    hint: 'Article 9 data — the highest bar under GDPR',
    types: ENTITY_TYPES.filter((t) => t.special).map((t) => t.id),
  },
  { id: 'gdpr', label: 'GDPR-relevant', hint: 'Everything tagged GDPR', types: byRegulation('GDPR') },
];
/** Deduped at export, so a preset definition can safely overlap a group. */
export const PRESETS = PRESET_DEFS.map((p) => ({ ...p, types: unique(p.types) }));


/** Validate a caller-supplied selection; falls back to everything. */
export function resolveSelection(selected) {
  if (!Array.isArray(selected) || selected.length === 0) {
    return { types: ENTITY_TYPES.map((t) => t.id), all: true, unknown: [] };
  }
  const wanted = selected.map((t) => String(t).toUpperCase());
  const known = wanted.filter((t) => ENTITY_BY_ID.has(t));
  const unknown = wanted.filter((t) => !ENTITY_BY_ID.has(t));
  const types = known.length ? known : ENTITY_TYPES.map((t) => t.id);
  return { types, all: types.length === ENTITY_TYPES.length, unknown };
}
