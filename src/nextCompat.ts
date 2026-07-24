/**
 * Pure Next/Vite/React compatibility helpers for Kexari Lens.
 * No vscode dependency — unit-tested from scripts/test-next-compat.mjs.
 */
import * as fs from 'fs';
import * as path from 'path';

export const MARKER = '@kexari-lens-dev';
export const PKG_NAME = '@kexari-lens/dev';

export type ProjectKind = 'next' | 'vite' | 'unknown';

export interface FrameworkVersions {
  nextVersion: string | null;
  nextMajor: number | null;
  reactVersion: string | null;
  reactMajor: number | null;
  source: 'node_modules' | 'package.json' | 'none';
}

export interface CompatPlan {
  kind: ProjectKind;
  versions: FrameworkVersions;
  /** Always webpack/vite plugin — never Turbopack loader rules (caused .tsx.tsx). */
  bundlerIntegration: 'webpack' | 'vite' | 'none';
  /** Next 16+ (Turbopack default) or any project already on --turbo must use --webpack. */
  forceWebpackDevFlag: boolean;
  /** Next 16+ needs empty `turbopack: {}` so `next build` doesn't fail with webpack(). */
  emptyTurbopackKey: boolean;
  /** React 19+ cannot rely on Fiber _debugSource. */
  compilePluginRequired: boolean;
  summary: string;
  userNotes: string[];
}

