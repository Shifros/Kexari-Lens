# Kexari Lens

A VS Code extension that lets you inspect a running Next.js app right inside the editor. Hover over anything in the preview and it highlights the element. Click it and Kexari Lens grabs the component name, the file it lives in, and the line number, then copies a ready-to-use prompt to your clipboard.

Built for people who use AI coding assistants and got tired of manually digging through files to point them at the right component.

## Why this exists

If you're building a Next.js site and want an AI assistant to change a specific button or section, you usually have to go find the file yourself, figure out the component name, and describe the element in words. This extension skips that step. Click the element, get the context, paste it into your assistant.

## What it does

- Opens your Next.js dev server inside a VS Code panel
- Highlights whatever you hover over
- On click, figures out which React component rendered that element and where it's defined
- Copies a formatted block to your clipboard with the component name, file path, line number, and the element's tag/classes
- Has a toggle so you can turn off the inspector and just browse your site normally
- Has basic back/forward/reload controls and a URL bar, so you're not stuck on one page

## How it works

Browsers block scripts from reaching into an iframe that's loading a different origin (`localhost:3000` inside a `vscode-webview://` page counts as different origins). To get around that, the extension runs a small proxy server on port 3001. The webview loads the proxy instead of your Next.js server directly. The proxy fetches pages from your dev server, injects a small inspector script into the HTML, and passes the result along.

Once that script is running inside the page, it listens for hovers and clicks. On click, it walks up the React Fiber tree attached to the DOM node until it finds a component with a name, then reads the source location React attaches in dev mode. That data gets sent from the iframe to the webview to the extension, which copies a formatted prompt to your clipboard.

```
Extension  --spawns-->  Proxy (3001)  --proxies-->  Next.js dev server (3000)
                              |
                     injects inspector.js into the HTML
                              |
                     runs inside the page, tracks hover/click
                              |
                     sends data back up to the extension
```

If the extension can't map an element back to your own code (say it landed on a wrapper from a UI library, or an icon from `lucide-react`), it searches your workspace for a file that actually defines that component name and uses that instead, skipping anything in `node_modules` or build output.

## Requirements

Your Next.js app needs to be running in dev mode on `localhost:3000`:

```
npm run dev
```

Source maps and dev-mode metadata are what make the component lookup possible, so this won't work against a production build.

## Getting started

1. Open your Next.js project in VS Code.
2. Make sure `npm run dev` is running on port 3000.
3. Install the extension (see below), or press F5 if you're working on the extension itself.
4. Open the command palette and run **Kexari Lens: Start Inspector**.
5. A panel opens next to your editor showing your site. Hover to highlight, click to copy.

## What you get on your clipboard

```
[Kexari Lens Context]
Target Component: HeroSection
File Path: app/components/HeroSection.tsx:12
Element: <button className="px-4 py-2 bg-indigo-500 text-white rounded-md">

Instruction:
```

Paste that into your AI assistant and add what you actually want changed after "Instruction:".

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
