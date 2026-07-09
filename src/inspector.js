(function () {
  // Prevent duplicate insertion
  if (window.__kexari_lens_injected__) return;
  window.__kexari_lens_injected__ = true;

  console.log('[Kexari Lens] Visual inspector active.');

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

  // Helper to extract React Fiber details
  function getReactInfo(element) {
    const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
    if (!key) return null;

    let fiber = element[key];
    let componentName = null;
    let fileName = null;
    let lineNumber = null;

    while (fiber) {
      if (!fileName && fiber._debugSource) {
        fileName = fiber._debugSource.fileName;
        lineNumber = fiber._debugSource.lineNumber;
      }

      if (fiber.type) {
        let name = null;
        if (typeof fiber.type === 'function') {
          name = fiber.type.name || fiber.type.displayName;
        } else if (typeof fiber.type === 'object') {
          name = fiber.type.displayName || fiber.type.name || fiber.type.render?.name;
        }

        const ignoredNames = [
          'Root', 'App', 'Layout', 'ServerRoot', 'Outer', 'Provider', 'Connect', 'Link', 'Image', 'html', 'body', 'Route', 'Router', 'Redirect', 'Switch',
          'NextFiber', 'StaticGenerationSearchParamsBypassProvider', 'AppRouterHeadersProvider'
        ];
        if (name && !ignoredNames.includes(name) && !name.startsWith('Next') && !name.startsWith('Webpack') && !name.startsWith('HotReload')) {
          if (!componentName) {
            componentName = name;
          }
        }
      }

      fiber = fiber.return;
    }

    return {
      componentName: componentName || null,
      fileName: fileName || null,
      lineNumber: lineNumber || null
    };
  }

  // Mouse over handler to highlight and show badge
  document.addEventListener('mouseover', (e) => {
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
    const className = el.className || '';

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