function parseMajor(raw: string | null | undefined): number | null {
  if (!raw) {
    return null;
  }
  const match = String(raw).match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function readJson(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Prefer installed package versions over semver ranges in package.json. */
export function detectFrameworkVersions(root: string): FrameworkVersions {
  const installedNext = path.join(root, 'node_modules', 'next', 'package.json');
  const installedReact = path.join(root, 'node_modules', 'react', 'package.json');

  let nextVersion: string | null = null;
  let reactVersion: string | null = null;
  let source: FrameworkVersions['source'] = 'none';

  if (fs.existsSync(installedNext)) {
    nextVersion = readJson(installedNext)?.version || null;
    source = 'node_modules';
  }
  if (fs.existsSync(installedReact)) {
    reactVersion = readJson(installedReact)?.version || null;
    source = 'node_modules';
  }

  if (!nextVersion || !reactVersion) {
    const pkg = readJson(path.join(root, 'package.json'));
    if (pkg) {
      source = source === 'none' ? 'package.json' : source;
      if (!nextVersion) {
        nextVersion = pkg.dependencies?.next || pkg.devDependencies?.next || null;
      }
      if (!reactVersion) {
        reactVersion = pkg.dependencies?.react || pkg.devDependencies?.react || null;
      }
    }
  }

  return {
    nextVersion,
    nextMajor: parseMajor(nextVersion),
    reactVersion,
    reactMajor: parseMajor(reactVersion),
    source
  };
}

export function readDevScript(root: string): string | null {
  const pkg = readJson(path.join(root, 'package.json'));
  const dev = pkg?.scripts?.dev;
  return typeof dev === 'string' ? dev : null;
}

export function scriptUsesNextTurbo(devScript: string | null): boolean {
  if (!devScript) {
    return false;
  }
  return /--turbopack\b/.test(devScript) || /--turbo\b/.test(devScript);
}

export function scriptUsesWebpack(devScript: string | null): boolean {
  if (!devScript) {
    return false;
  }
  return /\bnext\s+dev\b/.test(devScript) && /--webpack\b/.test(devScript);
}

/**
 * Single source of truth for how Lens should integrate with this app.
 */
export function buildCompatPlan(
  kind: ProjectKind,
  versions: FrameworkVersions,
  devScript: string | null
): CompatPlan {
  const userNotes: string[] = [];

  if (kind === 'vite') {
    return {
      kind,
      versions,
      bundlerIntegration: 'vite',
      forceWebpackDevFlag: false,
      emptyTurbopackKey: false,
      compilePluginRequired: (versions.reactMajor ?? 19) >= 19,
      summary: 'Vite + @kexari-lens/dev vite plugin',
      userNotes: [
        'Vite: Lens wraps the config with withKexariVite(...) (dev-only transform; never rewrites plugins: []).'
      ]
    };
  }

  if (kind === 'unknown') {
    return {
      kind,
      versions,
      bundlerIntegration: 'none',
      forceWebpackDevFlag: false,
      emptyTurbopackKey: false,
      compilePluginRequired: false,
      summary: 'Unknown stack — preview only, no file-path plugin',
      userNotes: ['Open a Next.js or Vite React app for exact file paths.']
    };
  }

  const nextMajor = versions.nextMajor;
  const reactMajor = versions.reactMajor;
  const onTurboScript = scriptUsesNextTurbo(devScript);
  const forceWebpackDevFlag =
    (nextMajor !== null && nextMajor >= 16) || onTurboScript;
  const emptyTurbopackKey = nextMajor !== null && nextMajor >= 16;
  const compilePluginRequired = reactMajor === null || reactMajor >= 19;

  userNotes.push(
    'Install wraps your Next config with withKexariLens(...) — it never edits your webpack() body (that caused `dev is not defined` and similar per-project breaks).'
  );

  if (nextMajor !== null && nextMajor >= 16) {
    userNotes.push(
      'Next.js 16+ defaults to Turbopack. Lens uses `next dev --webpack`; withKexariLens adds the webpack plugin + empty turbopack at runtime (no Turbopack loader rules).'
    );
  } else if (onTurboScript) {
    userNotes.push(
      'Your `dev` script uses Turbopack (`--turbo` / `--turbopack`). Lens switches it to `--webpack` so path injection works.'
    );
  } else {
    userNotes.push(
      'Next.js 13–15: withKexariLens wires the webpack plugin only. Default `next dev` already uses webpack.'
    );
  }

  if (compilePluginRequired) {
    userNotes.push(
      'React 19+: Fiber `_debugSource` is gone — `@kexari-lens/dev` is required for file:line.'
    );
  } else {
    userNotes.push(
      'React 17/18: Fiber paths are a fallback; the compile plugin still improves reliability on Next.'
    );
  }

  userNotes.push(
    'The webpack plugin only injects when `dev` is true — production builds stay clean.'
  );

  return {
    kind: 'next',
    versions,
    bundlerIntegration: 'webpack',
    forceWebpackDevFlag,
    emptyTurbopackKey,
    compilePluginRequired,
    summary: forceWebpackDevFlag
      ? `Next ${nextMajor ?? '?'} → webpack plugin + next dev --webpack`
      : `Next ${nextMajor ?? '?'} → webpack plugin`,
    userNotes
  };
}

export function alreadyConfigured(content: string): boolean {
  return (
    content.includes(PKG_NAME) ||
    content.includes('withKexariLens') ||
    content.includes('withKexariVite') ||
    content.includes('kexariLens(') ||
    content.includes(MARKER) ||
    content.includes('@kexari-lens-dev-begin')
  );
}

/** Preferred: config wrapped with withKexariLens(...). */
export function hasWebpackHook(content: string): boolean {
  return /withKexariLens\s*\(/.test(content);
}

/** Preferred: config wrapped with withKexariVite(...). */
export function hasViteHook(content: string): boolean {
  return /withKexariVite\s*\(/.test(content);
}

/** Prod-safe optional loader (try/catch + identity fallback). */
export function hasOptionalKexariLoader(content: string): boolean {
  return (
    content.includes('@kexari-lens-dev-begin') ||
    /let\s+withKexari(?:Lens|Vite)\s*=\s*\(\s*config\s*\)\s*=>\s*config/.test(content)
  );
}

/** Static ESM/CJS import of the package — breaks Vercel/CI when .kexari is absent. */
export function hasStaticKexariImport(content: string): boolean {
  if (hasOptionalKexariLoader(content)) {
    return false;
  }
  return (
    /import\s*\{[^}]*\}\s*from\s*['"]@kexari-lens\/dev['"]/.test(content) ||
    /(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(['"]@kexari-lens\/dev['"]\)/.test(content)
  );
}

/** Legacy inline injects that caused project-specific breakages. */
export function hasLegacyInlineInject(content: string): boolean {
  return (
    /kexariLens\(\s*\{\s*bundler:\s*['"]webpack['"]/.test(content) ||
    /kexariLens\(\s*\{\s*bundler:\s*['"]vite['"]/.test(content) ||
    /kexariLensTurbopackRules\s*\(/.test(content)
  );
}

/** Any Kexari turbopack.rules / experimental.turbo wiring — unsafe, must be removed. */
export function hasBrokenKexariTurbopackRules(content: string): boolean {
  return (
    /kexariLensTurbopackRules\s*\(/.test(content) ||
    /kexariLens\(\s*\{\s*bundler:\s*['"]turbopack['"]/.test(content)
  );
}

/**
 * Remove ALL legacy Kexari edits from configs so we can re-apply the safe wrapper.
 * Does not remove the user's own webpack()/plugins code — only Lens-injected lines.
 */
export function stripLegacyKexariEdits(content: string): string {
  let next = stripKexariTurbopackRules(content);

  // Our empty turbopack: {} marker block
  next = next.replace(
    /\n?[ \t]*\/\/[^\n]*@kexari-lens-dev[^\n]*\n[ \t]*turbopack:\s*\{\s*\},?/g,
    ''
  );

  // Inline webpack inject
  next = next.replace(
    /\n?[ \t]*\/\/\s*@kexari-lens-dev\s*\n[ \t]*if\s*\(\s*(?:options\.)?dev\s*\)\s*\{\s*config\.plugins\.push\(\s*kexariLens\(\s*\{\s*bundler:\s*['"]webpack['"]\s*\}\s*\)\s*\);\s*\}\s*\n?/g,
    '\n'
  );

  // Vite plugin lines inside plugins: [...]
  next = next.replace(
    /\n?[ \t]*kexariLens\(\s*\{\s*bundler:\s*['"]vite['"]\s*\}\s*\)\s*,?[ \t]*\/\/[^\n]*\n?/g,
    '\n'
  );
  next = next.replace(
    /\n?[ \t]*kexariLens\(\s*\{\s*bundler:\s*['"]vite['"]\s*\}\s*\)\s*,?\s*\n?/g,
    '\n'
  );

  // Optional loader block (re-added cleanly by ensureOptionalWrapper)
  next = next.replace(
    /\n?\/\/\s*@kexari-lens-dev-begin\n[\s\S]*?\/\/\s*@kexari-lens-dev-end\n?/g,
    '\n'
  );

  // Drop static @kexari-lens/dev imports (breaks CI when package is local-only)
  next = next.replace(
    /import\s*\{[^}]*\}\s*from\s*['"]@kexari-lens\/dev['"]\s*;?[^\n]*\n?/g,
    ''
  );
  next = next.replace(
    /(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(['"]@kexari-lens\/dev['"]\)\s*;?[^\n]*\n?/g,
    ''
  );

  return next;
}

/**
 * Remove broken Kexari turbopack loader rules (caused Next 16 `page.tsx.tsx`).
 * Preserves unrelated turbopack config when possible.
 */
export function stripKexariTurbopackRules(content: string): string {
  let next = content;

  next = next.replace(
    /\n?[ \t]*\/\/[^\n]*@kexari-lens-dev[^\n]*\n[ \t]*turbopack:\s*\{\s*rules:\s*\{\s*\.\.\.kexariLensTurbopackRules\(\),\s*\},?\s*\},?/g,
    ''
  );
  next = next.replace(
    /turbopack:\s*\{\s*rules:\s*\{\s*\.\.\.kexariLensTurbopackRules\(\),\s*\},?\s*\},?/g,
    ''
  );
  next = next.replace(
    /\n?[ \t]*\/\/[^\n]*@kexari-lens-dev[^\n]*\n[ \t]*turbo:\s*\{\s*rules:\s*\{\s*\.\.\.kexariLensTurbopackRules\(\)\s*\},?\s*\},?/g,
    ''
  );
  next = next.replace(
    /turbo:\s*\{\s*rules:\s*\{\s*\.\.\.kexariLensTurbopackRules\(\)\s*\},?\s*\},?/g,
    ''
  );
  next = next.replace(/\.\.\.kexariLensTurbopackRules\(\),?\s*/g, '');
  next = next.replace(/\n?[ \t]*experimental:\s*\{\s*\},?/g, '');
  return next;
}

/**
 * Wrap `export default X` / `module.exports = X` with withKexariLens / withKexariVite.
 * Never edits webpack() or plugins bodies.
 */
export function wrapDefaultExport(
  content: string,
  wrapper: 'withKexariLens' | 'withKexariVite'
): string {
  if (new RegExp(`${wrapper}\\s*\\(`).test(content)) {
    return content;
  }

  // export default nextConfig;
  if (/export\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$/m.test(content)) {
    return content.replace(
      /export\s+default\s+([A-Za-z_$][\w$]*)(\s*;?)/,
      `export default ${wrapper}($1)$2`
    );
  }

  // module.exports = nextConfig;
  if (/module\.exports\s*=\s*[A-Za-z_$][\w$]*\s*;?\s*$/m.test(content)) {
    return content.replace(
      /module\.exports\s*=\s*([A-Za-z_$][\w$]*)(\s*;?)/,
      `module.exports = ${wrapper}($1)$2`
    );
  }

  // export default defineConfig({ ... })
  if (/export\s+default\s+defineConfig\s*\(/.test(content)) {
    let next = content.replace(
      /export\s+default\s+defineConfig\s*\(/,
      `export default ${wrapper}(defineConfig(`
    );
    // Close the extra wrapper paren: ...})  →  ...}))
    next = next.replace(/\}\)(\s*;?\s*)$/, `}))$1`);
    return next;
  }

  // export default { ... }
  if (/export\s+default\s*\{/.test(content)) {
    let next = content.replace(/export\s+default\s*\{/, `export default ${wrapper}({`);
    next = next.replace(/\}(\s*;?\s*)$/, `})$1`);
    return next;
  }

  // module.exports = { ... }
  if (/module\.exports\s*=\s*\{/.test(content)) {
    let next = content.replace(/module\.exports\s*=\s*\{/, `module.exports = ${wrapper}({`);
    next = next.replace(/\}(\s*;?\s*)$/, `})$1`);
    return next;
  }

  return content;
}

/**
 * Find the opening `{` of the primary Next config object across common shapes:
 *   const nextConfig = {
 *   const nextConfig: NextConfig = {
 *   export default {
 *   export default defineConfig({
 *   module.exports = {
 */
function findNextConfigObjectOpen(content: string): { index: number; openBrace: number } | null {
  const patterns: RegExp[] = [
    /(?:const|let|var)\s+nextConfig(?:\s*:\s*[^=;{]+)?\s*=\s*\{/,
    /(?:const|let|var)\s+config(?:\s*:\s*[^=;{]+)?\s*=\s*\{/,
    /export\s+default\s+defineConfig\s*\(\s*\{/,
    /export\s+default\s*\{/,
    /module\.exports\s*=\s*\{/,
    /export\s*=\s*\{/
  ];

  for (const re of patterns) {
    const m = content.match(re);
    if (m && m.index !== undefined) {
      const openBrace = m.index + m[0].lastIndexOf('{');
      return { index: m.index, openBrace };
    }
  }

  // export default nextConfig;  → find declaration of that identifier
  const exportIdent = content.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/);
  if (exportIdent) {
    const name = exportIdent[1];
    const decl = new RegExp(
      `(?:const|let|var)\\s+${name}(?:\\s*:\\s*[^=;{]+)?\\s*=\\s*\\{`
    );
    const m = content.match(decl);
    if (m && m.index !== undefined) {
      const openBrace = m.index + m[0].lastIndexOf('{');
      return { index: m.index, openBrace };
    }
  }

  return null;
}

function insertAfterConfigOpen(content: string, block: string): string | null {
  const found = findNextConfigObjectOpen(content);
  if (!found) {
    return null;
  }
  return content.slice(0, found.openBrace + 1) + `\n${block}` + content.slice(found.openBrace + 1);
}

export function ensureEmptyTurbopackConfig(content: string): string {
  if (/turbopack\s*:\s*\{/.test(content)) {
    return content;
  }
  const block = `  // ${MARKER}: empty turbopack so Next 16 \`next build\` works while Lens uses \`next dev --webpack\`\n  turbopack: {},`;
  const inserted = insertAfterConfigOpen(content, block);
  if (inserted) {
    return inserted;
  }

  // Last resort: leave a clear marker — caller may still accept webpack-only wiring.
  return (
    content +
    `\n\n/* ${MARKER}: add  turbopack: {}  to your Next config object (required on Next 16+ when webpack() is present) */\n`
  );
}

/**
 * Insert a prod-safe optional loader:
 *   let withKexariLens = (config) => config;
 *   try { withKexariLens = require(...).withKexariLens } catch {}
 * Never uses a static import of @kexari-lens/dev (that breaks Vercel/CI).
 */
export function ensureOptionalWrapper(
  content: string,
  wrapper: 'withKexariLens' | 'withKexariVite',
  isEsm: boolean
): string {
  if (hasOptionalKexariLoader(content) && content.includes(`let ${wrapper}`)) {
    return content;
  }

  const cjsBlock = `// @kexari-lens-dev-begin
// Local-only: identity no-op when @kexari-lens/dev is missing (CI / Vercel / prod install)
let ${wrapper} = (config) => config;
try { ${wrapper} = require('@kexari-lens/dev').${wrapper}; } catch (_) {
  try { ${wrapper} = require('./.kexari/kexari-lens-dev').${wrapper}; } catch (_) {}
}
// @kexari-lens-dev-end
`;

  const esmBlock = `// @kexari-lens-dev-begin
import { createRequire as __kexariCreateRequire } from 'module';
const __kexariRequire = __kexariCreateRequire(import.meta.url);
// Local-only: identity no-op when @kexari-lens/dev is missing (CI / Vercel / prod install)
let ${wrapper} = (config) => config;
try { ${wrapper} = __kexariRequire('@kexari-lens/dev').${wrapper}; } catch (_) {
  try { ${wrapper} = __kexariRequire('./.kexari/kexari-lens-dev').${wrapper}; } catch (_) {}
}
// @kexari-lens-dev-end
`;

  const block = isEsm ? esmBlock : cjsBlock;

  // Prefer after the last top-level import / require line
  const importMatch = content.match(
    /^(?:(?:import[\s\S]*?from\s+['"][^'"]+['"];?\s*)|(?:(?:const|let|var)\s+.*?=\s*require\([^)]+\);?\s*))+/m
  );
  if (importMatch && importMatch.index !== undefined) {
    const end = importMatch.index + importMatch[0].length;
    return content.slice(0, end) + '\n' + block + content.slice(end);
  }
  return block + content;
}

/**
 * Safe Next config patch using withKexariLens() wrapper.
 * Never edits the project's webpack() body. Never static-imports the package.
 */
export function patchNextConfig(content: string, _plan: CompatPlan): string {
  const isEsm =
    /\bexport\s+default\b/.test(content) ||
    /\bimport\s+/.test(content) ||
    content.includes('import.meta');

  let next = stripLegacyKexariEdits(content);
  next = ensureOptionalWrapper(next, 'withKexariLens', isEsm);
  next = wrapDefaultExport(next, 'withKexariLens');
  return next;
}

/**
 * Safe Vite config patch using withKexariVite() wrapper.
 * Never rewrites plugins: [react()] one-liners. Never static-imports the package.
 */
export function patchViteConfig(content: string): string {
  const isEsm =
    /\bexport\s+default\b/.test(content) ||
    /\bimport\s+/.test(content) ||
    content.includes('import.meta') ||
    true;

  let next = stripLegacyKexariEdits(content);
  next = ensureOptionalWrapper(next, 'withKexariVite', isEsm);
  next = wrapDefaultExport(next, 'withKexariVite');
  return next;
}

export function validatePatchedNextConfig(content: string, _plan: CompatPlan): string[] {
  const errors: string[] = [];
  if (hasBrokenKexariTurbopackRules(content)) {
    errors.push('Patched config still contains kexariLensTurbopackRules (unsafe).');
  }
  if (hasStaticKexariImport(content)) {
    errors.push(
      'Static import of @kexari-lens/dev breaks CI/prod — use the optional try/catch loader.'
    );
  }
  if (!hasOptionalKexariLoader(content)) {
    errors.push('Patched config is missing the optional Kexari loader (prod-safe try/catch).');
  }
  if (!hasWebpackHook(content)) {
    errors.push('Patched config is missing withKexariLens(...) wrapper.');
  }
  if (
    /webpack\s*:\s*(?:async\s*)?\(\s*[\w$]+\s*\)\s*(?:=>)?\s*\{/.test(content) &&
    /if\s*\(\s*dev\s*\)/.test(content) &&
    !/webpack\s*:\s*(?:async\s*)?\(\s*[\w$]+\s*,/.test(content)
  ) {
    errors.push(
      'webpack() references `dev` but only takes (config) — must be (config, { dev }).'
    );
  }
  return errors;
}

export function blockingPatchErrors(errors: string[]): string[] {
  return errors.filter((e) => !e.includes('turbopack: {}'));
}

export function validatePatchedViteConfig(content: string): string[] {
  const errors: string[] = [];
  if (hasStaticKexariImport(content)) {
    errors.push(
      'Static import of @kexari-lens/dev breaks CI/prod — use the optional try/catch loader.'
    );
  }
  if (!hasOptionalKexariLoader(content)) {
    errors.push('Patched Vite config is missing the optional Kexari loader (prod-safe try/catch).');
  }
  if (!hasViteHook(content)) {
    errors.push('Patched Vite config is missing withKexariVite(...) wrapper.');
  }
  if (/@kexari-lens-dev[A-Za-z_$]/.test(content)) {
    errors.push('Patched Vite config looks syntactically corrupted (comment glued to code).');
  }
  const opens = (content.match(/\{/g) || []).length;
  const closes = (content.match(/\}/g) || []).length;
  if (opens !== closes) {
    errors.push('Patched Vite config has unbalanced braces.');
  }
  return errors;
}

export function applyWebpackDevScript(devScript: string): string {
  if (!/\bnext\s+dev\b/.test(devScript)) {
    return devScript;
  }
  if (/--webpack\b/.test(devScript)) {
    return devScript.replace(/\s*--turbopack\b/g, '').replace(/\s*--turbo\b/g, '');
  }
  let updated = devScript
    .replace(/\s*--turbopack\b/g, '')
    .replace(/\s*--turbo\b/g, '')
    .replace(/\bnext\s+dev\b/, 'next dev --webpack');
  updated = updated.replace(/(--webpack\b)(\s+--webpack\b)+/g, '--webpack');
  return updated;
}

export function isNextConfigReady(
  content: string,
  plan: CompatPlan,
  devScript: string | null
): boolean {
  if (hasBrokenKexariTurbopackRules(content)) {
    return false;
  }
  if (hasStaticKexariImport(content)) {
    return false;
  }
  if (hasLegacyInlineInject(content) && !hasWebpackHook(content)) {
    return false;
  }
  if (!hasWebpackHook(content) || !hasOptionalKexariLoader(content)) {
    return false;
  }
  if (plan.forceWebpackDevFlag && !scriptUsesWebpack(devScript)) {
    return false;
  }
  return true;
}
