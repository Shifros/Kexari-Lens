import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  PKG_NAME,
  applyWebpackDevScript,
  blockingPatchErrors,
  buildCompatPlan,
  detectFrameworkVersions,
  hasViteHook,
  isNextConfigReady,
  patchNextConfig,
  patchViteConfig,
  readDevScript,
  validatePatchedNextConfig,
  validatePatchedViteConfig,
  type CompatPlan,
  type ProjectKind
} from './nextCompat';

const execFileAsync = promisify(execFile);

/** Portable local vendor — package name is still @kexari-lens/dev. */
const RELATIVE_VENDOR_SPEC = 'file:./.kexari/kexari-lens-dev';
const VENDOR_DIR = path.join('.kexari', 'kexari-lens-dev');

export type { ProjectKind };

export interface EnableResult {
  ok: boolean;
  kind: ProjectKind;
  folder: string;
  message: string;
  alreadyEnabled?: boolean;
  skipped?: boolean;
  repaired?: boolean;
  plan?: CompatPlan;
}

function findWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const match = vscode.workspace.getWorkspaceFolder(active);
    if (match) {
      return match;
    }
  }
  return folders[0];
}

function exists(root: string, rel: string): boolean {
  return fs.existsSync(path.join(root, rel));
}

export function detectProjectKind(root: string): ProjectKind {
  if (
    exists(root, 'next.config.js') ||
    exists(root, 'next.config.mjs') ||
    exists(root, 'next.config.ts') ||
    exists(root, 'next.config.cjs')
  ) {
    return 'next';
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps?.next) {
      return 'next';
    }
    if (
      deps?.vite ||
      exists(root, 'vite.config.ts') ||
      exists(root, 'vite.config.js') ||
      exists(root, 'vite.config.mjs')
    ) {
      return 'vite';
    }
  } catch {
    // ignore
  }
  if (
    exists(root, 'vite.config.ts') ||
    exists(root, 'vite.config.js') ||
    exists(root, 'vite.config.mjs')
  ) {
    return 'vite';
  }
  return 'unknown';
}

/** True when package.json lists @kexari-lens/dev (any spec). */
export function isDevPluginListed(root: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(deps?.[PKG_NAME]);
  } catch {
    return false;
  }
}

/**
 * True when the vendored package files actually exist on disk.
 * package.json can list the dep while .kexari/ is missing (gitignored / cleaned).
 */
