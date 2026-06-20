#!/usr/bin/env node
/**
 * Build script for @aurapix/embed.
 *
 * Emits:
 *   dist/index.mjs    — ESM bundle
 *   dist/index.cjs    — CJS bundle
 *   dist/index.d.ts   — TypeScript declarations (via tsc)
 *   dist/index.mjs.map / .cjs.map — sourcemaps
 *
 * Hard size cap: 2 KB gzipped (issue #177 acceptance criterion). The
 * script fails non-zero if the ESM bundle exceeds that budget so the
 * cap is enforced in CI.
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const distDir = join(pkgRoot, 'dist');
const entry = join(pkgRoot, 'src', 'index.ts');

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const shared = {
  entryPoints: [entry],
  bundle: true,
  sourcemap: true,
  target: ['es2020'],
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  treeShaking: true,
};

await build({
  ...shared,
  format: 'esm',
  outfile: join(distDir, 'index.mjs'),
});

await build({
  ...shared,
  format: 'cjs',
  outfile: join(distDir, 'index.cjs'),
});

// Emit declarations via tsc.
execSync('npx -y --no-install tsc -p tsconfig.build.json', {
  cwd: pkgRoot,
  stdio: 'inherit',
});

// Size guardrail — 2 KB gzipped is the issue #177 budget for the ESM
// bundle (CJS is for legacy consumers and is not size-constrained).
const esmPath = join(distDir, 'index.mjs');
const rawBytes = statSync(esmPath).size;
const gzippedBytes = gzipSync(readFileSync(esmPath)).length;
const KB = (n) => `${(n / 1024).toFixed(2)} KB`;
console.log(`@aurapix/embed bundle: raw ${KB(rawBytes)}, gzipped ${KB(gzippedBytes)}`);
const BUDGET = 2 * 1024;
if (gzippedBytes > BUDGET) {
  console.error(
    `❌ @aurapix/embed exceeds 2 KB gzipped budget (got ${KB(gzippedBytes)}).`
  );
  process.exit(1);
}
