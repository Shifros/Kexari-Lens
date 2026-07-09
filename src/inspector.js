(function () {
  // Prevent duplicate insertion
  if (window.__kexari_lens_injected__) return;
  window.__kexari_lens_injected__ = true;

  console.log('[Kexari Lens] Visual inspector active.');

  let inspectorEnabled = true;

  // Create badge element
  const badge = document.createElement('div');
  badge.id = 'kexari-lens-badge';
  Object.assign(badge.style, {
    position: 'fixed',
    zIndex: '9999999',
    backgroundColor: '#6366f1',
    color: '#ffffff',
    padding: '3px 8px',
    fontSize: '11px',
    fontFamily: 'monospace',
    borderRadius: '4px',
    pointerEvents: 'none',
    display: 'none',
    boxShadow: '0 2px 5px rgba(0,0,0,0.2)',
    fontWeight: 'bold',
    transition: 'top 0.1s, left 0.1s'
  });
  document.body.appendChild(badge);

  // Helper to parse stack traces from React 19 _debugStack
  function parseStack(debugStack) {
    if (!debugStack) return null;
    let stack = '';
    if (typeof debugStack === 'string') {
      stack = debugStack;
    } else if (debugStack.stack) {
      stack = debugStack.stack;
    } else {
      return null;
    }

    const lines = stack.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Regex to match webpack-internal URLs or localhost/file URLs with line numbers
      const match = line.match(/at\s+(?:(?:\s|\w|\$|<|>|\[|\]|\.)+\s+)?\((?:webpack-internal:\/\/\/\(.*\)\/|http:\/\/localhost:\d+\/|file:\/\/+)?([^?)]+)(?:\?[^)]*)?:(\d+):(\d+)\)/) ||
                    line.match(/at\s+(?:webpack-internal:\/\/\/\(.*\)\/|http:\/\/localhost:\d+\/|file:\/\/+)?([^?:\s)]+)(?:\?[^:\s)]*)?:(\d+):(\d+)/);
      
      if (match) {
        let filePath = match[1];
        const lineNum = parseInt(match[2], 10);

        // Normalize separators
        filePath = filePath.replace(/\\/g, '/');

        // Ignore third-party and framework internals
        const lowerPath = filePath.toLowerCase();
        if (lowerPath.includes('node_modules') || 
            lowerPath.includes('next/dist') || 
            lowerPath.includes('react-dom') || 
            lowerPath.includes('react-stack-top-frame') ||
            lowerPath.includes('kexari-inspector.js')) {
          continue;
        }

        // Clean path prefixes
        filePath = filePath.replace(/^webpack-internal:\/\/\/\([^)]+\)\//, '');
        filePath = filePath.replace(/^\.\//, '');
        filePath = filePath.replace(/^file:\/\/\//, '');
        filePath = filePath.replace(/^http:\/\/localhost:\d+\//, '');

        return {
          fileName: filePath,
          lineNumber: lineNum
        };
      }
    }
    return null;
  }

  // Helper to extract React Fiber details
  function getReactInfo(element) {
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    if (!key) return null;

    let fiber = element[key];
    
    let userComponentName = null;
    let userFileName = null;
    let userLineNumber = null;

    let fallbackComponentName = null;
    let fallbackFileName = null;
    let fallbackLineNumber = null;

    while (fiber) {
      let fiberFile = null;
      let fiberLine = null;

      if (fiber._debugSource) {
        fiberFile = fiber._debugSource.fileName;
        fiberLine = fiber._debugSource.lineNumber;
      } else if (fiber._debugStack) {
        const stackInfo = parseStack(fiber._debugStack);
        if (stackInfo) {
          fiberFile = stackInfo.fileName;
          fiberLine = stackInfo.lineNumber;
        }
      }

      if (fiberFile) {
        fiberFile = fiberFile.replace(/\\/g, '/');
        const isNodeModule = fiberFile.toLowerCase().includes('node_modules') || fiberFile.toLowerCase().includes('next/dist');
        
        if (!isNodeModule) {
          if (!userFileName) {
            userFileName = fiberFile;
            userLineNumber = fiberLine;
          }
        } else {
          if (!fallbackFileName) {
            fallbackFileName = fiberFile;
            fallbackLineNumber = fiberLine;
          }
        }
      }

      if (fiber.type) {
        let name = null;
        if (typeof fiber.type === 'function') {
          name = fiber.type.name || fiber.type.displayName;
        } else if (typeof fiber.type === 'object') {
          name = fiber.type.displayName || fiber.type.name || fiber.type.render?.name;
        }

        if (name && name[0] === name[0].toUpperCase()) {
          const ignoredNames = [
            'Root', 'App', 'Layout', 'ServerRoot', 'Outer', 'Provider', 'Connect', 'Link', 'Image', 'html', 'body', 'Route', 'Router', 'Redirect', 'Switch',
            'NextFiber', 'StaticGenerationSearchParamsBypassProvider', 'AppRouterHeadersProvider',
            'MotionDOMComponent', 'AnimatePresence', 'LazyMotion', 'motion', 'Motion', 'PresenceChild',
            'Slot', 'Primitive', 'SlotChild', 'ForwardRef', 'Consumer', 'Context',
            'ClientPageRoot', 'ClientRoot', 'HotReload', 'Webpack', 'Next', 'Server', 'StaticGroup', 'OuterLayoutRouter'
          ];
          if (!ignoredNames.includes(name) && !name.startsWith('Next') && !name.startsWith('Webpack') && !name.startsWith('HotReload')) {
            const isNodeModule = fiberFile && (fiberFile.toLowerCase().includes('node_modules') || fiberFile.toLowerCase().includes('next/dist'));
            
            if (!isNodeModule) {
              if (!userComponentName) {
                userComponentName = name;
              }
            } else {
              if (!fallbackComponentName) {
                fallbackComponentName = name;
              }
            }
          }
        }
      }

      fiber = fiber.return;
    }

    return {
      componentName: userComponentName || fallbackComponentName || null,
      fileName: userFileName || fallbackFileName || null,
      lineNumber: userLineNumber || fallbackLineNumber || null
    };
  }

  // Monitor URL changes to notify the main extension bar
  function reportUrlChange() {
    window.parent.postMessage({
      type: 'KEXARI_LENS_URL_CHANGED',
      payload: {
        url: window.location.href,
        pathname: window.location.pathname
      }
    }, '*');
  }

  // Report URL immediately on initialization
  reportUrlChange();

  // Listen to popstate for back/forward navigation reporting
  window.addEventListener('popstate', reportUrlChange);

  // Monkey-patch history methods to track SPA client-side navigations (Next.js Link clicks)
  const pushStateOrig = window.history.pushState;
  const replaceStateOrig = window.history.replaceState;

  window.history.pushState = function (...args) {
    pushStateOrig.apply(this, args);
    reportUrlChange();
  };

  window.history.replaceState = function (...args) {
    replaceStateOrig.apply(this, args);
    reportUrlChange();
  };

  // Receive commands from parent VS Code Webview
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg) {
      if (msg.type === 'KEXARI_LENS_SET_STATE') {
        inspectorEnabled = msg.enabled;
        if (!inspectorEnabled) {
          // Hide badge and clear outlines
          badge.style.display = 'none';
          const activeEl = document.querySelector('[data-kexari-prev-outline]');
          if (activeEl) {
            activeEl.style.outline = activeEl.dataset.kexariPrevOutline || '';
            delete activeEl.dataset.kexariPrevOutline;
          }
        }
      } else if (msg.type === 'KEXARI_LENS_NAVIGATE') {
        if (msg.action === 'reload') {
          window.location.reload();
        } else if (msg.action === 'back') {
          window.history.back();
        } else if (msg.action === 'forward') {
          window.history.forward();
        }
      }
    }
  });

  // Mouse over handler to highlight and show badge
  document.addEventListener('mouseover', (e) => {
    if (!inspectorEnabled) return;
    const el = e.target;
    if (!el || el === badge || badge.contains(el)) return;

    // Highlight element using layout-safe outline
    el.dataset.kexariPrevOutline = el.style.outline;
    el.style.outline = '2px solid #6366f1';
    el.style.outlineOffset = '-2px';

    // Extract React info to display on the badge
    const info = getReactInfo(el);
    const componentName = info?.componentName || el.tagName.toLowerCase();
    
    badge.textContent = componentName;
    badge.style.display = 'block';

    // Position badge
    const rect = el.getBoundingClientRect();
    let top = rect.top - 24;
    let left = rect.left;

    // Boundary checks
    if (top < 5) {
      top = rect.top + 5;
    }
    if (left < 5) {
      left = 5;
    }
    
    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
  }, true);

  // Mouse out handler to remove highlight and hide badge
  document.addEventListener('mouseout', (e) => {
    const el = e.target;
    if (!el || el === badge) return;

    if (el.dataset && 'kexariPrevOutline' in el.dataset) {
      el.style.outline = el.dataset.kexariPrevOutline || '';
      delete el.dataset.kexariPrevOutline;
    } else {
      el.style.outline = '';
    }

    badge.style.display = 'none';
  }, true);

  // Click handler to capture and send info
  document.addEventListener('click', (e) => {
    if (!inspectorEnabled) return;
    const el = e.target;
    if (!el || el === badge) return;

    // Prevent navigation / submit
    e.preventDefault();
    e.stopPropagation();

    const info = getReactInfo(el);
    
    const componentName = info?.componentName || 'Unknown';
    const fileName = info?.fileName || 'Unknown';
    const lineNumber = info?.lineNumber || 0;
    const tagName = el.tagName.toLowerCase();
    
    // Safely parse SVGAnimatedString classNames (SVG elements) to avoid postMessage DataCloneError
    const className = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');

    // Send payload to parent VS Code Webview
    window.parent.postMessage({
      type: 'KEXARI_LENS_INSPECTOR_CLICK',
      payload: {
        componentName,
        fileName,
        lineNumber,
        tagName,
        className
      }
    }, '*');
  }, true);
})();
