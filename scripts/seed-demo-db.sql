-- Demo database for the CLOAK PII scanner.
-- Creates a small schema with a realistic mix of PII, PHI and PCI columns
-- alongside clean ones, so a scan produces a varied, believable report.
--
--   createdb cloak_demo
--   psql -d cloak_demo -f scripts/seed-demo-db.sql
--
-- All names, numbers and identifiers below are fictional.

DROP SCHEMA IF EXISTS billing CASCADE;
DROP SCHEMA IF EXISTS clinical CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS support_tickets CASCADE;
DROP TABLE IF EXISTS audit_events CASCADE;

CREATE SCHEMA billing;
CREATE SCHEMA clinical;

-- ---------------------------------------------------------------- public --

CREATE TABLE customers (
  id            serial PRIMARY KEY,
  full_name     text,
  email         text,
  phone         text,
  postal_address text,
  account_status text,          -- clean
  signup_source text            -- clean
);

INSERT INTO customers (full_name, email, phone, postal_address, account_status, signup_source) VALUES
  ('Priya Deshmukh',  'priya.deshmukh@example.com', '+91 98765 43210', '14 Marlow Court, Leeds LS6 2QT',     'active',   'organic'),
  ('Alan Whitfield',  'alan.whitfield@example.com', '0161 496 0142',   'Flat 5B, Palm Meadows, Bengaluru',   'active',   'referral'),
  ('Ingrid Sorensen', 'ingrid.s@example.dk',        '+45 20 33 87 61', '22 Vestergade, Copenhagen 1456',     'churned',  'paid_ads'),
  ('Marcus Feld',     'm.feld@example.com',         '07700 900341',    '9 Northgate Road, Manchester M1 4AB','active',   'organic'),
  ('Lauren Castillo', 'lauren.castillo@example.com','07911 223344',    '3 Harbour View, Bristol BS1 5TY',    'suspended','referral');

CREATE TABLE support_tickets (
  id          serial PRIMARY KEY,
  subject     text,
  body        text,
  priority    text,             -- clean
  resolved_on date
);

INSERT INTO support_tickets (subject, body, priority, resolved_on) VALUES
  ('Delayed claim',   'Customer Rohan Malhotra (phone +91 98765 43210) reported a delayed claim, resolved by referring to policy WL-88213.', 'high',   '2026-02-03'),
  ('Card declined',   'Caller said the card ending 4417 was declined. Verified DOB 22/09/1994 and account 0021456789.',                       'urgent', '2026-01-19'),
  ('Address change',  'Please update the address for Alan Whitfield to 12 Rowan Way, Leeds LS8 1PQ.',                                          'normal', '2026-02-11'),
  ('Password reset',  'User could not log in. Reset link sent. No further action needed.',                                                     'low',    '2026-02-14');

CREATE TABLE audit_events (
  id         serial PRIMARY KEY,
  event_type text,              -- clean
  actor_role text,              -- clean
  payload    jsonb
);

INSERT INTO audit_events (event_type, actor_role, payload) VALUES
  ('login',        'admin',   '{"ip":"203.0.113.14","user":"m.feld@example.com"}'),
  ('export',       'analyst', '{"rows":420,"requested_by":"Lauren Castillo"}'),
  ('config_change','system',  '{"setting":"retention_days","from":30,"to":90}');

-- --------------------------------------------------------------- billing --

CREATE TABLE billing.payment_methods (
  id             serial PRIMARY KEY,
  cardholder     text,
  card_number    text,
  expiry         text,
  security_code  text,
  bank_account   text,
  currency       text           -- clean
);

INSERT INTO billing.payment_methods (cardholder, card_number, expiry, security_code, bank_account, currency) VALUES
  ('Priya Deshmukh',  '4111 1111 1111 1111', '07/28', '123', '0021456789', 'GBP'),
  ('Alan Whitfield',  '5500 0000 0000 0004', '11/27', '447', '88213047',   'GBP'),
  ('Ingrid Sorensen', '4012 8888 8888 1881', '03/29', '901', '55120884',   'DKK');

CREATE TABLE billing.invoices (
  id          serial PRIMARY KEY,
  reference   text,             -- clean
  amount_note text
);

INSERT INTO billing.invoices (reference, amount_note) VALUES
  ('INV-2026-0041', 'Charge of 248.99 from Brightwave Media on 11 February 2026'),
  ('INV-2026-0042', 'Annual subscription, no adjustments');

-- -------------------------------------------------------------- clinical --

CREATE TABLE clinical.encounters (
  id            serial PRIMARY KEY,
  patient_ref   text,
  clinician     text,
  dictation     text,
  department    text            -- clean
);

INSERT INTO clinical.encounters (patient_ref, clinician, dictation, department) VALUES
  ('MRN 4471902', 'Dr. Patricia Holloway', 'Patient has a right wrist fracture, insurance claim number TXB-2026-00441, follow-up 14 March 2026.', 'orthopaedics'),
  ('MRN 8820416', 'Dr. Neena Raghavan',    'Discharged after three-day admission for atrial fibrillation. Started on apixaban 5mg twice daily.',   'cardiology'),
  ('MRN 3319075', 'Dr. Patricia Holloway', 'Routine review. No abnormalities noted, no follow-up required.',                                        'orthopaedics');

-- A read-only role is the right way to point the scanner at anything real.
-- CREATE ROLE cloak_scanner LOGIN PASSWORD 'change-me';
-- GRANT CONNECT ON DATABASE cloak_demo TO cloak_scanner;
-- GRANT USAGE ON SCHEMA public, billing, clinical TO cloak_scanner;
-- GRANT SELECT ON ALL TABLES IN SCHEMA public, billing, clinical TO cloak_scanner;
