import express from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import * as http from 'http';
import * as fs from 'fs';

export interface ProxyServerInstance {
  server: http.Server;
  close: () => Promise<void>;
}

export function startProxyServer(
  port: number,
  targetUrl: string,
  inspectorScriptPath: string
): Promise<ProxyServerInstance> {
  return new Promise((resolve, reject) => {
    const app = express();

    // Serve the inspector script directly
    app.get('/kexari-inspector.js', (req, res) => {
      if (fs.existsSync(inspectorScriptPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.sendFile(inspectorScriptPath);
      } else {
        res.status(404).send('Inspector script not found');
      }
    });

    // Configure proxy middleware
    const proxyMiddleware = createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      selfHandleResponse: true, // Required for responseInterceptor
      ws: true, // Enable websocket proxying
      on: {
        proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
          const contentType = proxyRes.headers['content-type'];
          if (contentType && contentType.includes('text/html')) {
            const html = responseBuffer.toString('utf8');
            // Inject the inspector script before the closing </body> tag
            if (html.includes('</body>')) {
              return html.replace(
                '</body>',
                `<script src="/kexari-inspector.js"></script></body>`
              );
            }
            // Fallback: append at the end of html if no body tag found
            return html + `<script src="/kexari-inspector.js"></script>`;
          }
          return responseBuffer;
        }),
        error: (err, req, res) => {
          console.error('[Kexari Lens Proxy Error]:', err);
          // Only send response if headers have not been sent yet
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

    // Use proxy middleware for all other requests
    app.use('/', proxyMiddleware);

    const server = http.createServer(app);

    // Setup WebSockets (WS) proxying for Hot Module Replacement (HMR)
    server.on('upgrade', (req, socket, head) => {
      proxyMiddleware.upgrade(req, socket as any, head);
    });

    server.listen(port, () => {
      resolve({
        server,
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
