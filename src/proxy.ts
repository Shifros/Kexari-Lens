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
            const httpRes = res as any;
            if (!httpRes.headersSent) {
              httpRes.writeHead(502, { 'Content-Type': 'text/plain' });
              httpRes.end(`Kexari Lens Proxy Error: Could not connect to Next.js dev server at ${targetUrl}. Is it running?\n\nError: ${err.message}`);
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
