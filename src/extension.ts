import * as vscode from 'vscode';
import * as path from 'path';
import { startProxyServer, ProxyServerInstance } from './proxy';
import { resolveInspectedSource } from './resolveSource';

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

export function activate(context: vscode.ExtensionContext) {
  console.log('Kexari Lens extension is now active!');

  let startCommand = vscode.commands.registerCommand('kexariLens.start', async () => {
    const targetUrl = await promptForTargetUrl(context);
    if (!targetUrl) {
      return;
    }

    const existing = sessions.get(targetUrl);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const inspectorScriptPath = path.join(context.extensionPath, 'src', 'inspector.js');
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

        panel.webview.html = getWebviewContent(proxyUrl, label);

        panel.webview.onDidReceiveMessage(
          async (message) => {
            try {
              if (message?.action === 'jump') {
                await jumpToSource(session);
                return;
              }

              const payload = message;
              const targets = Array.isArray(payload?.targets)
                ? payload.targets
                : [payload];
              const mode = payload?.mode === 'multi' || targets.length > 1 ? 'multi' : 'single';

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
          },
          null,
          context.subscriptions
        );

      } catch (err: any) {
        vscode.window.showErrorMessage(`Kexari Lens failed to start proxy server for ${label}: ${err.message}`);
      }
    });
  });

  context.subscriptions.push(startCommand);
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

function getWebviewContent(proxyUrl: string, targetLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kexari Lens Inspector</title>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: var(--vscode-editor-background, #121214);
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            display: flex;
            flex-direction: column;
        }
        #toolbar {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 16px;
            background-color: var(--vscode-editorWidget-background, #18181c);
            border-bottom: 1px solid var(--vscode-panel-border, rgba(255, 255, 255, 0.06));
            user-select: none;
            box-sizing: border-box;
            height: 44px;
        }
        #navigation-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        .nav-btn {
            background: transparent;
            border: 1px solid transparent;
            color: var(--vscode-foreground, #a6a6a6);
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .nav-btn:hover {
            background-color: rgba(255, 255, 255, 0.06);
            color: #ffffff;
            border-color: rgba(255, 255, 255, 0.04);
        }
        .nav-btn:active {
            transform: scale(0.92);
            background-color: rgba(255, 255, 255, 0.1);
        }
        .nav-btn svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }
        #target-badge {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 10px;
            height: 28px;
            border-radius: 8px;
            background: rgba(99, 102, 241, 0.1);
            border: 1px solid rgba(99, 102, 241, 0.22);
            color: #a5b4fc;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.2px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #target-badge svg {
            width: 11px;
            height: 11px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            flex-shrink: 0;
        }
        #url-bar-container {
            display: flex;
            flex-grow: 1;
            align-items: center;
            gap: 8px;
            background-color: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 0 12px;
            height: 28px;
            box-sizing: border-box;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #url-bar-container:hover {
            background-color: rgba(255, 255, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.12);
        }
        #url-bar-container:focus-within {
            background-color: rgba(0, 0, 0, 0.2);
            border-color: #6366f1;
            box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.3), 0 2px 8px rgba(0, 0, 0, 0.15);
        }
        .url-icon {
            width: 12px;
            height: 12px;
            fill: none;
            stroke: rgba(255, 255, 255, 0.4);
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            flex-shrink: 0;
        }
        #url-input {
            background: none;
            border: none;
            outline: none;
            color: var(--vscode-input-foreground, #e2e8f0);
            font-family: var(--vscode-editor-font-family, Menlo, Monaco, Consolas, "Courier New", monospace);
            font-size: 11px;
            width: 100%;
            padding: 0;
            margin: 0;
            letter-spacing: 0.3px;
        }
        #toggle-inspector-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 14px;
            height: 28px;
            border-radius: 20px;
            cursor: pointer;
            box-sizing: border-box;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            border: 1px solid transparent;
        }
        #toggle-inspector-btn.active {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(79, 70, 229, 0.12));
            border-color: rgba(99, 102, 241, 0.25);
            color: #a5b4fc;
            box-shadow: 0 2px 6px rgba(99, 102, 241, 0.1);
        }
        #toggle-inspector-btn.active:hover {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.18), rgba(79, 70, 229, 0.18));
            border-color: rgba(99, 102, 241, 0.4);
            color: #c7d2fe;
        }
        #toggle-inspector-btn:not(.active) {
            background: rgba(255, 255, 255, 0.02);
            border-color: rgba(255, 255, 255, 0.05);
            color: #94a3b8;
        }
        #toggle-inspector-btn:not(.active):hover {
            background: rgba(255, 255, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.1);
            color: #cbd5e1;
        }
        .inspector-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }
        #toggle-inspector-btn.active .inspector-dot {
            background-color: #10b981;
            box-shadow: 0 0 8px #10b981, 0 0 16px rgba(16, 185, 129, 0.4);
            animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        #toggle-inspector-btn:not(.active) .inspector-dot {
            background-color: #64748b;
        }
        .inspector-icon {
            width: 12px;
            height: 12px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2.5;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        #jump-code-btn {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px;
            height: 28px;
            border-radius: 8px;
            box-sizing: border-box;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            border: 1px solid rgba(255, 255, 255, 0.06);
            background: rgba(255, 255, 255, 0.02);
            color: #64748b;
            cursor: not-allowed;
            opacity: 0.55;
        }
        #jump-code-btn.enabled {
            cursor: pointer;
            opacity: 1;
            background: linear-gradient(135deg, rgba(34, 211, 238, 0.12), rgba(99, 102, 241, 0.12));
            border-color: rgba(34, 211, 238, 0.3);
            color: #a5f3fc;
        }
        #jump-code-btn.enabled:hover {
            background: linear-gradient(135deg, rgba(34, 211, 238, 0.2), rgba(99, 102, 241, 0.18));
            border-color: rgba(34, 211, 238, 0.45);
            color: #cffafe;
        }
        #jump-code-btn:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }
        #iframe-container {
            flex-grow: 1;
            position: relative;
            width: 100%;
            height: calc(100% - 44px);
        }
        iframe {
            width: 100%;
            height: 100%;
            border: none;
            overflow: hidden;
            background-color: #121214;
        }
        @keyframes pulse {
            0%, 100% {
                opacity: 1;
                transform: scale(1);
            }
            50% {
                opacity: .6;
                transform: scale(1.15);
            }
        }
    </style>
