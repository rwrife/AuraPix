import { execSync } from 'node:child_process';
import fs from 'node:fs';

const CONTRACT_PATH = 'contracts/openapi/albums.openapi.json';

function readCurrentSpec() {
  return JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
}

function readBaseSpec() {
  try {
    const raw = execSync(`git show origin/main:${CONTRACT_PATH}`, { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function major(version) {
  const [m] = String(version ?? '0').split('.');
  return Number.parseInt(m, 10) || 0;
}

function getOperationMap(spec) {
  const map = new Map();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (pathItem?.[method]) {
        map.set(`${method.toUpperCase()} ${path}`, pathItem[method]);
      }
    }
  }
  return map;
}

function findBreakingChanges(baseSpec, headSpec) {
  const breaking = [];
  const baseOps = getOperationMap(baseSpec);
  const headOps = getOperationMap(headSpec);

  for (const key of baseOps.keys()) {
    if (!headOps.has(key)) {
      breaking.push(`Removed operation: ${key}`);
    }
  }

  for (const [key, baseOp] of baseOps.entries()) {
    const headOp = headOps.get(key);
    if (!headOp) continue;

    const baseReqRequired = Boolean(baseOp.requestBody?.required);
    const headReqRequired = Boolean(headOp.requestBody?.required);
    if (!baseReqRequired && headReqRequired) {
      breaking.push(`Request body became required: ${key}`);
    }

    const baseResponses = Object.keys(baseOp.responses ?? {});
    const headResponses = new Set(Object.keys(headOp.responses ?? {}));
    for (const status of baseResponses) {
      if (!headResponses.has(status)) {
        breaking.push(`Removed response status ${status}: ${key}`);
      }
    }
  }

  return breaking;
}

const headSpec = readCurrentSpec();
const baseSpec = readBaseSpec();

if (!baseSpec) {
  console.log('No base contract found on origin/main; skipping breaking-change gate for first artifact introduction.');
  process.exit(0);
}

const breaking = findBreakingChanges(baseSpec, headSpec);
if (breaking.length === 0) {
  console.log('No breaking API contract changes detected.');
  process.exit(0);
}

const baseMajor = major(baseSpec.info?.version);
const headMajor = major(headSpec.info?.version);

if (headMajor > baseMajor) {
  console.log('Breaking changes detected, and major version bump is present.');
  for (const change of breaking) {
    console.log(`- ${change}`);
  }
  process.exit(0);
}

console.error('Breaking API contract changes detected without major version bump.');
for (const change of breaking) {
  console.error(`- ${change}`);
}
console.error(`Base version: ${baseSpec.info?.version ?? 'unknown'}, Head version: ${headSpec.info?.version ?? 'unknown'}`);
process.exit(1);
