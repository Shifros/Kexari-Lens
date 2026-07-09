import * as vscode from 'vscode';
import * as path from 'path';
import { startProxyServer, ProxyServerInstance } from './proxy';

let proxyInstance: ProxyServerInstance | undefined = undefined;
let activePanel: vscode.WebviewPanel | undefined = undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log('Kexari Lens extension is now active!');

  let startCommand = vscode.commands.registerCommand('kexariLens.start', async () => {
    // If the panel is already open, reveal it
    if (activePanel) {
      activePanel.reveal(vscode.ViewColumn.Beside);
      return;
    }

    const devServerPort = 3000;
    const proxyPort = 3001;
    const targetUrl = `http://localhost:${devServerPort}`;
    const proxyUrl = `http://localhost:${proxyPort}`;

    const inspectorScriptPath = path.join(context.extensionPath, 'src', 'inspector.js');

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Kexari Lens: Starting Proxy Server...",
      cancellable: false
    }, async () => {
      try {
        // Start proxy server if not already running
        if (!proxyInstance) {
          proxyInstance = await startProxyServer(proxyPort, targetUrl, inspectorScriptPath);
        }

        // Create Webview Panel
        activePanel = vscode.window.createWebviewPanel(
          'kexariLensInspector',
          'Kexari Lens Inspector',
          vscode.ViewColumn.Beside,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        );

        // Set the webview html
        activePanel.webview.html = getWebviewContent(proxyUrl);

        // Handle message from the webview
        activePanel.webview.onDidReceiveMessage(
          async (payload) => {
            // Relativize path for nicer prompt formatting
            let displayPath = payload.fileName || 'Unknown';
            let resolvedLineNumber = payload.lineNumber || 0;

            // Check if the reported path is invalid or is a compiled Next.js static chunk or node module
            const isInvalidPath = !payload.fileName || 
                                  payload.fileName === 'Unknown' || 
                                  payload.fileName.toLowerCase().includes('_next/') || 
                                  payload.fileName.toLowerCase().includes('node_modules') || 
                                  payload.fileName.toLowerCase().endsWith('.js');

            if (isInvalidPath && payload.componentName && payload.componentName !== 'Unknown') {
              const def = await findComponentDefinition(payload.componentName);
              if (def) {
                displayPath = def.filePath;
                resolvedLineNumber = def.lineNumber;
              }
            }

            if (displayPath && displayPath !== 'Unknown' && vscode.workspace.workspaceFolders) {
              for (const folder of vscode.workspace.workspaceFolders) {
                const workspacePath = folder.uri.fsPath;
                // Normalize slashes for comparison
                const normFile = path.normalize(displayPath);
                const normWorkspace = path.normalize(workspacePath);
                if (normFile.toLowerCase().startsWith(normWorkspace.toLowerCase())) {
                  displayPath = path.relative(normWorkspace, normFile);
                  break;
                }
              }
            }

            // Normalize backslashes to forward slashes for the AI prompt (more standard/cleaner)
            displayPath = displayPath.replace(/\\/g, '/');

            // Format the final prompt
            const formattedPrompt = `[Kexari Lens Context]
Target Component: ${payload.componentName}
File Path: ${displayPath}:${resolvedLineNumber}
Element: <${payload.tagName} className="${payload.className}">

Instruction:
`;

            // Copy to clipboard
            await vscode.env.clipboard.writeText(formattedPrompt);
            vscode.window.showInformationMessage(`Kexari Lens: Context for <${payload.componentName}> copied to clipboard!`);
          },
          undefined,
          context.subscriptions
        );

        // Clean up on panel disposal
        activePanel.onDidDispose(
          async () => {
            activePanel = undefined;
            if (proxyInstance) {
              await proxyInstance.close();
              proxyInstance = undefined;
              console.log('[Kexari Lens] Proxy server stopped.');
            }
          },
          null,
          context.subscriptions
        );

      } catch (err: any) {
        vscode.window.showErrorMessage(`Kexari Lens failed to start proxy server: ${err.message}`);
      }
    });
  });

  context.subscriptions.push(startCommand);
}

export function deactivate() {
  if (proxyInstance) {
    proxyInstance.server.close();
    proxyInstance = undefined;
  }
}

function getWebviewContent(proxyUrl: string): string {
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
        <div id="url-bar-container">
            <svg class="url-icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
            <input type="text" id="url-input" value="/" placeholder="Enter URL path (e.g. /about)" />
        </div>
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
        
        let inspectorEnabled = true;
        const proxyBaseUrl = "${proxyUrl}"; // e.g. http://localhost:3001
        
        // Browser navigation controls
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
                
                // Formulate target URL
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
        
        // Toggle visual inspector selection
        toggleInspectorBtn.addEventListener('click', () => {
            inspectorEnabled = !inspectorEnabled;
            if (inspectorEnabled) {
                toggleInspectorBtn.classList.add('active');
                inspectorText.textContent = 'Inspector: ON';
            } else {
                toggleInspectorBtn.classList.remove('active');
                inspectorText.textContent = 'Inspector: OFF';
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
        
        // Re-apply toggle state on page load
        iframe.addEventListener('load', () => {
            sendInspectorState();
        });
        
        // Listen for messages from the iframe proxy page
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message) {
                if (message.type === 'KEXARI_LENS_INSPECTOR_CLICK') {
                    // Forward click payload to extension host
                    vscode.postMessage(message.payload);
                } else if (message.type === 'KEXARI_LENS_URL_CHANGED') {
                    // Synchronize the URL input box
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

async function findComponentDefinition(componentName: string): Promise<{ filePath: string; lineNumber: number } | null> {
  const candidateGlobs = [
    `**/${componentName}.{tsx,jsx,ts,js}`,
    `**/page.{tsx,jsx,js}`,
    `**/layout.{tsx,jsx,js}`,
    `**/index.{tsx,jsx,ts,js}`
  ];

  const excludeGlob = '**/{node_modules,.next,.git,dist,out,build,.turbo}/**';

  const regexes = [
    new RegExp(`export\\s+default\\s+function\\s+${componentName}\\b`),
    new RegExp(`export\\s+function\\s+${componentName}\\b`),
    new RegExp(`function\\s+${componentName}\\b`),
    new RegExp(`const\\s+${componentName}\\s*=`),
    new RegExp(`class\\s+${componentName}\\b`)
  ];

  for (const glob of candidateGlobs) {
    try {
      const files = await vscode.workspace.findFiles(glob, excludeGlob, 20);
      for (const file of files) {
        const document = await vscode.workspace.openTextDocument(file);
        const text = document.getText();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i];
          if (regexes.some(r => r.test(lineText))) {
            return {
              filePath: file.fsPath,
              lineNumber: i + 1
            };
          }
        }
      }
    } catch (e) {
      // Keep searching other candidates on error
    }
  }

  return null;
}

