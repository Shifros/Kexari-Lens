# Kexari Lens

A VS Code extension that lets you inspect a running Next.js app right inside the editor. Hover over anything in the preview and it highlights the element. Click it and Kexari Lens grabs the component name, the file it lives in, and the line number, then copies a ready-to-use prompt to your clipboard.

Built for people who use AI coding assistants and got tired of manually digging through files to point them at the right component.

## Why this exists

If you're building a Next.js site and want an AI assistant to change a specific button or section, you usually have to go find the file yourself, figure out the component name, and describe the element in words. This extension skips that step. Click the element, get the context, paste it into your assistant.

## What it does

- Opens your Next.js dev server inside a VS Code panel
- Asks which dev server to inspect (any port, host:port, or full URL) instead of assuming `localhost:3000` — run the command again with a different port to inspect several projects at once, each in its own panel
- Highlights whatever you hover over
- On click, figures out which React component rendered that element and where it's defined
- Copies a formatted block to your clipboard with the component name, file path, line number, and the element's tag/classes
- Shift+Click to select multiple elements at once (useful when you want an AI to align or normalize several pieces together)
- Stamps every click with the current viewport width and breakpoint (Mobile / Tablet / Desktop), so responsive fixes don't accidentally rewrite the wrong screen size
- Hover shows a component label; after you select an element, use the **Code** button in the toolbar to jump to that line — it lands on the actual text/JSX, not just the nearest wrapper
- Has a toggle so you can turn off the inspector and just browse your site normally
- Has basic back/forward/reload controls and a URL bar, so you're not stuck on one page

## How it works

Browsers block scripts from reaching into an iframe that's loading a different origin (`localhost:3000` inside a `vscode-webview://` page counts as different origins). To get around that, the extension spins up a small proxy server on a free local port for each dev server you inspect. The webview loads the proxy instead of your Next.js server directly. The proxy fetches pages from your dev server, injects a small inspector script into the HTML, and passes the result along.

Once that script is running inside the page, it listens for hovers and clicks. On click, it walks up the React Fiber tree attached to the DOM node until it finds a component with a name, then reads the source location React attaches in dev mode. That data gets sent from the iframe to the webview to the extension, which copies a formatted prompt to your clipboard.

```
Extension  --spawns-->  Proxy (auto-assigned port)  --proxies-->  Next.js dev server (the port you entered)
                              |
                     injects inspector.js into the HTML
                              |
                     runs inside the page, tracks hover/click
                              |
                     sends data back up to the extension
```

Each panel gets its own proxy, so pointing one panel at `localhost:3000` and another at `localhost:3001` (or any other project's dev server) doesn't cause them to collide.

When React only gives a compiled Next.js chunk path (like `_next/static/chunks/...`), the extension fetches that chunk's source map and maps the line back to your original `.tsx` / `.jsx` file. If the resolved path is only a filename or partial hint, it's matched against the real file in your workspace, skipping `node_modules` and build output. Chunk paths are never copied to the clipboard, and if nothing resolves, **Code** just stays disabled instead of guessing.

Clicking **Code** opens that resolved file and line, then checks nearby lines in that same file for the element's own visible text, so you land on the title/paragraph/button label itself rather than the JSX wrapper around it. That check never leaves the file, so a duplicate label somewhere else in the project can't hijack the jump.

## Requirements

Your Next.js app needs to be running in dev mode:

```
npm run dev
```

It doesn't have to be on port 3000 — Kexari Lens asks which port/URL to connect to, so `npm run dev -- -p 3002` works just as well. Source maps and dev-mode metadata are what make the component lookup possible, so this won't work against a production build.

## Getting started

1. Open your Next.js project in VS Code.
2. Make sure `npm run dev` is running (any port).
3. Install the extension (see below), or press F5 if you're working on the extension itself.
4. Open the command palette and run **Kexari Lens: Start Inspector**, then enter the port (or full URL) of the dev server you want to inspect. It defaults to whatever you used last.
5. A panel opens showing your site. Hover to highlight, click to copy.
6. Hold Shift and click more elements to build a multi-selection. Shift+Click again on a selected element to remove it. Press Esc to clear.
7. After selecting an element, **Code** enables only when the path is known. It opens that file and line, snapping to the exact text if it's found nearby.
8. Working on more than one project at once? Run **Kexari Lens: Start Inspector** again and enter a different port — each dev server gets its own panel and its own proxy, running side by side. Running it again with a port that's already open just brings that panel back into focus instead of opening a duplicate.

## What you get on your clipboard

Single click:

```
[Kexari Lens Context]
Current Viewport: 390px (Mobile)
Target Component: HeroSection
File Path: app/components/HeroSection.tsx:12
Element: <button className="px-4 py-2 bg-indigo-500 text-white rounded-md">

Instruction:
```

Shift+Click (multi-select):

```
[Kexari Lens Context]
Mode: Multi-Element Targeting
Current Viewport: 390px (Mobile)
Selected Elements: 2

[1] Target Component: Navbar
File Path: app/components/Navbar.tsx:8
Element: <nav className="flex items-center gap-4">

[2] Target Component: HeroCTA
File Path: app/components/Hero.tsx:42
Element: <button className="inline-flex items-center px-6 py-3">

Instruction:
```

The viewport line uses the preview panel's actual width (`window.innerWidth` inside the iframe), mapped to Tailwind's default breakpoints:

- under 640px → Mobile
- 640–767px → Small
- 768–1023px → Tablet
- 1024–1279px → Desktop
- 1280px and up → Large Desktop

Paste that into your AI assistant and write your own instruction under `Instruction:`.

## Installing from source

```
npm install
npm run package
```

That produces a `.vsix` file you can install through **Extensions: Install from VSIX...** in VS Code.

## Contributing

Issues and pull requests are welcome. If you're fixing a bug, a quick description of how to reproduce it helps a lot.

## License

MIT, see [LICENSE](LICENSE).
