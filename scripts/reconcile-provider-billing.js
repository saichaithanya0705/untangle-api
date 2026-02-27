#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function getArg(flagName, fallbackValue) {
  const argv = process.argv.slice(2);
  const index = argv.findIndex((value) => value === flagName);
  if (index < 0) return fallbackValue;
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) return fallbackValue;
  return next;
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(field);
      field = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const server = getArg('--server', 'http://127.0.0.1:4010');
const providerId = getArg('--provider', '');
const csvPathArg = getArg('--csv', '');
const modelColumn = getArg('--model-column', 'model');
const costColumn = getArg('--cost-column', 'cost_usd');
const timestampColumn = getArg('--timestamp-column', 'timestamp');
const toleranceRaw = getArg('--tolerance-usd', '0.0001');
const toleranceUsd = Number(toleranceRaw);

if (!providerId || !csvPathArg) {
  console.error('Usage: node scripts/reconcile-provider-billing.js --provider <providerId> --csv <path> [--server <url>] [--model-column model] [--cost-column cost_usd] [--timestamp-column timestamp] [--tolerance-usd 0.0001]');
  process.exit(1);
}

if (!Number.isFinite(toleranceUsd) || toleranceUsd < 0) {
  console.error('--tolerance-usd must be a non-negative number');
  process.exit(1);
}

const csvPath = resolve(root, csvPathArg);
const csvText = readFileSync(csvPath, 'utf-8');
const rows = parseCsv(csvText);
if (rows.length < 2) {
  console.error(`CSV has no data rows: ${csvPath}`);
  process.exit(1);
}

const header = rows[0];
const indexByName = Object.fromEntries(header.map((name, index) => [name.trim(), index]));
const modelIndex = indexByName[modelColumn];
const costIndex = indexByName[costColumn];
const timestampIndex = indexByName[timestampColumn];

if (modelIndex === undefined || costIndex === undefined) {
  console.error(`CSV is missing required columns. Expected model="${modelColumn}" and cost="${costColumn}"`);
  process.exit(1);
}

const records = rows.slice(1).map((line, rowOffset) => {
  const rawCost = line[costIndex]?.trim() ?? '';
  const costUsd = Number(rawCost);
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`Invalid cost on CSV row ${rowOffset + 2}: "${rawCost}"`);
  }
  const modelId = line[modelIndex]?.trim();
  const timestamp = timestampIndex !== undefined ? line[timestampIndex]?.trim() : undefined;
  return {
    providerId,
    modelId,
    costUsd,
    timestamp: timestamp && timestamp.length > 0 ? timestamp : undefined,
  };
});

const response = await fetch(`${server}/api/control-plane/reconciliation/provider-export`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    providerId,
    toleranceUsd,
    records,
  }),
});

const payload = await response.json();
if (!response.ok) {
  console.error('Provider billing reconciliation failed:');
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(payload, null, 2));
if (!payload.withinTolerance) {
  process.exit(2);
}
