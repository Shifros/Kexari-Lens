import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface SessionInfo {
  targetUrl: string;
  label: string;
  status?: 'active' | 'error';
  inspectorEnabled?: boolean;
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'kexariLens.sidebar';
  private _view: vscode.WebviewView | undefined;
  private _lastCss: Record<string, unknown> | null = null;

  public onLaunch: ((targetUrl: string) => Promise<void>) | undefined;
  public onFocusSession: ((targetUrl: string) => void) | undefined;
  public onStopSession: ((targetUrl: string) => Promise<void>) | undefined;
  public onCssApply: ((className: string) => void) | undefined;
  public onCssReset: (() => void) | undefined;
  public onCssCopyAi: (() => void) | undefined;
  public onEnablePlugin: (() => Promise<void>) | undefined;
  /** Called when the sidebar webview is ready (initial load or recreate). */
  public onRefresh: (() => void) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out')]
    };
    webviewView.webview.html = this.getSidebarContent();
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message?.action) {
        case 'ready':
          // Wait for the webview script to listen before pushing state —
          // posting from resolveWebviewView races and drops the message.
          this.pushCachedState();
          return;
        case 'launch':
          if (this.onLaunch && message.targetUrl) { void this.onLaunch(message.targetUrl); }
          return;
        case 'focusSession':
          if (this.onFocusSession && message.targetUrl) { this.onFocusSession(message.targetUrl); }
          return;
        case 'stopSession':
          if (this.onStopSession && message.targetUrl) { void this.onStopSession(message.targetUrl); }
          return;
        case 'cssApply':
          if (this.onCssApply && message.className !== undefined) { this.onCssApply(message.className); }
          return;
        case 'cssReset':
          if (this.onCssReset) { this.onCssReset(); }
          return;
        case 'cssCopyAi':
          if (this.onCssCopyAi) { this.onCssCopyAi(); }
          return;
        case 'enablePlugin':
          if (this.onEnablePlugin) { void this.onEnablePlugin(); }
          return;
      }
    }, undefined, this.context.subscriptions);
  }

  /** Re-push sessions + last CSS after the webview signals it can receive messages. */
  private pushCachedState(): void {
    if (this.onRefresh) { this.onRefresh(); }
    if (this._lastCss) {
      this._view?.webview.postMessage({ type: 'KEXARI_LENS_CSS_DATA', ...this._lastCss });
    }
  }

  postSessions(sessions: SessionInfo[], latestTargetUrl?: string): void {
    this._view?.webview.postMessage({
      type: 'KEXARI_LENS_SESSIONS_UPDATE',
      sessions,
      targetUrl: latestTargetUrl || undefined
    });
  }

  postCssData(data: any): void {
    this._lastCss = data ? { ...data } : null;
    this._view?.webview.postMessage({ type: 'KEXARI_LENS_CSS_DATA', ...data });
  }

  clearCssData(): void {
    this._lastCss = null;
    this._view?.webview.postMessage({ type: 'KEXARI_LENS_CSS_CLEAR' });
  }

  postPluginSetup(snippet: string): void {
    this._view?.webview.postMessage({
      type: 'KEXARI_LENS_PLUGIN_MISSING',
      snippet
    });
  }

  postPluginEnabled(message: string): void {
    this._view?.webview.postMessage({
      type: 'KEXARI_LENS_PLUGIN_ENABLED',
      message
    });
  }

  private getSidebarContent(): string {
    return fs.readFileSync(path.join(this.context.extensionPath, 'out', 'sidebar.html'), 'utf8');
  }
}