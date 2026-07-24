/**
 * Compatibility matrix tests for Next/Vite config patching.
 * Run: npm run test:compat
 */
import * as esbuild from 'esbuild';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outFile = resolve(root, 'out', 'nextCompat.test.cjs');

mkdirSync(resolve(root, 'out'), { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, 'src', 'nextCompat.ts')],
  outfile: outFile,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  bundle: true
});

const require = createRequire(import.meta.url);
const compat = require(outFile);

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('\n── Compat plans ──');
{
  const v16 = {
    nextVersion: '16.2.2',
    nextMajor: 16,
    reactVersion: '18.3.1',
    reactMajor: 18,
    source: 'package.json'
  };
  const plan16 = compat.buildCompatPlan('next', v16, 'next dev');
  assert(plan16.forceWebpackDevFlag === true, 'Next 16 forces --webpack');
  assert(plan16.emptyTurbopackKey === true, 'Next 16 needs empty turbopack key');
  assert(plan16.bundlerIntegration === 'webpack', 'Next 16 uses webpack integration');

  const v15 = {
    nextVersion: '15.1.12',
    nextMajor: 15,
    reactVersion: '19.1.0',
    reactMajor: 19,
    source: 'package.json'
  };
  const plan15 = compat.buildCompatPlan('next', v15, 'next dev');
  assert(plan15.forceWebpackDevFlag === false, 'Next 15 default does not force --webpack');
  assert(plan15.emptyTurbopackKey === false, 'Next 15 does not need empty turbopack key');
  assert(plan15.compilePluginRequired === true, 'React 19 requires compile plugin');

  const plan15turbo = compat.buildCompatPlan('next', v15, 'next dev --turbopack');
  assert(plan15turbo.forceWebpackDevFlag === true, 'Next 15 --turbopack forces --webpack');

  const planVite = compat.buildCompatPlan(
    'vite',
    { nextVersion: null, nextMajor: null, reactVersion: '18.2.0', reactMajor: 18, source: 'none' },
    'vite'
  );
  assert(planVite.bundlerIntegration === 'vite', 'Vite uses vite plugin');
}

console.log('\n── Strip legacy edits ──');
{
  const broken = `import { kexariLens, kexariLensTurbopackRules } from '@kexari-lens/dev'; // @kexari-lens-dev
const nextConfig = {
  turbopack: {
    rules: {
      ...kexariLensTurbopackRules(),
    },
  },
  webpack: (config, { dev }) => {
    // @kexari-lens-dev
    if (dev) { config.plugins.push(kexariLens({ bundler: 'webpack' })); }
    return config;
  },
};
export default nextConfig;
`;
  const stripped = compat.stripLegacyKexariEdits(broken);
  assert(!compat.hasBrokenKexariTurbopackRules(stripped), 'strips kexariLensTurbopackRules');
  assert(!stripped.includes('...kexariLensTurbopackRules'), 'no spread residue');
  assert(!stripped.includes("bundler: 'webpack'"), 'strips inline webpack inject');
  assert(!stripped.includes('@kexari-lens/dev'), 'strips old import');
}

