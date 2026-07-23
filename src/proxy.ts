import express from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import * as http from 'http';
import * as fs from 'fs';

export interface ProxyServerInstance {
  server: http.Server;
  /** Actual bound port — may differ from the requested port when 0 (auto-assign) is passed. */
  port: number;
  close: () => Promise<void>;
}

/**
 * Starts a proxy server for one dev-server target. Pass port 0 to let the OS
 * assign a free port, which is what allows multiple targets/projects to run
 * side by side without colliding on a fixed port.
 */
export function startProxyServer(
  port: number,
  targetUrl: string,
  inspectorScriptPath: string
): Promise<ProxyServerInstance> {
  return new Promise((resolve, reject) => {
    const app = express();

    app.get('/kexari-inspector.js', (req, res) => {
      if (fs.existsSync(inspectorScriptPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.sendFile(inspectorScriptPath);
      } else {
        res.status(404).send('Inspector script not found');
      }
    });

    const proxyMiddleware = createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: true, // needed so responseInterceptor can rewrite the body
      ws: true, // needed for Next.js HMR
      on: {
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
          const contentType = proxyRes.headers['content-type'];
          if (contentType && contentType.includes('text/html')) {
            const html = responseBuffer.toString('utf8');
            if (html.includes('</body>')) {
              return html.replace(
                '</body>',
                `<script src="/kexari-inspector.js"></script></body>`
              );
            }
            return html + `<script src="/kexari-inspector.js"></script>`;
          }
          return responseBuffer;
        }),
        error: (err, req, res) => {
          console.error('[Kexari Lens Proxy Error]:', err);
          if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
            const httpRes = res as http.ServerResponse;
            if (!httpRes.headersSent) {
              // Waiting page with auto-retry — covers compile-time and late `npm run dev`.
              const safeTarget = String(targetUrl)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/"/g, '&quot;');
              const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="2" />
  <title>Waiting for app…</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: system-ui, sans-serif; background: #0f1115; color: #c8cdd8; }
    .box { text-align: center; max-width: 28rem; padding: 1.5rem; }
    h1 { font-size: 1.05rem; font-weight: 600; color: #e8ebf2; margin: 0 0 .5rem; }
    p { margin: 0; font-size: .85rem; line-height: 1.45; opacity: .85; }
    code { font-size: .8rem; color: #9db4ff; }
    .dot { display: inline-block; width: .45rem; height: .45rem; margin: 0 .15rem;
      border-radius: 50%; background: #6b8cff; animation: pulse 1.2s infinite ease-in-out; }
    .dot:nth-child(2) { animation-delay: .2s; }
    .dot:nth-child(3) { animation-delay: .4s; }
    @keyframes pulse { 0%, 80%, 100% { opacity: .25; transform: scale(.85); }
      40% { opacity: 1; transform: scale(1); } }
  </style>
</head>
<body>
  <div class="box">
    <div style="margin-bottom:1rem"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    <h1>Waiting for your app</h1>
    <p>Cannot reach <code>${safeTarget}</code> yet (still compiling or not started). This page retries every 2s.</p>
  </div>
  <script>setTimeout(function () { location.reload(); }, 2000);</script>
</body>
</html>`;
              httpRes.writeHead(502, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store'
              });
              httpRes.end(html);
            }
          } else if (res && 'destroy' in res && typeof (res as any).destroy === 'function') {
            (res as any).destroy();
          }
        }
      }
    });

    app.use('/', proxyMiddleware);

    const server = http.createServer(app);

    server.on('upgrade', (req, socket, head) => {
      proxyMiddleware.upgrade(req, socket as any, head);
    });

    server.listen(port, () => {
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        server,
        port: boundPort,
        close: () => {
          return new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          });
        }
      });
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}
