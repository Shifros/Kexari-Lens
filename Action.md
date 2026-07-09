

```text
# Role & Objective
You are an expert VS Code Extension Developer and React/Next.js engineer. We are building a VS Code Extension named "Kexari Lens". 

The goal is to recreate a "Design Mode" visual inspector. The extension will open a VS Code Webview showing a Next.js local server (localhost:3000). When the user hovers over the preview, it highlights DOM elements. When they click an element, it extracts the React component name, the source file path, and the computed CSS/Tailwind classes, formats this data into an AI prompt, and copies it to the user's clipboard.

# Technical Constraints & 2026 App Router Context
1. **The Iframe CORS Problem:** We cannot directly inject scripts into an iframe loading `localhost:3000` from a `vscode-webview://` environment due to strict Cross-Origin constraints. 
2. **The Proxy Solution:** The extension must spin up a lightweight local Express proxy server (e.g., on port 3001) that proxies requests to `localhost:3000`. The proxy must intercept the HTML response and inject our custom "inspector" content script right before the `</body>` tag. The VS Code Webview will load `http://localhost:3001`.
3. **React Fiber Extraction:** Next.js App Router uses Turbopack/SWC. To identify components without forcing the user to install Babel plugins, the injected script must use React Fiber traversal.

# Step-by-Step Implementation Plan

Please scaffold the extension and implement the following architecture:

## Step 1: Extension Scaffolding & Commands
- Set up a standard VS Code extension using TypeScript.
- Register a command `kexariLens.start` that opens a webview panel in an adjacent editor column.
- The webview HTML should simply contain an `iframe` pointing to the proxy server (`http://localhost:3001`) taking up 100% width/height.

## Step 2: The Express Proxy Server
- Implement an Express server inside the extension that starts when the command is run.
- Use `http-proxy-middleware` to proxy all requests to `http://localhost:3000`.
- Intercept the proxy response (using something like `harmon` or regex string replacement on the stream) to inject a `<script>` tag containing our inspector logic into the Next.js HTML stream.

## Step 3: The Injected Inspector Script (The Core Logic)
Write the injected JavaScript to handle the visual UI and data extraction:
- **Hover UI:** Add a `mouseover` event listener that applies a subtle colored border (e.g., `2px solid #6366f1` - Indigo) to the hovered element, and removes it on `mouseout`.
- **Click Interception:** Add a `click` listener with `e.preventDefault()` and `e.stopPropagation()`.
- **Fiber Traversal:** When clicked, find the DOM node's React Fiber node by iterating through `Object.keys(element).find(key => key.startsWith('__reactFiber$'))`.
- Traverse *up* the Fiber tree (`fiber.return`) until you find a node where `typeof fiber.type === 'function'` (a React Component).
- Extract:
  1. Component Name (`fiber.type.name`).
  2. Source path (`fiber._debugSource.fileName` and `lineNumber` - if available in dev mode).
  3. The DOM element's tag and current `className`.
- **Data Transport:** Send this extracted data payload back to the parent VS Code Webview using `window.parent.postMessage()`.

## Step 4: Webview -> Extension Messaging
- The VS Code Webview should listen for the `message` event from the iframe.
- When it receives the extracted React data, it forwards it to the VS Code Extension backend using `vscode.postMessage`.

## Step 5: Formatting & Clipboard Hand-off
- In the extension backend (`extension.ts`), receive the payload.
- Format a clean prompt block. Example format:

```

[Kexari Lens Context]
Target Component: {ComponentName}
File Path: {fileName}:{lineNumber}
Element: <{tagName} className="{className}">

Instruction:

```
- Use `vscode.env.clipboard.writeText()` to copy this formatted prompt directly to the user's clipboard.
- Trigger a `vscode.window.showInformationMessage('Kexari Lens: Context copied to clipboard!')`.

# Execution
Begin by creating the `package.json`, the main `extension.ts`, and the proxy/script injection logic. Ensure all necessary npm packages (express, http-proxy-middleware) are added to dependencies.

```

### How to execute this effectively:

1. Open an empty folder in Cursor where you want the extension code to live.
2. Open **Composer** (not the standard chat sidebar).
3. Paste the entire prompt above.
4. Let Composer generate the workspace. It should create the `package.json`, set up the TypeScript configuration, and write the Express proxy and React Fiber extraction logic automatically.
5. Once it finishes, run `npm install` and hit `F5` in Cursor to launch the Extension Development Host and test it against a running Next.js project.