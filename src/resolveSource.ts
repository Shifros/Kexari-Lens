import * as vscode from 'vscode';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import { SourceMapConsumer } from 'source-map';

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

let sourceMapReady: Promise<void> | null = null;

function ensureSourceMapReady(): Promise<void> {
  if (!sourceMapReady) {
    sourceMapReady = (async () => {
      const wasmPath = require.resolve('source-map/lib/mappings.wasm');
      const wasmBuffer = fs.readFileSync(wasmPath);
      (SourceMapConsumer as any).initialize({
        'lib/mappings.wasm': wasmBuffer
      });
    })();
  }
  return sourceMapReady;
}

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
    /\.js(\?|$)/.test(lower) && (lower.includes('chunk') || lower.includes('_next'))
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

  // Drop leading absolute drive letters that aren't local, keep Windows paths
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

async function fetchText(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        resolve(null);
        return;
      }

      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function toMapUrl(chunkPath: string, proxyBaseUrl: string): string {
  let relative = chunkPath.replace(/\\/g, '/');
  relative = relative.replace(/^https?:\/\/[^/]+\//, '');
  if (!relative.startsWith('/')) {
    relative = '/' + relative;
  }
  if (!relative.endsWith('.map')) {
    relative = relative + '.map';
  }
  return proxyBaseUrl.replace(/\/$/, '') + relative;
}

async function resolveViaSourceMap(
  frame: StackFrame,
  proxyBaseUrl: string
): Promise<ResolvedSource | null> {
  if (!frame.fileName || !frame.lineNumber) {
    return null;
  }

  // Only try source maps for compiled/chunk paths
  const lower = frame.fileName.toLowerCase().replace(/\\/g, '/');
  const shouldTryMap =
    lower.includes('_next/') ||
    lower.includes('/static/chunks/') ||
    lower.endsWith('.js') ||
    lower.includes('chunk');

  if (!shouldTryMap) {
    return null;
  }

  const mapUrl = toMapUrl(frame.fileName, proxyBaseUrl);
  const mapText = await fetchText(mapUrl);
  if (!mapText) {
    return null;
  }

  try {
    await ensureSourceMapReady();
    const rawMap = JSON.parse(mapText);
    const consumer = await new SourceMapConsumer(rawMap);
    try {
      const original = consumer.originalPositionFor({
        line: frame.lineNumber,
        column: Math.max(0, (frame.columnNumber || 1) - 1)
      });

      if (!original.source || original.line == null) {
        return null;
      }

      const normalized = normalizeSourcePath(original.source);
      if (!looksLikeProjectSource(normalized) && isUnusablePath(normalized)) {
        return null;
      }

      return {
        filePath: normalized,
        lineNumber: original.line
      };
    } finally {
      consumer.destroy();
    }
  } catch {
    return null;
  }
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

  // Search by basename under src/app/components etc.
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
 * Two-step resolution — no workspace-wide text search, ever:
 * 1. Prefer an already-good source path (mapped to a real file on disk)
 * 2. Resolve compiled chunk frames via source maps (webpack/turbopack → original files)
 * Never returns _next/ or node_modules paths. Returns Unknown if neither step succeeds,
 * so Code stays disabled rather than guessing.
 */
export async function resolveInspectedSource(options: {
  componentName: string;
  fileName?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackFrames?: StackFrame[];
  proxyBaseUrl: string;
}): Promise<ResolvedSource> {
  const {
    fileName,
    lineNumber = 0,
    columnNumber = 0,
    stackFrames = [],
    proxyBaseUrl
  } = options;

  // 1. Direct usable path
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

  // 2. Source-map every available stack frame (compiled chunks → original files)
  const framesToTry: StackFrame[] = [
    ...stackFrames,
    ...(fileName
      ? [{ fileName, lineNumber: lineNumber || 1, columnNumber: columnNumber || 0 }]
      : [])
  ];

  const seen = new Set<string>();
  for (const frame of framesToTry) {
    const key = `${frame.fileName}:${frame.lineNumber}:${frame.columnNumber || 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const mapped = await resolveViaSourceMap(frame, proxyBaseUrl);
    if (!mapped) {
      continue;
    }

    const workspaceFile = await mapToWorkspaceFile(mapped.filePath);
    if (workspaceFile) {
      return {
        filePath: workspaceFile,
        lineNumber: mapped.lineNumber
      };
    }

    if (looksLikeProjectSource(mapped.filePath)) {
      return mapped;
    }
  }

  // 3. Unresolved — never leak chunk paths, and never fall back to a project-wide
  // text search that could land on the wrong component.
  return {
    filePath: 'Unknown',
    lineNumber: 0
  };
}
