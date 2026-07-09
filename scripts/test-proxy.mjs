import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { startProxyServer } from '../out/proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const inspectorScriptPath = path.join(extensionRoot, 'src', 'inspector.js');

const MOCK_PORT = 3456;
const PROXY_PORT = 3457;

function startMockNextServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url?.startsWith('/?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><title>Mock Next.js</title></head><body><div id="app">Hello Kexari</div></body></html>`);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, text };
}

async function runTests() {
  const mockServer = await startMockNextServer();
  const proxy = await startProxyServer(
    PROXY_PORT,
    `http://127.0.0.1:${MOCK_PORT}`,
    inspectorScriptPath
  );

  try {
    const home = await fetchText(`http://127.0.0.1:${PROXY_PORT}/`);
    if (home.status !== 200) {
      throw new Error(`Expected proxy home status 200, got ${home.status}`);
    }
    if (!home.text.includes('<script src="/kexari-inspector.js"></script>')) {
      throw new Error('Inspector script tag was not injected into HTML');
    }

    const inspector = await fetchText(`http://127.0.0.1:${PROXY_PORT}/kexari-inspector.js`);
    if (inspector.status !== 200) {
      throw new Error(`Expected inspector script status 200, got ${inspector.status}`);
    }
    if (!inspector.text.includes('KEXARI_LENS_INSPECTOR_CLICK')) {
      throw new Error('Inspector script payload marker missing');
    }

    console.log('PASS: HTML injection works');
    console.log('PASS: Inspector script is served');
    console.log('All proxy integration tests passed.');
  } finally {
    await proxy.close();
    await new Promise((resolve) => mockServer.close(resolve));
  }
}

runTests().catch((error) => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
