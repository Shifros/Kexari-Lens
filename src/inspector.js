(function () {
  // the proxy injects this on every page load, so bail if it's already here
  if (window.__kexari_lens_injected__) return;
  window.__kexari_lens_injected__ = true;

  console.log('[Kexari Lens] Visual inspector active.');

  let inspectorEnabled = true;

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

  // React 19 dropped _debugSource, but it still attaches an Error to each fiber
  // (_debugStack) captured at the point the JSX was written. We parse that stack
  // to recover the file and line, same idea as _debugSource used to give us.
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
      const match = line.match(/at\s+(?:(?:\s|\w|\$|<|>|\[|\]|\.)+\s+)?\((?:webpack-internal:\/\/\/\(.*\)\/|http:\/\/localhost:\d+\/|file:\/\/+)?([^?)]+)(?:\?[^)]*)?:(\d+):(\d+)\)/) ||
                    line.match(/at\s+(?:webpack-internal:\/\/\/\(.*\)\/|http:\/\/localhost:\d+\/|file:\/\/+)?([^?:\s)]+)(?:\?[^:\s)]*)?:(\d+):(\d+)/);
      
      if (match) {
        let filePath = match[1];
        const lineNum = parseInt(match[2], 10);
        filePath = filePath.replace(/\\/g, '/');

        const lowerPath = filePath.toLowerCase();
        if (lowerPath.includes('node_modules') || 
            lowerPath.includes('next/dist') || 
            lowerPath.includes('react-dom') || 
            lowerPath.includes('react-stack-top-frame') ||
            lowerPath.includes('kexari-inspector.js')) {
          continue;
        }

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

  // Walks up the fiber tree from a DOM node looking for the nearest named
  // component and its source location. We keep a separate "fallback" result
  // for anything that resolves into node_modules, since we'd rather show the
  // user's own component than a UI library wrapper if one is available.
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

  function reportUrlChange() {
    window.parent.postMessage({
      type: 'KEXARI_LENS_URL_CHANGED',
      payload: {
        url: window.location.href,
        pathname: window.location.pathname
      }
    }, '*');
  }

  reportUrlChange();
  window.addEventListener('popstate', reportUrlChange);

  // Next.js <Link> navigation uses pushState/replaceState directly instead of
  // firing popstate, so we patch these to catch client-side route changes too.
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

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg) {
      if (msg.type === 'KEXARI_LENS_SET_STATE') {
        inspectorEnabled = msg.enabled;
        if (!inspectorEnabled) {
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

  document.addEventListener('mouseover', (e) => {
    if (!inspectorEnabled) return;
    const el = e.target;
    if (!el || el === badge || badge.contains(el)) return;

    // outline instead of border so we don't shift layout on hover
    el.dataset.kexariPrevOutline = el.style.outline;
    el.style.outline = '2px solid #6366f1';
    el.style.outlineOffset = '-2px';

    const info = getReactInfo(el);
    const componentName = info?.componentName || el.tagName.toLowerCase();
    
    badge.textContent = componentName;
    badge.style.display = 'block';

    const rect = el.getBoundingClientRect();
    let top = rect.top - 24;
    let left = rect.left;

    // keep the badge on screen when hovering near the top/left edge
    if (top < 5) {
      top = rect.top + 5;
    }
    if (left < 5) {
      left = 5;
    }
    
    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
  }, true);

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

  document.addEventListener('click', (e) => {
    if (!inspectorEnabled) return;
    const el = e.target;
    if (!el || el === badge) return;

    // we're intercepting the click to inspect the element, not to follow links or submit forms
    e.preventDefault();
    e.stopPropagation();

    const info = getReactInfo(el);
    
    const componentName = info?.componentName || 'Unknown';
    const fileName = info?.fileName || 'Unknown';
    const lineNumber = info?.lineNumber || 0;
    const tagName = el.tagName.toLowerCase();
    
    // SVG elements expose className as an SVGAnimatedString, not a plain string,
    // and that object can't be sent through postMessage
    const className = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');

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
