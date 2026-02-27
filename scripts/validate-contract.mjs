import fs from 'node:fs';

const path = 'contracts/openapi/albums.openapi.json';
const spec = JSON.parse(fs.readFileSync(path, 'utf8'));

const errors = [];

if (!spec.openapi) errors.push('Missing openapi version.');
if (!spec.info?.version) errors.push('Missing info.version.');
if (!spec.paths?.['/api/v1/albums']?.get) errors.push('Missing GET /api/v1/albums.');
if (!spec.paths?.['/api/v1/albums']?.post) errors.push('Missing POST /api/v1/albums.');
if (!spec.components?.schemas?.ErrorEnvelope) errors.push('Missing ErrorEnvelope schema.');
if (!spec.components?.schemas?.Pagination) errors.push('Missing Pagination schema.');

if (errors.length > 0) {
  console.error('Contract validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Contract validation passed.');
