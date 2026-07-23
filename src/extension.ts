import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { startProxyServer, ProxyServerInstance } from './proxy';
import { resolveInspectedSource } from './resolveSource';
import { SidebarViewProvider, SessionInfo } from './sidebar';
import {
  askAndInstallDevPlugin,
  detectProjectKind,
  enableDevPluginForWorkspace,
  getCompatPlanForRoot,
  isDevPluginListed,
  isDevPluginReady,
  isDevPluginResolvable
} from './enableDevPlugin';

const LAST_TARGET_KEY = 'kexariLens.lastTargetUrl';
const DEFAULT_TARGET_URL = 'http://localhost:3000';


interface KexariSession {
  panel: vscode.WebviewPanel;
  proxy: ProxyServerInstance;
  proxyUrl: string;
  targetUrl: string;
  /** Last inspected element in this panel — Code opens the same resolved path as the clipboard. */
  lastJumpTarget: any;
  /** Bumps on every inspect so stale async resolves cannot overwrite the jump target. */
  latestInspectId: number;
}

/** One session per dev-server target, keyed by normalized target URL — lets you inspect several ports/projects at once. */
const sessions = new Map<string, KexariSession>();

/** Tracks which session last had an element inspected — CSS sidebar actions target this. */
let activeCssSession: KexariSession | undefined;

/** Stores the last fully-resolved inspect data so "Copy for AI" can regenerate with computed styles. */
let lastInspectedData: any;