export function isDevPluginResolvable(root: string): boolean {
  const vendorPkg = path.join(root, VENDOR_DIR, 'package.json');
  const vendorMain = path.join(root, VENDOR_DIR, 'src', 'index.js');
  if (!fs.existsSync(vendorPkg) || !fs.existsSync(vendorMain)) {
    return false;
  }
  const linkedPkg = path.join(root, 'node_modules', '@kexari-lens', 'dev', 'package.json');
  if (!fs.existsSync(linkedPkg)) {
    return false;
  }
  try {
    fs.readFileSync(linkedPkg, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function findConfigFile(root: string, kind: ProjectKind): string | null {
  const candidates =
    kind === 'next'
      ? ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']
      : kind === 'vite'
        ? ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']
        : [];
  for (const name of candidates) {
    const full = path.join(root, name);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return null;
}

function getBundledPluginPath(extensionPath: string): string {
  const candidates = [
    path.join(extensionPath, 'out', 'kexari-lens-dev'),
    path.join(extensionPath, 'packages', 'kexari-lens-dev')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  throw new Error(
    'Bundled @kexari-lens/dev not found in the extension. Reinstall Kexari Lens.'
  );
}

export function getCompatPlanForRoot(root: string, kind?: ProjectKind): CompatPlan {
  const projectKind = kind || detectProjectKind(root);
  const versions = detectFrameworkVersions(root);
  const devScript = readDevScript(root);
  return buildCompatPlan(projectKind, versions, devScript);
}

/** Listed + resolvable + config/scripts match the compat plan for this Next/Vite version. */
export function isDevPluginReady(root: string, kind?: ProjectKind): boolean {
  const projectKind = kind || detectProjectKind(root);
  if (projectKind === 'unknown') {
    return true;
  }
  if (!isDevPluginListed(root) || !isDevPluginResolvable(root)) {
    return false;
  }
  const configPath = findConfigFile(root, projectKind);
  if (!configPath) {
    return false;
  }
  const content = fs.readFileSync(configPath, 'utf8');
  const plan = getCompatPlanForRoot(root, projectKind);
  if (projectKind === 'next') {
    return isNextConfigReady(content, plan, readDevScript(root));
  }
  return hasViteHook(content);
}

export function hasWebpackDevScript(root: string): boolean {
  const plan = getCompatPlanForRoot(root);
  if (!plan.forceWebpackDevFlag) {
    return true;
  }
  const dev = readDevScript(root);
  return Boolean(dev && /--webpack\b/.test(dev));
}

function ensureGitignoreHasKexari(root: string): void {
  const gitignorePath = path.join(root, '.gitignore');
  const line = '.kexari/';
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${line}\n`, 'utf8');
    return;
  }
  const content = fs.readFileSync(gitignorePath, 'utf8');
  if (/(^|[\r\n])\.kexari\/?(\r?\n|$)/.test(content)) {
    return;
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(
    gitignorePath,
    `${content}${suffix}\n# Kexari Lens local vendor (dev-only)\n${line}\n`,
    'utf8'
  );
}

function vendorPluginIntoProject(root: string, bundledPath: string): void {
  const dest = path.join(root, VENDOR_DIR);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(bundledPath, dest, { recursive: true });
  ensureGitignoreHasKexari(root);
}

function ensureWebpackDevScript(root: string, plan: CompatPlan): boolean {
  if (!plan.forceWebpackDevFlag) {
    return false;
  }
  const pkgPath = path.join(root, 'package.json');
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return false;
  }
  const dev = pkg?.scripts?.dev;
  if (typeof dev !== 'string') {
    return false;
  }
  const updated = applyWebpackDevScript(dev);
  if (updated === dev) {
    return false;
  }
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.dev = updated;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  return true;
}

function installErrorText(err: unknown): string {
  const e = err as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
  const parts = [e?.stderr, e?.stdout, e?.message].map((p) =>
    p == null ? '' : Buffer.isBuffer(p) ? p.toString('utf8') : String(p)
  );
  return parts.filter(Boolean).join('\n');
}

function isPeerResolveError(text: string): boolean {
  return (
    /\bERESOLVE\b/.test(text) ||
    /could not resolve/i.test(text) ||
    /conflicting peer dependency/i.test(text) ||
    /peer dep/i.test(text)
  );
}

async function runPackageManager(
  cmd: string,
  args: string[],
  root: string
): Promise<void> {
  await execFileAsync(cmd, args, {
    cwd: root,
    shell: process.platform === 'win32',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, npm_config_fund: 'false' }
  });
}

/**
 * Add the vendored @kexari-lens/dev. On npm ERESOLVE (common when the app
 * already has unrelated peer conflicts, e.g. react 19 + react-helmet-async),
 * retry with --legacy-peer-deps so Install is not blocked by the host app.
 */
async function npmInstallDevPlugin(root: string): Promise<void> {
  const usePnpm = fs.existsSync(path.join(root, 'pnpm-lock.yaml'));
  const useYarn = fs.existsSync(path.join(root, 'yarn.lock')) && !usePnpm;

  if (usePnpm) {
    try {
      await runPackageManager('pnpm', ['add', '-D', RELATIVE_VENDOR_SPEC], root);
    } catch (err) {
      if (!isPeerResolveError(installErrorText(err))) {
        throw err;
      }
      await runPackageManager(
        'pnpm',
        ['add', '-D', RELATIVE_VENDOR_SPEC, '--config.strict-peer-dependencies=false'],
        root
      );
    }
    return;
  }

  if (useYarn) {
    await runPackageManager('yarn', ['add', '-D', RELATIVE_VENDOR_SPEC], root);
    return;
  }

  try {
    await runPackageManager('npm', ['install', '-D', RELATIVE_VENDOR_SPEC], root);
  } catch (err) {
    const text = installErrorText(err);
    if (!isPeerResolveError(text)) {
      throw err;
    }
    // Host app peer graph is already broken for strict npm — add our file: dep anyway.
    await runPackageManager(
      'npm',
      ['install', '-D', RELATIVE_VENDOR_SPEC, '--legacy-peer-deps'],
      root
    );
  }
}

/**
 * Ask the user, then install / repair @kexari-lens/dev using the version-aware compat plan.
 * Does not start the app — user must run `npm run dev` themselves.
 */
export async function askAndInstallDevPlugin(
  extensionPath: string
): Promise<EnableResult> {
  const folder = findWorkspaceFolder();
  if (!folder) {
    return {
      ok: false,
      kind: 'unknown',
      folder: '',
      message: 'Open your app folder in VS Code / Cursor first.'
    };
  }

  const root = folder.uri.fsPath;
  const kind = detectProjectKind(root);
  const plan = getCompatPlanForRoot(root, kind);

  if (kind === 'unknown') {
    return {
      ok: true,
      kind,
      folder: root,
      skipped: true,
      plan,
      message: 'Not a Next.js/Vite app — connecting without file-path plugin.'
    };
  }

  if (isDevPluginReady(root, kind)) {
    return {
      ok: true,
      kind,
      folder: root,
      alreadyEnabled: true,
      plan,
      message: `@kexari-lens/dev is ready (${plan.summary}). If paths still show Unknown, restart \`npm run dev\` (clear .next if needed), then Connect again.`
    };
  }

  const needsRepair =
    (isDevPluginListed(root) && !isDevPluginResolvable(root)) ||
    (isDevPluginListed(root) && isDevPluginResolvable(root) && !isDevPluginReady(root, kind));

  const versionLine = [
    plan.versions.nextVersion ? `Next ${plan.versions.nextVersion}` : null,
    plan.versions.reactVersion ? `React ${plan.versions.reactVersion}` : null
  ]
    .filter(Boolean)
    .join(' · ');

  const detail = [
    versionLine ? `Detected: ${versionLine}` : null,
    `Strategy: ${plan.summary}`,
    ...plan.userNotes.slice(0, 2)
  ]
    .filter(Boolean)
    .join('\n');

  const choice = await vscode.window.showInformationMessage(
    needsRepair
      ? `Kexari Lens needs a safe repair for this project.\n\n${detail}`
      : `Kexari Lens needs @kexari-lens/dev for exact file paths.\n\n${detail}`,
    { modal: true },
    needsRepair ? 'Repair' : 'Install',
    'Skip'
  );

  if (choice !== 'Install' && choice !== 'Repair') {
    return {
      ok: true,
      kind,
      folder: root,
      skipped: true,
      plan,
      message: 'Skipped plugin install — connecting without exact file paths.'
    };
  }

  const configPath = findConfigFile(root, kind);
  if (!configPath) {
    return {
      ok: false,
      kind,
      folder: root,
      plan,
      message: `No ${kind === 'next' ? 'next.config' : 'vite.config'} found to wire the plugin.`
    };
  }

  try {
    vendorPluginIntoProject(root, getBundledPluginPath(extensionPath));
    await npmInstallDevPlugin(root);

    const original = fs.readFileSync(configPath, 'utf8');
    const patched =
      kind === 'next' ? patchNextConfig(original, plan) : patchViteConfig(original);

    if (kind === 'next') {
      const errors = validatePatchedNextConfig(patched, plan);
      const hard = blockingPatchErrors(errors);
      if (hard.length) {
        return {
          ok: false,
          kind,
          folder: root,
          plan,
          message: `Refusing to write an unsafe Next config:\n${hard.join('\n')}`
        };
      }
    } else if (kind === 'vite') {
      const errors = validatePatchedViteConfig(patched);
      if (errors.length) {
        return {
          ok: false,
          kind,
          folder: root,
          plan,
          message: `Refusing to write an unsafe Vite config:\n${errors.join('\n')}`
        };
      }
    }

    if (patched !== original) {
      const backupPath = configPath + '.kexari-bak';
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, original, 'utf8');
      }
      fs.writeFileSync(configPath, patched, 'utf8');
    }

    let scriptNote = '';
    if (kind === 'next') {
      const scriptChanged = ensureWebpackDevScript(root, plan);
      if (scriptChanged) {
        scriptNote = ' Updated `npm run dev` to use `--webpack`.';
      } else if (plan.forceWebpackDevFlag && hasWebpackDevScript(root)) {
        scriptNote = ' `npm run dev` already uses `--webpack`.';
      } else if (plan.forceWebpackDevFlag) {
        scriptNote =
          ' Could not auto-update `dev` script — add `--webpack` to `next dev` manually.';
      }
    }

    if (!isDevPluginResolvable(root)) {
      return {
        ok: false,
        kind,
        folder: root,
        plan,
        message:
          'Install finished but @kexari-lens/dev still cannot be resolved. Check that .kexari/kexari-lens-dev exists.'
      };
    }

    return {
      ok: true,
      kind,
      folder: root,
      repaired: needsRepair,
      plan,
      message: needsRepair
        ? `Repaired @kexari-lens/dev (${plan.summary}).${scriptNote} Restart \`npm run dev\`, then Connect again.`
        : `Installed @kexari-lens/dev (${plan.summary}).${scriptNote} Restart \`npm run dev\`, then Connect again.`
    };
  } catch (err: unknown) {
    const detailMsg = installErrorText(err);
    const peerHint = isPeerResolveError(detailMsg)
      ? '\n\nThis looks like an existing peer-dependency conflict in the app (not caused by Lens). Try: npm install -D file:./.kexari/kexari-lens-dev --legacy-peer-deps'
      : '';
    return {
      ok: false,
      kind,
      folder: root,
      plan,
      message: `Install failed: ${detailMsg}${peerHint}`
    };
  }
}

/** Manual command palette / sidebar Enable. */
export async function enableDevPluginForWorkspace(
  extensionPath: string
): Promise<EnableResult> {
  return askAndInstallDevPlugin(extensionPath);
}