console.log('\n── Patch Next via withKexariLens wrapper ──');
{
  const bare = `/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
};
export default nextConfig;
`;

  const plan15 = compat.buildCompatPlan(
    'next',
    { nextVersion: '15.1.0', nextMajor: 15, reactVersion: '19.0.0', reactMajor: 19, source: 'package.json' },
    'next dev'
  );
  const patched15 = compat.patchNextConfig(bare, plan15);
  assert(patched15.includes('withKexariLens'), 'Next 15 patch uses withKexariLens');
  assert(patched15.includes('@kexari-lens-dev-begin'), 'Next 15 uses optional loader');
  assert(!/import\s*\{[^}]*\}\s*from\s*['"]@kexari-lens\/dev['"]/.test(patched15), 'Next 15 has no static import');
  assert(/export\s+default\s+withKexariLens\s*\(\s*nextConfig\s*\)/.test(patched15), 'Next 15 wraps export');
  assert(!compat.hasBrokenKexariTurbopackRules(patched15), 'Next 15 patch has no turbo rules');
  assert(!/webpack\s*:\s*\(/.test(patched15), 'Next 15 bare config does not invent webpack()');
  assert(compat.validatePatchedNextConfig(patched15, plan15).length === 0, 'Next 15 patch validates');

  const plan16 = compat.buildCompatPlan(
    'next',
    { nextVersion: '16.2.2', nextMajor: 16, reactVersion: '18.3.1', reactMajor: 18, source: 'package.json' },
    'next dev'
  );
  const patched16 = compat.patchNextConfig(bare, plan16);
  assert(compat.hasWebpackHook(patched16), 'Next 16 patch adds withKexariLens');
  // turbopack: {} is applied at runtime inside withKexariLens — not written into the file
  assert(!/turbopack\s*:\s*\{/.test(patched16), 'Next 16 file patch does not inject turbopack key');
  assert(!compat.hasBrokenKexariTurbopackRules(patched16), 'Next 16 patch has no turbo rules');
  assert(compat.validatePatchedNextConfig(patched16, plan16).length === 0, 'Next 16 patch validates');

  // TypeScript annotated config
  const tsConfig = `import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  images: { unoptimized: true },
};
export default nextConfig;
`;
  const patchedTs = compat.patchNextConfig(tsConfig, plan16);
  assert(/export\s+default\s+withKexariLens\s*\(\s*nextConfig\s*\)/.test(patchedTs), 'TS NextConfig wrapped');
  assert(compat.blockingPatchErrors(compat.validatePatchedNextConfig(patchedTs, plan16)).length === 0, 'TS patch has no blocking errors');

  // defineConfig shape
  const defined = `import { defineConfig } from 'something';
export default defineConfig({
  reactStrictMode: true,
});
`;
  const patchedDef = compat.patchNextConfig(defined, plan16);
  assert(/withKexariLens\s*\(\s*defineConfig\s*\(/.test(patchedDef), 'defineConfig wrapped');
  assert(patchedDef.includes('}));') || /withKexariLens\(defineConfig\([\s\S]*\)\)/.test(patchedDef), 'defineConfig wrapper closed');

  // Repair path: broken turbo / inline inject → wrapper (user webpack body untouched)
  const repaired = compat.patchNextConfig(
    `import { kexariLens, kexariLensTurbopackRules } from '@kexari-lens/dev';
const nextConfig = {
  turbopack: { rules: { ...kexariLensTurbopackRules() } },
  webpack: (config, { isServer }) => { return config; },
};
export default nextConfig;`,
    plan16
  );
  assert(!compat.hasBrokenKexariTurbopackRules(repaired), 'repair removes turbo rules');
  assert(compat.hasWebpackHook(repaired), 'repair wraps with withKexariLens');
  assert(/webpack:\s*\(\s*config\s*,\s*\{\s*isServer\s*\}\s*\)/.test(repaired), 'repair leaves user webpack args alone');
  assert(!repaired.includes("bundler: 'webpack'"), 'repair removes inline kexariLens inject');

  // Single-arg webpack must stay single-arg — wrapper owns options.dev
  const singleArg = `import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  webpack: (config) => {
    config.resolve.alias.canvas = false;
    return config;
  },
};
export default nextConfig;
`;
  const patchedSingle = compat.patchNextConfig(singleArg, plan16);
  assert(/webpack:\s*\(\s*config\s*\)\s*=>/.test(patchedSingle), 'single-arg webpack left as (config)');
  assert(!/if\s*\(\s*dev\s*\)/.test(patchedSingle), 'does not inject if (dev) into user webpack');
  assert(compat.hasWebpackHook(patchedSingle), 'single-arg project still gets withKexariLens');
  assert(
    compat.blockingPatchErrors(compat.validatePatchedNextConfig(patchedSingle, plan16)).length === 0,
    'single-arg webpack validates'
  );

  // Repair already-broken: if (dev) with (config) only → strip inject, wrap
  const brokenDev = `import { kexariLens } from '@kexari-lens/dev';
const nextConfig = {
  webpack: (config) => {
    // @kexari-lens-dev
    if (dev) { config.plugins.push(kexariLens({ bundler: 'webpack' })); }
    return config;
  },
};
export default nextConfig;
`;
  const fixedBroken = compat.patchNextConfig(brokenDev, plan16);
  assert(/webpack:\s*\(\s*config\s*\)\s*=>/.test(fixedBroken), 'keeps (config) after repair');
  assert(!/if\s*\(\s*dev\s*\)/.test(fixedBroken), 'strips broken if (dev) inject');
  assert(compat.hasWebpackHook(fixedBroken), 'wraps after stripping broken inject');
}

console.log('\n── Dev script rewrite ──');
{
  assert(compat.applyWebpackDevScript('next dev') === 'next dev --webpack', 'next dev → --webpack');
  assert(
    compat.applyWebpackDevScript('next dev --turbopack') === 'next dev --webpack',
    'strips --turbopack'
  );
  assert(
    compat.applyWebpackDevScript('next dev --webpack') === 'next dev --webpack',
    'idempotent --webpack'
  );
}

console.log('\n── Vite patch via withKexariVite ──');
{
  const oneLine = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`;
  const patched = compat.patchViteConfig(oneLine);
  assert(patched.includes('withKexariVite'), 'vite patch uses withKexariVite');
  assert(patched.includes('@kexari-lens-dev-begin'), 'vite uses optional loader');
  assert(!/import\s*\{[^}]*\}\s*from\s*['"]@kexari-lens\/dev['"]/.test(patched), 'vite has no static import');
  assert(/withKexariVite\s*\(\s*defineConfig\s*\(/.test(patched), 'vite wraps defineConfig');
  assert(patched.includes('plugins: [react()]'), 'vite one-liner plugins untouched');
  assert(!patched.includes("kexariLens({ bundler: 'vite' })"), 'vite does not inline kexariLens');
  assert(!/@kexari-lens-dev[A-Za-z_$]/.test(patched), 'vite patch does not glue comment to code');
  assert(compat.validatePatchedViteConfig(patched).length === 0, 'vite patch validates');

  const multiline = `export default defineConfig({
  plugins: [
    react(),
  ],
})
`;
  const patchedMulti = compat.patchViteConfig(multiline);
  assert(patchedMulti.includes('react()'), 'multiline vite keeps react()');
  assert(compat.hasViteHook(patchedMulti), 'multiline vite wrapped');
  assert(compat.validatePatchedViteConfig(patchedMulti).length === 0, 'multiline vite validates');
}

console.log('\n── Ready checks ──');
{
  const plan16 = compat.buildCompatPlan(
    'next',
    { nextVersion: '16.0.0', nextMajor: 16, reactVersion: '18.0.0', reactMajor: 18, source: 'package.json' },
    'next dev --webpack'
  );
  const good = compat.patchNextConfig(
    `const nextConfig = {};\nexport default nextConfig;\n`,
    plan16
  );
  assert(compat.isNextConfigReady(good, plan16, 'next dev --webpack'), 'ready with --webpack');
  assert(!compat.isNextConfigReady(good, plan16, 'next dev'), 'not ready without --webpack on 16');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (existsSync(outFile)) {
  // keep for debugging; compile will wipe out/
}
if (failed > 0) {
  process.exit(1);
}
