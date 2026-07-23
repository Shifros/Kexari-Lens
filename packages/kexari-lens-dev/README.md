# @kexari-lens/dev

Dev-only compile-time source injection for [Kexari Lens](https://github.com/Shifros/Kexari-Lens).

Injects `data-kexari-source` and `data-kexari-component` onto JSX/TSX host elements so the VS Code extension can resolve exact file paths on **React 19** (where Fiber `_debugSource` is gone).

Does nothing in production builds.

## Install

```bash
npm install -D @kexari-lens/dev
```

## Next.js (webpack — default `next dev`)

```js
// next.config.js
import { kexariLens } from '@kexari-lens/dev';

const nextConfig = {
  webpack: (config, { dev }) => {
    if (dev) {
      config.plugins.push(kexariLens({ bundler: 'webpack' }));
    }
    return config;
  },
};

export default nextConfig;
```

## Next.js 15 + Turbopack

```js
import { kexariLens } from '@kexari-lens/dev';

const nextConfig = {
  // Next >= 15.3
  turbopack: {
    rules: kexariLens({ bundler: 'turbopack' }),
  },
  // Next 15.0–15.2: use experimental.turbo.rules instead
};

export default nextConfig;
```

## Vite

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { kexariLens } from '@kexari-lens/dev';

export default defineConfig({
  plugins: [react(), kexariLens({ bundler: 'vite' })],
});
```

## Attributes

| Attribute | Example |
|-----------|---------|
| `data-kexari-source` | `src/components/Header.tsx:48:5` |
| `data-kexari-component` | `Header` |

Set `KEXARI_LENS_DEV=0` to disable injection without removing the plugin.
