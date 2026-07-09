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
            if (payload.fileName && vscode.workspace.workspaceFolders) {
              for (const folder of vscode.workspace.workspaceFolders) {
                const workspacePath = folder.uri.fsPath;
                // Normalize slashes for comparison
                const normFile = path.normalize(payload.fileName);
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
File Path: ${displayPath}:${payload.lineNumber}
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
        html, body, iframe {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            border: none;
            overflow: hidden;
            background-color: #1e1e1e;
        }
    </style>
</head>
<body>
    <iframe id="proxy-iframe" src="${proxyUrl}"></iframe>
    <script>
        const vscode = acquireVsCodeApi();
        
        // Listen for messages from the iframe proxy page
        window.addEventListener('message', (event) => {
            const message = event.data;
            if (message && message.type === 'KEXARI_LENS_INSPECTOR_CLICK') {
                // Forward the data to the VS Code Extension backend
                vscode.postMessage(message.payload);
            }
        });
    </script>
</body>
</html>`;
}
