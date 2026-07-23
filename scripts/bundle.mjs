import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'out');

// 0. Clean old output
if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

// 1. Bundle extension code (TypeScript → single out/extension.js)
await esbuild.build({
  entryPoints: [resolve(root, 'src', 'extension.ts')],
  bundle: true,
  outfile: resolve(outDir, 'extension.js'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: [
    'vscode',
    'express',
    'http-proxy-middleware',
  ],
  sourcemap: true,
  minify: false,
  treeShaking: true,
  loader: {
    '.node': 'copy',
  },
});

// 2. Copy runtime assets that the proxy / webviews need at runtime
const assets = [
  ['src/inspector.js', 'out/inspector.js'],
  ['src/webview.html', 'out/webview.html'],
  ['src/sidebar.html', 'out/sidebar.html'],
];

for (const [src, dest] of assets) {
  const srcPath = resolve(root, src);
  const destPath = resolve(root, dest);
  if (existsSync(srcPath)) {
    copyFileSync(srcPath, destPath);
    console.log(`  ✓ Copied ${src} → ${dest}`);
  } else {
    console.warn(`  ⚠ Missing asset: ${src}`);
  }
}

// 3. Vendor @kexari-lens/dev into out/ for one-click enable (no npm publish required)
const pluginSrc = resolve(root, 'packages', 'kexari-lens-dev');
const pluginDest = resolve(outDir, 'kexari-lens-dev');
if (existsSync(pluginSrc)) {
  cpSync(pluginSrc, pluginDest, {
    recursive: true,
    filter: (src) => {
      const base = src.replace(/\\/g, '/');
      return !base.includes('/node_modules') && !base.includes('/test');
    }
  });
  console.log('  ✓ Vendored packages/kexari-lens-dev → out/kexari-lens-dev');
} else {
  console.warn('  ⚠ Missing packages/kexari-lens-dev — one-click enable will fail');
}

console.log('\n✅ Bundle complete — out/extension.js + runtime assets');
