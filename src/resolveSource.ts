import * as vscode from 'vscode';
import * as path from 'path';

export interface StackFrame {
  fileName: string;
  lineNumber: number;
  columnNumber?: number;
}

export interface ResolvedSource {
  filePath: string;
  lineNumber: number;
}

const SOURCE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js', '.mts', '.cts'];

export function isUnusablePath(filePath?: string | null): boolean {
  if (!filePath || filePath === 'Unknown') {
    return true;
  }

  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  return (
    lower.includes('node_modules') ||
    lower.includes('next/dist') ||
    lower.includes('/_next/') ||
    lower.includes('_next/') ||
    lower.includes('/static/chunks/') ||
    lower.includes('react-dom') ||
    (/\.js(\?|$)/.test(lower) && (lower.includes('chunk') || lower.includes('_next')))
  );
}

function normalizeSourcePath(sourcePath: string): string {
  let cleaned = sourcePath.replace(/\\/g, '/');

  cleaned = cleaned.replace(/^webpack:\/\/[^/]*\//, '');
  cleaned = cleaned.replace(/^webpack-internal:\/\/\/\([^)]+\)\//, '');
  cleaned = cleaned.replace(/^turbopack:\/\/\[project\]\//, '');
  cleaned = cleaned.replace(/^turbopack:\/\/\//, '');
  cleaned = cleaned.replace(/^file:\/\/\//, '');
  cleaned = cleaned.replace(/^https?:\/\/[^/]+\//, '');
  cleaned = cleaned.replace(/^\.\//, '');
  cleaned = cleaned.replace(/\?.*$/, '');

  if (/^[a-zA-Z]:\//.test(cleaned)) {
    return cleaned;
  }

  return cleaned;
}

function looksLikeProjectSource(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  if (isUnusablePath(lower)) {
    return false;
  }

  return (
    SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
    lower.includes('/src/') ||
    lower.includes('/app/') ||
    lower.includes('/components/') ||
    lower.includes('/pages/')
  );
}

async function mapToWorkspaceFile(candidatePath: string): Promise<string | null> {
  const normalized = normalizeSourcePath(candidatePath);
  if (!normalized || isUnusablePath(normalized)) {
    return null;
  }

  // Absolute path that already exists on disk
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:[\\/]/.test(normalized)) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(normalized));
      return normalized;
    } catch {
      // fall through to workspace relative matching
    }
  }

  const basename = path.posix.basename(normalized.replace(/\\/g, '/'));
  const relativeHint = normalized.replace(/^\/+/, '');

  if (vscode.workspace.workspaceFolders) {
    for (const folder of vscode.workspace.workspaceFolders) {
      const direct = path.join(folder.uri.fsPath, relativeHint);
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(direct));
        return direct;
      } catch {
        // keep looking
      }
    }
  }

  // Search by basename under the workspace (skip build outputs)
  const exclude = '**/{node_modules,.next,.git,dist,out,build,.turbo}/**';
  const matches = await vscode.workspace.findFiles(`**/${basename}`, exclude, 40);
  if (matches.length === 0) {
    return null;
  }

  const hintParts = relativeHint.split('/').filter(Boolean);
  const scored = matches
    .map((uri) => {
      const fsPath = uri.fsPath.replace(/\\/g, '/');
      let score = 0;
      for (const part of hintParts) {
        if (fsPath.toLowerCase().includes(part.toLowerCase())) {
          score += 1;
        }
      }
      if (fsPath.toLowerCase().includes('/src/') || fsPath.toLowerCase().includes('/app/')) {
        score += 2;
      }
      return { fsPath: uri.fsPath, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.fsPath || null;
}

/**
 * Resolve an inspected element to a workspace file.
 * Primary input is compile-time `data-kexari-source` (file:line from @kexari-lens/dev).
 * Chunk / source-map fallbacks were removed — React 19 made them unreliable.
 */
export async function resolveInspectedSource(options: {
  componentName: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackFrames?: StackFrame[];
  proxyBaseUrl?: string;
}): Promise<ResolvedSource> {
  const { fileName, lineNumber = 0 } = options;

  if (fileName && !isUnusablePath(fileName)) {
    const mapped = await mapToWorkspaceFile(fileName);
    if (mapped) {
      return {
        filePath: mapped,
        lineNumber: lineNumber || 1
      };
    }

    if (looksLikeProjectSource(fileName)) {
      return {
        filePath: normalizeSourcePath(fileName),
        lineNumber: lineNumber || 1
      };
    }
  }

  return {
    filePath: 'Unknown',
    lineNumber: 0
  };
}
