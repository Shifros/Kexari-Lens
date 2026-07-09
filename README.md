# Kexari Lens 🔍

An open-source visual element inspector and React context extractor VS Code extension designed specifically for **Next.js App Router** applications.

Recreate the ultimate interactive design and debugging workflow. Kexari Lens displays your running Next.js application inside an adjacent VS Code Webview panel, lets you visually highlight elements on hover, and extracts precise React component hierarchy and source location on click directly to your clipboard as structured context for LLMs.

---

## 🚀 Key Features

- **Zero-Babel Config React Traverser**: Traverses the React Fiber tree dynamically in development mode. No custom compiler plugins, Babel configurations, or source maps required.
- **Smart Express Proxy Server**: Automatically spins up a background proxy server on port `3001` that bridges requests to your local Next.js server (`localhost:3000`).
- **Dynamic Script Injection**: Injecting the client-side inspector securely on the fly, avoiding iframe CORS / same-origin policy limitations.
- **HMR & WebSocket Friendly**: Seamlessly forwards Hot Module Replacement (HMR) WebSockets so Next.js fast-refresh continues to work without disruption.
- **Visual Hover Highlighting**: Non-disruptive, layout-safe outline hover overlays that won't shift your DOM layout.
- **Floating Element Badge**: Automatically shows the custom React component name or HTML tag name next to the hovered element.
- **Instant LLM Context Copy**: Clicking any element extracts the component name, relative source file path, line number, tag name, and class list, formats them as a clean prompt block, and copies it directly to your system clipboard.

---

## 🛠️ How It Works

```
┌─────────────────────────────────┐
│     VS Code Extension Host     │
└────────┬────────────────────────┘
         │ (1) Spawns
┌────────▼────────────────────────┐
│     Express Proxy Server        │◄─── (3) Injects inspector.js script
│         (Port 3001)             │
└────────┬────────▲───────────────┘
         │        │ (2) Proxies
┌────────▼────────┴───────────────┐
│      Next.js Dev Server         │
│         (Port 3000)             │
└─────────────────────────────────┘
```

1. **Initialization**: When you start Kexari Lens, the extension boots up a lightweight local Express proxy server (port `3001`).
2. **Webview Presentation**: It opens a VS Code Webview displaying the proxy URL.
3. **HTML Interception**: The proxy intercepts the HTML stream from Next.js, and injects our custom inspector script right before `</body>`.
4. **Fiber Inspection**: When you hover/click an element, the script traverses the React Fiber tree (`__reactFiber$`) up to identify the nearest component name and original file path / line number (`_debugSource`).
5. **Extension IPC**: The script dispatches a `window.parent.postMessage` to the Webview, which forwards it to the Extension backend, copying a structured prompt format directly to your clipboard.

---

## 📦 Requirements

- **Next.js Application** running in development mode (`npm run dev`) on `http://localhost:3000`.

---

## 💻 Installation & Usage

1. Open your Next.js project in VS Code.
2. Ensure your Next.js dev server is running on port `3000` (`npm run dev`).
3. Press `F5` in VS Code to run/debug the extension, or package the extension as a VSIX.
4. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`) and type:
   ```
   Kexari Lens: Start Inspector
   ```
5. A webview tab containing your Next.js application will open to the side. Hover to highlight React components, and click any element to copy its full context directly to your clipboard!

---

## 📜 Formatted Clipboard Output

When you click an element, Kexari Lens copies a prompt context formatted like this:

```text
[Kexari Lens Context]
Target Component: HeroSection
File Path: app/components/HeroSection.tsx:12
Element: <button className="px-4 py-2 bg-indigo-500 text-white rounded-md">

Instruction:
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit Pull Requests or open Issues to propose improvements, bug fixes, or new features.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