</head>
<body>
    <div id="toolbar">
        <div id="navigation-controls">
            <button id="back-btn" class="nav-btn" title="Back">
                <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            </button>
            <button id="forward-btn" class="nav-btn" title="Forward">
                <svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8-8-8z"/></svg>
            </button>
            <button id="reload-btn" class="nav-btn" title="Reload">
                <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.07 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
            </button>
        </div>
        <div id="target-badge" title="Dev server this panel is inspecting">
            <svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"></rect><path d="M2 9h20"></path></svg>
            <span>${targetLabel}</span>
        </div>
        <div id="url-bar-container">
            <svg class="url-icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <input type="text" id="url-input" value="/" placeholder="Enter URL path (e.g. /about)" />
        </div>
        <button id="jump-code-btn" disabled title="Select an element first, then jump to its source">
            <span>Code</span>
        </button>
        <button id="toggle-inspector-btn" class="active" title="Toggle Visual Inspector (Selector)">
            <svg class="inspector-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>
            <span class="inspector-dot"></span>
            <span class="inspector-text">Inspector: ON</span>
        </button>
    </div>
    <div id="iframe-container">
        <iframe id="proxy-iframe" src="${proxyUrl}"></iframe>
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const iframe = document.getElementById('proxy-iframe');
        const urlInput = document.getElementById('url-input');
        const backBtn = document.getElementById('back-btn');
        const forwardBtn = document.getElementById('forward-btn');
        const reloadBtn = document.getElementById('reload-btn');
        const toggleInspectorBtn = document.getElementById('toggle-inspector-btn');
        const inspectorText = toggleInspectorBtn.querySelector('.inspector-text');
        const jumpCodeBtn = document.getElementById('jump-code-btn');
        
        let inspectorEnabled = true;
        let jumpTarget = null;
        let jumpReady = false;
        const proxyBaseUrl = "${proxyUrl}";

        function setJumpReady(ready, label) {
            jumpReady = !!ready;
            if (jumpReady) {
                jumpCodeBtn.disabled = false;
                jumpCodeBtn.classList.add('enabled');
                jumpCodeBtn.title = label
                    ? ('Open ' + label)
                    : 'Open clipboard source path in editor';
            } else {
                jumpCodeBtn.disabled = true;
                jumpCodeBtn.classList.remove('enabled');
                jumpCodeBtn.title = 'Select an element with a known source path first';
            }
        }

        function setJumpTarget(target) {
            jumpTarget = target || null;
            // Stay disabled until the extension resolves a real file path.
            setJumpReady(false);
        }
        
        reloadBtn.addEventListener('click', () => {
            iframe.contentWindow.postMessage({ type: 'KEXARI_LENS_NAVIGATE', action: 'reload' }, '*');
        });
        
        backBtn.addEventListener('click', () => {
            iframe.contentWindow.postMessage({ type: 'KEXARI_LENS_NAVIGATE', action: 'back' }, '*');
        });
        
        forwardBtn.addEventListener('click', () => {
            iframe.contentWindow.postMessage({ type: 'KEXARI_LENS_NAVIGATE', action: 'forward' }, '*');
        });
        
        urlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                let targetPath = urlInput.value.trim();
                let targetUrl = targetPath;
                if (!targetPath.startsWith('/') && !targetPath.startsWith('http://') && !targetPath.startsWith('https://')) {
                    targetPath = '/' + targetPath;
                }
                
                if (targetPath.startsWith('/')) {
                    targetUrl = proxyBaseUrl + targetPath;
                }
                
                iframe.src = targetUrl;
            }
        });

        jumpCodeBtn.addEventListener('click', () => {
            if (!jumpReady) return;
            vscode.postMessage({ action: 'jump' });
        });
        
        toggleInspectorBtn.addEventListener('click', () => {
            inspectorEnabled = !inspectorEnabled;
            if (inspectorEnabled) {
                toggleInspectorBtn.classList.add('active');
                inspectorText.textContent = 'Inspector: ON';
            } else {
                toggleInspectorBtn.classList.remove('active');
                inspectorText.textContent = 'Inspector: OFF';
                setJumpTarget(null);
            }
            sendInspectorState();
        });
        
        function sendInspectorState() {
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({
                    type: 'KEXARI_LENS_SET_STATE',
                    enabled: inspectorEnabled
                }, '*');
            }
        }
        
        // the iframe reloads on navigation, wiping the injected script's state,
        // so we need to re-send the toggle state every time it loads
        iframe.addEventListener('load', () => {
            setJumpTarget(null);
            sendInspectorState();
        });

        // Extension enables Code only after clipboard path resolves to a real file.
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (!message) return;
            if (message.type === 'KEXARI_LENS_JUMP_READY') {
                setJumpReady(true, message.path || '');
            } else if (message.type === 'KEXARI_LENS_JUMP_UNAVAILABLE') {
                setJumpReady(false);
            }
        });
        
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message) {
                if (message.type === 'KEXARI_LENS_INSPECTOR_CLICK') {
                    // Keep Code disabled until extension confirms a known path.
                    setJumpTarget(message.payload.jumpTarget || null);
                    vscode.postMessage({ action: 'inspect', ...message.payload });
                } else if (message.type === 'KEXARI_LENS_SELECTION_CLEARED') {
                    setJumpTarget(null);
                } else if (message.type === 'KEXARI_LENS_URL_CHANGED') {
                    const currentUrl = message.payload.url;
                    if (currentUrl.startsWith(proxyBaseUrl)) {
                        urlInput.value = currentUrl.substring(proxyBaseUrl.length) || '/';
                    } else {
                        urlInput.value = currentUrl;
                    }
                }
            }
        });
    </script>
</body>
</html>`;
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
        text: String(target.text || '').trim()
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

    let formattedPrompt = '';
    const viewportLine = viewport?.summary
      ? `Current Viewport: ${viewport.summary}`
      : null;

    if (mode === 'multi' && resolvedTargets.length > 1) {
      const blocks = resolvedTargets.map((t, i) =>
        `[${i + 1}] Target Component: ${t.componentName}
File Path: ${t.displayPath}:${t.lineNumber}
Element: <${t.tagName} className="${t.className}">`
      ).join('\n\n');

      formattedPrompt = `[Kexari Lens Context]
Mode: Multi-Element Targeting
${viewportLine ? viewportLine + '\n' : ''}Selected Elements: ${resolvedTargets.length}

${blocks}

Instruction:
`;
    } else {
      const t = resolvedTargets[0];
      formattedPrompt = `[Kexari Lens Context]
${viewportLine ? viewportLine + '\n' : ''}Target Component: ${t.componentName}
File Path: ${t.displayPath}:${t.lineNumber}
Element: <${t.tagName} className="${t.className}">

Instruction:
`;
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