export function activate(context: vscode.ExtensionContext) {
  console.log('Kexari Lens extension is now active!');

  // ── Sidebar (settings + launch panel) ──────────────────────────────────
  const sidebarProvider = new SidebarViewProvider(context);

  sidebarProvider.onLaunch = async (rawTargetUrl: string) => {
    const targetUrl = normalizeTargetUrl(rawTargetUrl);
    if (!targetUrl) {
      vscode.window.showErrorMessage('Kexari Lens: Invalid target URL. Enter a port, host:port, or full URL.');
      return;
    }
    await context.globalState.update(LAST_TARGET_KEY, targetUrl);
    await launchSession(context, targetUrl, sidebarProvider);
  };

  sidebarProvider.onFocusSession = (targetUrl: string) => {
    const session = sessions.get(targetUrl);
    if (session) {
      session.panel.reveal(vscode.ViewColumn.Active);
    }
  };

  sidebarProvider.onStopSession = async (targetUrl: string) => {
    const session = sessions.get(targetUrl);
    if (session) {
      session.panel.dispose();
      // panel.onDidDispose handles cleanup + postSessions
    }
  };

  // CSS inspector callbacks — forward sidebar actions to the active session's iframe
  sidebarProvider.onCssApply = (className: string) => {
    if (activeCssSession?.panel) {
      activeCssSession.panel.webview.postMessage({ type: 'KEXARI_LENS_APPLY_CSS', className });
      setTimeout(() => {
        activeCssSession?.panel.webview.postMessage({ type: 'KEXARI_LENS_REFRESH_STYLES' });
      }, 200);
    }
  };
  sidebarProvider.onCssReset = () => {
    if (activeCssSession?.panel) {
      activeCssSession.panel.webview.postMessage({ type: 'KEXARI_LENS_RESET_CSS' });
      setTimeout(() => {
        activeCssSession?.panel.webview.postMessage({ type: 'KEXARI_LENS_REFRESH_STYLES' });
      }, 200);
    }
  };
  sidebarProvider.onCssCopyAi = async () => {
    // Regenerate full AI prompt from last inspected data
    if (lastInspectedData && lastInspectedData.targets.length > 0) {
      const resolvedTargets = lastInspectedData.resolvedTargets;
      const mode = lastInspectedData.mode;
      const viewport = lastInspectedData.viewport;
      const template = vscode.workspace.getConfiguration('kexariLens').get<string>('promptTemplate')
        || '[Kexari Lens Context]\n{{viewportSummary}}Target Component: {{componentName}}{{stackedComponents}}\nFile Path: {{displayPath}}:{{lineNumber}}\nElement: <{{tagName}} className="{{className}}">{{cssStyles}}\n\nInstruction:';

      let formattedPrompt = '';
      if (mode === 'multi' && resolvedTargets.length > 1) {
        const blocks = resolvedTargets.map((t: any, i: number) =>
          resolvePrompt(template, { ...t, mode: 'multi', index: i + 1, viewport })
        ).join('\n\n');
        formattedPrompt = `${blocks}\n\nInstruction:`;
      } else {
        formattedPrompt = resolvePrompt(template, { ...resolvedTargets[0], mode: 'single', index: 1, viewport });
      }
      await vscode.env.clipboard.writeText(formattedPrompt);
      vscode.window.showInformationMessage('Kexari Lens: AI context copied! Paste into any AI tool.');
    }
  };

  sidebarProvider.onEnablePlugin = async () => {
    await runEnablePlugin(context, sidebarProvider);
  };

  // When sidebar is recreated (tab switch), re-push current sessions
  sidebarProvider.onRefresh = () => {
    sidebarProvider.postSessions(buildSessionList());
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // ── Command palette entry (kept for muscle memory) ─────────────────────
  const startCommand = vscode.commands.registerCommand('kexariLens.start', async () => {
    const targetUrl = await promptForTargetUrl(context);
    if (!targetUrl) {
      return;
    }
    await launchSession(context, targetUrl, sidebarProvider);
  });

  const enableCommand = vscode.commands.registerCommand('kexariLens.enableDevPlugin', async () => {
    await runEnablePlugin(context, sidebarProvider);
  });

  context.subscriptions.push(startCommand, enableCommand);
}

export function deactivate() {
  for (const session of sessions.values()) {
    session.proxy.server.close();
  }
  sessions.clear();
}

/** Turns "3002", "localhost:3002", "127.0.0.1:3002" or a full URL into a clean origin. */
function normalizeTargetUrl(raw: string): string | null {
  let value = String(raw || '').trim();
  if (!value) {
    return null;
  }

  if (/^\d{2,5}$/.test(value)) {
    value = `http://localhost:${value}`;
  } else if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Builds the session info list for the sidebar. */
function buildSessionList(): SessionInfo[] {
  const list: SessionInfo[] = [];
  for (const [targetUrl, session] of sessions) {
    list.push({
      targetUrl,
      label: targetUrl.replace(/^https?:\/\//i, '')
    });
  }
  return list;
}

async function runEnablePlugin(
  context: vscode.ExtensionContext,
  sidebarProvider: SidebarViewProvider
): Promise<void> {
  try {
    const result = await enableDevPluginForWorkspace(context.extensionPath);
    if (result.ok && !result.skipped) {
      sidebarProvider.postPluginEnabled(result.message);
      vscode.window.showInformationMessage(`Kexari Lens: ${result.message}`);
    } else if (!result.ok) {
      sidebarProvider.postPluginSetup(result.message);
      vscode.window.showErrorMessage(`Kexari Lens: ${result.message}`);
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Kexari Lens: ${err?.message || err}`);
  }
}

async function handleNeedsPlugin(
  _context: vscode.ExtensionContext,
  sidebarProvider: SidebarViewProvider
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const root = folder?.uri.fsPath;
  const listed = root ? isDevPluginListed(root) : false;
  const resolvable = root ? isDevPluginResolvable(root) : false;

  if (listed && !resolvable) {
    sidebarProvider.postPluginSetup(
      '@kexari-lens/dev is in package.json but files are missing (.kexari).\n\n1. Click Install / Repair\n2. Stop and restart npm run dev\n3. Connect again'
    );
    return;
  }

  if (listed && resolvable && root) {
    const plan = getCompatPlanForRoot(root);
    if (!isDevPluginReady(root)) {
      sidebarProvider.postPluginSetup(
        `Lens wiring is incomplete for this app (${plan.summary}).\n\n1. Click Install / Repair\n2. Restart npm run dev\n3. Connect again`
      );
      return;
    }
    sidebarProvider.postPluginSetup(
      `@kexari-lens/dev is installed (${plan.summary}), but this page has no data-kexari-source yet.\n\n1. Confirm Connect URL is this same project\n2. Stop npm run dev, delete .next, start again\n3. Connect`
    );
    return;
  }

  sidebarProvider.postPluginSetup(
    'Exact file paths need @kexari-lens/dev.\n\n1. Click Install / Repair\n2. Restart npm run dev\n3. Connect again'
  );
}

function isUrlReachable(targetUrl: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const url = new URL(targetUrl);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: '/',
          method: 'GET',
          timeout: timeoutMs
        },
        (res) => {
          res.resume();
          done(true);
        }
      );
      req.on('error', () => done(false));
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.end();
    } catch {
      done(false);
    }
  });
}

/**
 * Before opening the inspector:
 * If Next/Vite and plugin missing → ask to install @kexari-lens/dev.
 * Always open the panel even if the target is still compiling or not up yet —
 * the proxy shows a waiting page that retries automatically.
 */
async function prepareBeforeConnect(
  context: vscode.ExtensionContext,
  targetUrl: string,
  sidebarProvider: SidebarViewProvider
): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const root = folder.uri.fsPath;
    const kind = detectProjectKind(root);
    if ((kind === 'next' || kind === 'vite') && !isDevPluginReady(root, kind)) {
      const result = await askAndInstallDevPlugin(context.extensionPath);
      if (!result.ok) {
        vscode.window.showErrorMessage(`Kexari Lens: ${result.message}`);
        return false;
      }
      if (!result.skipped && !result.alreadyEnabled) {
        sidebarProvider.postPluginEnabled(result.message);
        vscode.window.showInformationMessage(
          result.repaired
            ? 'Kexari Lens: plugin repaired. Restart `npm run dev`, then Connect again.'
            : 'Kexari Lens: plugin installed. Start (or restart) `npm run dev`, then Connect again.'
        );
        return false;
      }
    }
  }

  const up = await isUrlReachable(targetUrl);
  if (!up) {
    // Soft notice only — still open so the user can wait through compile / late start.
    vscode.window.showInformationMessage(
      `Kexari Lens: ${targetUrl} is not responding yet (compiling or not started). Opening anyway — reload when ready.`
    );
  }

  return true;
}

/** Shared logic to create a proxy + webview panel for a given target URL. */
async function launchSession(
  context: vscode.ExtensionContext,
  targetUrl: string,
  sidebarProvider: SidebarViewProvider
): Promise<void> {
  const existing = sessions.get(targetUrl);
  if (existing) {
    existing.panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const ready = await prepareBeforeConnect(context, targetUrl, sidebarProvider);
  if (!ready) {
    return;
  }

  const inspectorScriptPath = path.join(context.extensionPath, 'out', 'inspector.js');
  const label = targetUrl.replace(/^https?:\/\//i, '');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Kexari Lens: Connecting to ${label}...`,
    cancellable: false
  }, async () => {
    try {
      // Port 0 = OS picks a free port, so any number of targets can run side by side.
      const proxy = await startProxyServer(0, targetUrl, inspectorScriptPath);
      const proxyUrl = `http://localhost:${proxy.port}`;

      const panel = vscode.window.createWebviewPanel(
        'kexariLensInspector',
        `Kexari Lens — ${label}`,
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );

      const session: KexariSession = {
        panel,
        proxy,
        proxyUrl,
        targetUrl,
        lastJumpTarget: undefined,
        latestInspectId: 0
      };
      sessions.set(targetUrl, session);

      panel.webview.html = getWebviewContent(context, proxyUrl, label);

      panel.webview.onDidReceiveMessage(
        async (message) => {
          try {
            if (message?.action === 'jump') {
              await jumpToSource(session);
              return;
            }

            if (message?.action === 'needsPlugin') {
              await handleNeedsPlugin(context, sidebarProvider);
              return;
            }

            if (message?.action === 'copyAi') {
              const existing = await vscode.env.clipboard.readText();
              if (existing && existing.includes('[Kexari Lens Context]')) {
                await vscode.env.clipboard.writeText(existing);
                vscode.window.showInformationMessage('Kexari Lens: AI context copied! Paste into your AI tool.');
              } else {
                vscode.window.showWarningMessage('Kexari Lens: Inspect an element first, then use Copy for AI.');
              }
              return;
            }

            if (message?.action === 'stylesRefreshed') {
              // CSS Apply/Reset via sidebar → inspector re-extracted styles → push back to sidebar
              sidebarProvider.postCssData({
                className: message.className || '',
                styles: message.styles || {},
                stylesPrompt: '',
                tagName: '',
                text: ''
              });
              return;
            }

            if (message?.action === 'selectionCleared') {
              sidebarProvider.clearCssData();
              return;
            }

            const payload = message;
            const targets = Array.isArray(payload?.targets)
              ? payload.targets
              : [payload];
            const mode = payload?.mode === 'multi' || targets.length > 1 ? 'multi' : 'single';

            // Forward CSS data to sidebar
            activeCssSession = session;
            const firstTarget = targets[0] || {};
            sidebarProvider.postCssData({
              className: firstTarget.className || '',
              styles: firstTarget.styles || {},
              stylesPrompt: firstTarget.stylesPrompt || '',
              tagName: firstTarget.tagName || 'div',
              text: firstTarget.text || ''
            });

            // Disable Code until this selection resolves to a known path.
            session.lastJumpTarget = undefined;
            notifyJumpAvailability(session, false);
            const inspectId = ++session.latestInspectId;

            // Resolve + clipboard in the background so a Jump click is never blocked
            // behind slow source-map work.
            void handleInspectClipboard(
              session,
              targets,
              mode,
              payload?.viewport,
              inspectId
            );
          } catch (err: any) {
            vscode.window.showErrorMessage(
              `Kexari Lens: ${err?.message || err}`
            );
          }
        },
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(
        async () => {
          sessions.delete(targetUrl);
          await proxy.close();
          console.log(`[Kexari Lens] Proxy server stopped for ${targetUrl}.`);
          sidebarProvider.postSessions(buildSessionList());
        },
        null,
        context.subscriptions
      );

      sidebarProvider.postSessions(buildSessionList(), targetUrl);

    } catch (err: any) {
      vscode.window.showErrorMessage(`Kexari Lens failed to start proxy server for ${label}: ${err.message}`);
    }
  });
}

/** Asks which dev server to inspect — defaults to the last one used, or localhost:3000. */
async function promptForTargetUrl(context: vscode.ExtensionContext): Promise<string | undefined> {
  const lastUsed = context.globalState.get<string>(LAST_TARGET_KEY, DEFAULT_TARGET_URL);

  const input = await vscode.window.showInputBox({
    title: 'Kexari Lens: Dev Server to Inspect',
    prompt: 'Port (e.g. 3001), host:port, or full URL of the running dev server',
    value: lastUsed,
    placeHolder: DEFAULT_TARGET_URL,
    validateInput: (value) => (normalizeTargetUrl(value) ? undefined : 'Enter a valid port number, host:port, or URL')
  });

  if (!input) {
    return undefined;
  }

  const normalized = normalizeTargetUrl(input);
  if (!normalized) {
    return undefined;
  }

  await context.globalState.update(LAST_TARGET_KEY, normalized);
  return normalized;
}

let webviewTemplateCache: string | null = null;

/** Escapes a value for safe interpolation into an HTML attribute/text context. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Loads the webview shell from src/webview.html and fills in the per-session
 * placeholders. The template is cached after the first read since it never
 * changes at runtime.
 */
function getWebviewContent(
  context: vscode.ExtensionContext,
  proxyUrl: string,
  targetLabel: string
): string {
  if (webviewTemplateCache === null) {
    const templatePath = path.join(context.extensionPath, 'out', 'webview.html');
    webviewTemplateCache = fs.readFileSync(templatePath, 'utf8');
  }

  return webviewTemplateCache
    .replace(/\{\{PROXY_URL\}\}/g, proxyUrl)
    .replace(/\{\{TARGET_LABEL\}\}/g, escapeHtml(targetLabel));
}

function notifyJumpAvailability(session: KexariSession, ready: boolean, pathLabel?: string): void {
  session.panel.webview.postMessage(
    ready
      ? { type: 'KEXARI_LENS_JUMP_READY', path: pathLabel || '' }
      : { type: 'KEXARI_LENS_JUMP_UNAVAILABLE' }
  );
}

function toAbsoluteWorkspacePath(filePath: string): string | null {
  if (!filePath || filePath === 'Unknown') {
    return null;
  }
  if (path.isAbsolute(filePath) || /^[a-zA-Z]:[\\/]/.test(filePath)) {
    return path.normalize(filePath);
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return null;
  }
  return path.normalize(path.join(folder.uri.fsPath, filePath));
}

async function handleInspectClipboard(
  session: KexariSession,
  targets: any[],
  mode: string,
  viewport: any,
  inspectId: number
): Promise<void> {
  try {
    const resolvedTargets = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const resolved = await resolveInspectedSource({
        componentName: target.componentName || 'Unknown',
        fileName: target.fileName,
        lineNumber: target.lineNumber,
        columnNumber: target.columnNumber,
        stackFrames: target.stackFrames || [],
        proxyBaseUrl: session.proxyUrl
      });

      // A newer selection started — drop this stale resolve.
      if (inspectId !== session.latestInspectId) {
        return;
      }

      let displayPath = resolved.filePath;
      let absolutePath = toAbsoluteWorkspacePath(resolved.filePath) || resolved.filePath;

      if (displayPath && displayPath !== 'Unknown' && vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
          const workspacePath = folder.uri.fsPath;
          const normFile = path.normalize(absolutePath);
          const normWorkspace = path.normalize(workspacePath);
          if (normFile.toLowerCase().startsWith(normWorkspace.toLowerCase() + path.sep.toLowerCase()) ||
              normFile.toLowerCase().startsWith(normWorkspace.toLowerCase() + '/') ||
              normFile.toLowerCase().startsWith(normWorkspace.toLowerCase() + '\\') ||
              normFile.toLowerCase() === normWorkspace.toLowerCase()) {
            displayPath = path.relative(normWorkspace, normFile);
            absolutePath = normFile;
            break;
          }
        }
      }

      resolvedTargets.push({
        componentName: target.componentName || 'Unknown',
        tagName: target.tagName || 'div',
        className: target.className || '',
        displayPath: String(displayPath).replace(/\\/g, '/'),
        lineNumber: resolved.lineNumber,
        absolutePath,
        text: String(target.text || '').trim(),
        stylesPrompt: target.stylesPrompt || '',
        owners: target.owners || [],
        stackedComponents: (target.owners || []).map((o: any) => o.componentName).join(' > ')
      });
    }

    if (inspectId !== session.latestInspectId) {
      return;
    }

    // Same entry that appears as File Path in the clipboard (last selected).
    const jumpResolved = resolvedTargets[resolvedTargets.length - 1];
    const pathKnown =
      !!jumpResolved &&
      jumpResolved.displayPath &&
      jumpResolved.displayPath !== 'Unknown' &&
      (jumpResolved.lineNumber || 0) > 0;

    // Store full data for Copy for AI (with computed styles)
    lastInspectedData = { resolvedTargets, mode, viewport, targets };

    // Minimal clipboard on click — one header, per-element blocks, one trailing Instruction.
    const blockTemplate = '{{viewportSummary}}Target Component: {{componentName}}{{stackedComponents}}\nFile Path: {{displayPath}}:{{lineNumber}}\nElement: <{{tagName}} className="{{className}}">';

    let formattedPrompt = '';
    if (mode === 'multi' && resolvedTargets.length > 1) {
      const blocks = resolvedTargets.map((t: any, i: number) =>
        resolvePrompt(blockTemplate, { ...t, mode: 'multi', index: i + 1, viewport })
      ).join('\n\n');
      formattedPrompt = `[Kexari Lens Context]\n${blocks}\n\nInstruction:`;
    } else {
      formattedPrompt = `[Kexari Lens Context]\n${resolvePrompt(blockTemplate, { ...resolvedTargets[0], mode: 'single', index: 1, viewport })}\n\nInstruction:`;
    }

    await vscode.env.clipboard.writeText(formattedPrompt);

    if (inspectId !== session.latestInspectId) {
      return;
    }

    if (pathKnown) {
      session.lastJumpTarget = {
        displayPath: jumpResolved.displayPath,
        lineNumber: jumpResolved.lineNumber,
        text: jumpResolved.text || ''
      };
      notifyJumpAvailability(
        session,
        true,
        `${jumpResolved.displayPath}:${jumpResolved.lineNumber}`
      );
    } else {
      session.lastJumpTarget = undefined;
      notifyJumpAvailability(session, false);
    }

    if (mode === 'multi' && resolvedTargets.length > 1) {
      vscode.window.showInformationMessage(
        `Kexari Lens: ${resolvedTargets.length} elements copied to clipboard!`
      );
    } else {
      vscode.window.showInformationMessage(
        `Kexari Lens: Context for <${resolvedTargets[0].componentName}> copied to clipboard!`
      );
    }
  } catch (err: any) {
    if (inspectId !== session.latestInspectId) {
      return;
    }
    session.lastJumpTarget = undefined;
    notifyJumpAvailability(session, false);
    vscode.window.showErrorMessage(
      `Kexari Lens: ${err?.message || err}`
    );
  }
}

/** Read the File Path:line from the Kexari clipboard payload (source of truth). */
/** Resolves a prompt template with context data. Supports: {{componentName}}, {{displayPath}}, {{lineNumber}}, {{tagName}}, {{className}}, {{text}}, {{cssStyles}}, {{viewportSummary}}, {{stackedComponents}}, {{landmark}}, {{mode}}, {{index}} */
function resolvePrompt(template: string, ctx: any): string {
  const viewportSummary = ctx.viewport?.summary ? `Viewport: ${ctx.viewport.summary}\n` : '';
  const cssBlock = ctx.stylesPrompt ? `\nComputed Styles:\n${ctx.stylesPrompt}\n` : '';
  const stackedChain = ctx.stackedComponents ? `\nComponent Chain: ${ctx.stackedComponents}` : '';

  return template
    .replace(/\{\{componentName\}\}/g, ctx.componentName || 'Unknown')
    .replace(/\{\{displayPath\}\}/g, ctx.displayPath || 'Unknown')
    .replace(/\{\{lineNumber\}\}/g, String(ctx.lineNumber || 0))
    .replace(/\{\{tagName\}\}/g, ctx.tagName || 'div')
    .replace(/\{\{className\}\}/g, ctx.className || '')
    .replace(/\{\{text\}\}/g, ctx.text || '')
    .replace(/\{\{cssStyles\}\}/g, cssBlock)
    .replace(/\{\{viewportSummary\}\}/g, viewportSummary)
    .replace(/\{\{stackedComponents\}\}/g, stackedChain)
    .replace(/\{\{landmark\}\}/g, ctx.landmark || '')
    .replace(/\{\{mode\}\}/g, ctx.mode || 'single')
    .replace(/\{\{index\}\}/g, String(ctx.index || 1));
}

function parseClipboardFilePath(clipboard: string): { displayPath: string; lineNumber: number } | null {
  if (!clipboard || !clipboard.includes('[Kexari Lens Context]')) {
    return null;
  }

  // Prefer the last File Path entry (multi-select jump target = last selected).
  const matches = [...clipboard.matchAll(/File Path:\s*(.+?):(\d+)\s*$/gm)];
  if (matches.length === 0) {
    return null;
  }

  const last = matches[matches.length - 1];
  const displayPath = String(last[1] || '').trim().replace(/\\/g, '/');
  const lineNumber = parseInt(last[2], 10);

  if (!displayPath || displayPath === 'Unknown' || !lineNumber || lineNumber < 1) {
    return null;
  }

  return { displayPath, lineNumber };
}

/**
 * Look for the exact visible text inside the ALREADY-RESOLVED document only
 * (never a workspace-wide search), preferring the occurrence closest to the
 * Fiber-resolved anchor line. This refines a wrapper-element line (e.g. a
 * `.map()` line or JSX container) down to the real text line, without ever
 * risking a jump to a different file or a far-away duplicate string.
 */
function findNearestTextMatch(
  doc: vscode.TextDocument,
  rawText: string,
  anchorLine0: number,
  maxDistance = 150
): { line: number; startCol: number; endCol: number } | null {
  const query = String(rawText || '').replace(/\s+/g, ' ').trim();
  if (query.length < 2) {
    return null;
  }

  let best: { line: number; startCol: number; endCol: number; dist: number } | null = null;
  for (let i = 0; i < doc.lineCount; i++) {
    const lineText = doc.lineAt(i).text;
    const idx = lineText.indexOf(query);
    if (idx < 0) {
      continue;
    }
    const dist = Math.abs(i - anchorLine0);
    if (!best || dist < best.dist) {
      best = { line: i, startCol: idx, endCol: idx + query.length, dist };
    }
    if (dist === 0) {
      break;
    }
  }

  if (!best || best.dist > maxDistance) {
    return null;
  }
  return best;
}

async function jumpToSource(session: KexariSession): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage('Kexari Lens: Open a workspace folder to jump to code.');
    return;
  }

  // Clipboard is the source of truth — same string the user sees.
  const clipboard = await vscode.env.clipboard.readText();
  const fromClipboard = parseClipboardFilePath(clipboard);
  const jump = fromClipboard || session.lastJumpTarget;

  if (!jump?.displayPath || jump.displayPath === 'Unknown' || !(jump.lineNumber > 0)) {
    vscode.window.showWarningMessage(
      'Kexari Lens: No known source path on the clipboard for this element.'
    );
    notifyJumpAvailability(session, false);
    return;
  }

  const relative = String(jump.displayPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const uri = vscode.Uri.joinPath(folder.uri, ...relative.split('/'));
  const lineNumber = Math.max(1, Number(jump.lineNumber) || 1);

  // Only trust cached text if it belongs to this exact resolved path:line —
  // otherwise it could be stale from a different selection.
  const textForRefine =
    session.lastJumpTarget &&
    session.lastJumpTarget.displayPath === jump.displayPath &&
    session.lastJumpTarget.lineNumber === jump.lineNumber
      ? String(session.lastJumpTarget.text || '').trim()
      : '';

  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
      preserveFocus: false
    });

    const anchorLine = Math.min(lineNumber - 1, Math.max(0, doc.lineCount - 1));

    // Search only inside this already-opened, already-resolved file — never
    // the workspace — and only accept a match near the anchor line.
    const refined = textForRefine ? findNearestTextMatch(doc, textForRefine, anchorLine) : null;

    const finalLine = refined ? refined.line : anchorLine;
    const startCol = refined ? refined.startCol : 0;
    const endCol = refined ? refined.endCol : 0;

    const startPos = new vscode.Position(finalLine, startCol);
    const endPos = new vscode.Position(finalLine, endCol);
    editor.selection = new vscode.Selection(startPos, endPos);
    editor.revealRange(
      new vscode.Range(startPos, endPos),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );

    vscode.window.showInformationMessage(
      `Kexari Lens: Opened ${relative}:${finalLine + 1}`
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `Kexari Lens: Failed to open ${relative}:${lineNumber}: ${err?.message || err}`
    );
  }
}
