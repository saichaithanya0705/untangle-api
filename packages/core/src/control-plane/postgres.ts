import type { PostgresSchemaArtifact } from './types.js';

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function renderControlPlanePostgresSchemaSql(schema: string = 'public'): string {
  const schemaName = schema.trim().length > 0 ? schema.trim() : 'public';
  const qSchema = quoteIdentifier(schemaName);
  return `
create schema if not exists ${qSchema};

create table if not exists ${qSchema}.cp_virtual_keys (
  id text primary key,
  name text not null,
  key_hash text not null unique,
  limits jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists ${qSchema}.cp_usage_events (
  id text primary key,
  ts timestamptz not null,
  virtual_key_id text references ${qSchema}.cp_virtual_keys(id) on delete set null,
  provider_id text not null,
  model_id text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_cost_usd numeric(18, 8) not null default 0,
  duration_ms integer not null default 0,
  success boolean not null default true,
  error text
);

create table if not exists ${qSchema}.cp_spend_ledger (
  id bigserial primary key,
  usage_event_id text not null references ${qSchema}.cp_usage_events(id) on delete cascade,
  ts timestamptz not null,
  virtual_key_id text,
  amount_usd numeric(18, 8) not null,
  provider_id text not null,
  model_id text not null
);

create index if not exists idx_cp_usage_events_ts on ${qSchema}.cp_usage_events(ts desc);
create index if not exists idx_cp_usage_events_key_ts on ${qSchema}.cp_usage_events(virtual_key_id, ts desc);
create index if not exists idx_cp_usage_events_provider_model_ts on ${qSchema}.cp_usage_events(provider_id, model_id, ts desc);
create index if not exists idx_cp_spend_ledger_ts on ${qSchema}.cp_spend_ledger(ts desc);
create index if not exists idx_cp_spend_ledger_key_ts on ${qSchema}.cp_spend_ledger(virtual_key_id, ts desc);
`.trim();
}

export const CONTROL_PLANE_POSTGRES_SCHEMA: PostgresSchemaArtifact = {
  migrationName: 'control_plane_base',
  sql: renderControlPlanePostgresSchemaSql('public'),
};
