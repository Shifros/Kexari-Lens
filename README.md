# Kexari Lens

A VS Code / Cursor extension that lets you inspect a running React app inside the editor. Hover to highlight, click to copy a ready-to-use AI prompt with the component name, **exact file path**, line number, and element markup.

## Getting started

1. Open your **app folder** in VS Code / Cursor (the same project you will run).
2. Start the app yourself: `npm run dev`.
3. Install Kexari Lens and click **Connect** (default `localhost:3000`).

If `@kexari-lens/dev` is missing or mis-wired, Connect asks to **Install / Repair**. After that, **restart `npm run dev`**, then Connect again.

## Compatibility (how Lens integrates)

Lens detects **installed** Next/React versions (from `node_modules` when present) and applies a fixed strategy — it does **not** use Turbopack loader rules (those caused `page.tsx.tsx` module errors on Next 16).

| Stack | Path strategy |
| --- | --- |
| **Next.js 13–15** (default `next dev`) | `withKexariLens(config)` — webpack plugin (`dev`-gated) |
| **Next.js 15** with `--turbo` / `--turbopack` | Switches `dev` to `next dev --webpack` + wrapper |
| **Next.js 16+** (Turbopack default) | `next dev --webpack` + wrapper (adds plugin + empty `turbopack` at runtime) |
| **Vite** | `withKexariVite(config)` |
| **React 19+** | Compile plugin **required** (Fiber `_debugSource` removed) |
| **React 17–18** | Fiber path fallback in the inspector + plugin for reliable Next paths |

Install / Repair will:

- Vendor `@kexari-lens/dev` under `.kexari/` (gitignored)
- Patch config by **wrapping** the default export (`withKexariLens` / `withKexariVite`) — it never rewrites your `webpack()` body or `plugins: [...]` one-liners
- Strip any old broken turbopack / inline injects, refuse to write invalid patches
- Adjust `npm run dev` only when required for webpack

## Why the plugin?

React 19 removed Fiber `_debugSource`. Exact file paths need a small **dev-only** compile-time plugin that injects `data-kexari-source` on JSX host elements. `withKexariLens` only pushes that plugin when `dev` is true — production builds stay clean.

## What it does

- Opens your running app in a VS Code panel (via a local proxy)
- Hover highlight, click to copy AI context
- Shift/Ctrl/Cmd+Click multi-select
- Viewport breakpoint stamp
- **Code** jumps to the resolved file when the path is known

## Requirements

- App folder open in the editor (same project as the running server)
- `npm run dev` already running
- Next.js or Vite + React for file paths (preview works without paths on other stacks)

## Manual plugin setup (optional)

Prefer the Connect prompt. Or:

```bash
npm install -D @kexari-lens/dev
```

**Next.js (preferred — also use on Next 16 via `next dev --webpack`)**

```js
import { withKexariLens } from '@kexari-lens/dev';

const nextConfig = {
  // your existing options / webpack() stay untouched
};
export default withKexariLens(nextConfig);
```

```json
{ "scripts": { "dev": "next dev --webpack" } }
```

**Vite**

```js
import { withKexariVite } from '@kexari-lens/dev';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default withKexariVite(
  defineConfig({
    plugins: [react()],
  })
);
```

Until the package is on the public npm registry, Connect vendors it under `.kexari/` and installs via `file:./.kexari/kexari-lens-dev`.

## Install extension from source

```
npm install
npm run package
```

Install the `.vsix` via **Extensions: Install from VSIX...**.

## License

MIT, see [LICENSE](LICENSE).
