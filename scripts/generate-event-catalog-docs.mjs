#!/usr/bin/env node
/**
 * Regenerate the event catalog section of
 * `docs/features/metering-events.md` from the canonical
 * `functions/src/services/metering/eventCatalog.ts` registry (issue #176).
 *
 * Why: the issue notes the hand-written table easily drifts from reality.
 * This script reads the registry at build time and rewrites everything
 * between the `<!-- EVENT_CATALOG:BEGIN -->` and
 * `<!-- EVENT_CATALOG:END -->` markers in the docs file. Run it as part
 * of pre-commit / CI when changing `eventCatalog.ts`.
 *
 * Usage:
 *   node scripts/generate-event-catalog-docs.mjs           # write
 *   node scripts/generate-event-catalog-docs.mjs --check   # exit 1 on drift
 *
 * NOTE: this script intentionally reads the `.ts` source via a tiny regex
 * parse rather than compiling, so it can run in any Node environment
 * without a TS toolchain. The registry has a deliberately simple shape
 * to support this.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');
const REGISTRY = resolve(ROOT, 'functions/src/services/metering/eventCatalog.ts');
const DOCS = resolve(ROOT, 'docs/features/metering-events.md');
const BEGIN = '<!-- EVENT_CATALOG:BEGIN -->';
const END = '<!-- EVENT_CATALOG:END -->';

/**
 * Pull `CATALOG_VERSION = '...'` out of the registry source.
 */
function parseCatalogVersion(src) {
  const m = /export const CATALOG_VERSION\s*=\s*'([^']+)'/.exec(src);
  if (!m) throw new Error('Cannot find CATALOG_VERSION in eventCatalog.ts');
  return m[1];
}

/**
 * Pull each entry's `{ name, version, billable, description }` out of
 * the registry source. Schemas are intentionally not parsed here \u2014 the
 * docs page is a high-level summary; the `GET /v1/host/webhook-events`
 * endpoint serves the full JSON Schema.
 */
function parseEntries(src) {
  // Grab the array body between `export const EVENT_CATALOG = [` and
  // `] as const satisfies`.
  const arr = /export const EVENT_CATALOG\s*=\s*\[([\s\S]*?)\]\s*as const satisfies/.exec(src);
  if (!arr) throw new Error('Cannot find EVENT_CATALOG array');
  const body = arr[1];
  const entries = [];
  // Each entry is `{ name: '...', version: N, billable: bool, description: '...', schema: ... }`.
  const re = /\{\s*name:\s*'([^']+)',\s*version:\s*(\d+),\s*billable:\s*(true|false),\s*description:\s*\n?\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push({
      name: m[1],
      version: Number(m[2]),
      billable: m[3] === 'true',
      description: m[4],
    });
  }
  if (entries.length === 0) {
    throw new Error('No EVENT_CATALOG entries parsed');
  }
  return entries;
}

function renderMarkdown(version, entries) {
  const lines = [];
  lines.push(BEGIN);
  lines.push('');
  lines.push('> ⚠️ This table is auto-generated from `functions/src/services/metering/eventCatalog.ts`.');
  lines.push('> Do not hand-edit; run `node scripts/generate-event-catalog-docs.mjs` after changing the registry.');
  lines.push('>');
  lines.push(`> **Catalog version:** \`${version}\` — the same string is stamped on every outbound webhook envelope and returned by \`GET /v1/host/webhook-events\`.`);
  lines.push('');
  lines.push('| `type` | Version | Billable | Description |');
  lines.push('| --- | --- | --- | --- |');
  for (const e of entries) {
    const billable = e.billable ? '✅' : '—';
    // Escape pipes inside descriptions (defensive; none today).
    const desc = e.description.replace(/\|/g, '\\|');
    lines.push(`| \`${e.name}\` | ${e.version} | ${billable} | ${desc} |`);
  }
  lines.push('');
  lines.push('For the full JSON Schema of each event\'s `meta` payload, call');
  lines.push('`GET /v1/host/webhook-events` with a host API key (see');
  lines.push('`contracts/openapi/host-webhook-events.openapi.json`).');
  lines.push('');
  lines.push(END);
  return lines.join('\n');
}

function ensureMarkers(docs) {
  const hasBegin = docs.includes(BEGIN);
  const hasEnd = docs.includes(END);
  if (hasBegin && hasEnd) return docs;
  if (hasBegin || hasEnd) {
    throw new Error('Docs file has only one of the EVENT_CATALOG markers; please fix manually.');
  }
  // First-run insertion: replace the hand-written `## Event catalog` block
  // (heading + table) with our marker block. Locate the heading and the
  // next heading at the same level.
  const headingRe = /^## Event catalog[^\n]*\n/m;
  const nextHeadingRe = /\n## /;
  const h = headingRe.exec(docs);
  if (!h) {
    throw new Error(
      'Could not find `## Event catalog` heading. Add EVENT_CATALOG markers manually.'
    );
  }
  const after = docs.slice(h.index + h[0].length);
  const nextRel = after.search(nextHeadingRe);
  if (nextRel < 0) {
    throw new Error('Could not find next `## ` heading after Event catalog section.');
  }
  const cutEnd = h.index + h[0].length + nextRel;
  // Replace heading-through-next-heading with heading + markers placeholder.
  return (
    docs.slice(0, h.index) +
    `## Event catalog\n\n${BEGIN}\n${END}\n` +
    docs.slice(cutEnd)
  );
}

function replaceBlock(docs, generated) {
  const beginIdx = docs.indexOf(BEGIN);
  const endIdx = docs.indexOf(END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error('EVENT_CATALOG markers are missing or malformed.');
  }
  const before = docs.slice(0, beginIdx);
  const after = docs.slice(endIdx + END.length);
  return before + generated + after;
}

function main() {
  const check = process.argv.includes('--check');
  const src = readFileSync(REGISTRY, 'utf8');
  const version = parseCatalogVersion(src);
  const entries = parseEntries(src);
  const generated = renderMarkdown(version, entries);

  let docs = readFileSync(DOCS, 'utf8');
  docs = ensureMarkers(docs);
  const updated = replaceBlock(docs, generated);

  if (check) {
    const current = readFileSync(DOCS, 'utf8');
    if (current !== updated) {
      console.error(
        'metering-events.md is out of date. Run `node scripts/generate-event-catalog-docs.mjs` and commit.'
      );
      process.exit(1);
    }
    console.log('metering-events.md is up to date.');
    return;
  }

  writeFileSync(DOCS, updated);
  console.log(`Wrote ${entries.length} events to ${DOCS} (catalog version ${version})`);
}

main();
