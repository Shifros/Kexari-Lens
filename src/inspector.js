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
    transition: 'top 0.1s, left 0.1s',
    maxWidth: 'min(420px, calc(100vw - 16px))',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap'
  });
  document.body.appendChild(badge);

  function hideBadge() {
    badge.style.display = 'none';
  }

  function parseKexariSourceAttr(raw) {
    if (!raw || typeof raw !== 'string') return null;
    // Format: path/to/File.tsx:line:col  (path may contain drive letters like C:/...)
    const match = raw.match(/^(.*):(\d+):(\d+)$/);
    if (!match) return null;
    return {
      fileName: match[1].replace(/\\/g, '/'),
      lineNumber: parseInt(match[2], 10) || 0,
      columnNumber: parseInt(match[3], 10) || 0
    };
  }

  /** Walk up the DOM for compile-time injected data-kexari-* attributes. */
  function findKexariSource(el) {
    let node = el;
    for (let i = 0; i < 40 && node && node !== document.body; i++) {
      if (node.getAttribute) {
        const raw = node.getAttribute('data-kexari-source');
        if (raw) {
          const parsed = parseKexariSourceAttr(raw);
          if (parsed) {
            return {
              ...parsed,
              componentName: node.getAttribute('data-kexari-component') || '',
              fromNode: node
            };
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function pageHasKexariInstrumentation() {
    try {
      return !!document.querySelector('[data-kexari-source]');
    } catch {
      return false;
    }
  }

  function notifyNeedsPlugin() {
    window.parent.postMessage({
      type: 'KEXARI_LENS_NEEDS_PLUGIN'
    }, '*');
  }

  function showBadgeForElement(el) {
    const injected = findKexariSource(el);
    const landmark = getDomLandmark(el);
    const info = getReactInfo(el, landmark);
    const componentName =
      injected?.componentName ||
      info?.componentName ||
      el.tagName.toLowerCase();
    const selectedCount = selection.length;

    badge.textContent = selectedCount > 0
      ? `${componentName}  ·  ${selectedCount} selected`
      : componentName;
    badge.style.display = 'block';

    const rect = el.getBoundingClientRect();
    let top = rect.top - 24;
    let left = rect.left;

    if (top < 5) {
      top = rect.top + 5;
    }
    if (left < 5) {
      left = 5;
    }

    badge.style.top = `${top}px`;
    badge.style.left = `${left}px`;
  }

  function notifySelectionCleared() {
    window.parent.postMessage({
      type: 'KEXARI_LENS_SELECTION_CLEARED'
    }, '*');
  }


  function isThirdPartyOrCompiled(filePath) {
    if (!filePath) return true;
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    return (
      lower.includes('node_modules') ||
      lower.includes('next/dist') ||
      lower.includes('/_next/') ||
      lower.includes('_next/') ||
      lower.includes('react-dom') ||
      lower.includes('react-stack-top-frame') ||
      lower.includes('kexari-inspector.js') ||
      lower.includes('/static/chunks/') ||
      /\/_?next\//.test(lower)
    );
  }

  function looksLikeSourceFile(filePath) {
    if (!filePath || isThirdPartyOrCompiled(filePath)) return false;
    const lower = filePath.toLowerCase().replace(/\\/g, '/');
    return (
      /\.(tsx|jsx|ts|mts|cts)$/.test(lower) ||
      lower.includes('/src/') ||
      lower.includes('/app/') ||
      lower.includes('/components/') ||
      lower.includes('/pages/')
    );
  }

  // React 19 dropped _debugSource, but it still attaches an Error to each fiber
  // (_debugStack) captured at the point the JSX was written. We parse that stack
  // to recover the file, line, and column.
  function parseAllStackFrames(debugStack) {
    if (!debugStack) return [];
    let stack = '';
    if (typeof debugStack === 'string') {
      stack = debugStack;
    } else if (debugStack.stack) {
      stack = debugStack.stack;
    } else {
      return [];
    }

    const frames = [];
    const lines = stack.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match =
        line.match(/at\s+(?:.+?\s+)?\((.+?):(\d+):(\d+)\)/) ||
        line.match(/at\s+(.+?):(\d+):(\d+)/);

      if (!match) continue;

      let filePath = match[1];
      const lineNum = parseInt(match[2], 10);
      const columnNum = parseInt(match[3], 10);

      filePath = filePath.replace(/\\/g, '/');
      filePath = filePath.replace(/^webpack-internal:\/\/\/\([^)]+\)\//, '');
      filePath = filePath.replace(/^\.\//, '');
      filePath = filePath.replace(/^file:\/\/\//, '');
      filePath = filePath.replace(/^https?:\/\/[^/]+\//, '');
      // strip query strings from turbopack/webpack urls
      filePath = filePath.replace(/\?.*$/, '');

      if (
        filePath.includes('react-stack-top-frame') ||
        filePath.includes('kexari-inspector.js') ||
        filePath.includes('react-dom')
      ) {
        continue;
      }

      frames.push({
        fileName: filePath,
        lineNumber: lineNum,
        columnNumber: columnNum
      });
    }
    return frames;
  }

  function pickBestFrame(frames) {
    if (!frames || frames.length === 0) return null;
    const source = frames.find((f) => looksLikeSourceFile(f.fileName));
    if (source) return source;
    const nonCompiled = frames.find((f) => !isThirdPartyOrCompiled(f.fileName));
    if (nonCompiled) return nonCompiled;
    return frames[0];
  }

  // Walks up the fiber tree from a DOM node looking for the nearest named
  // component and its source location. We keep compiled chunk frames separately
  // so the extension can resolve them via source maps.
  function getReactInfo(element, landmark) {
    const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return null;

    let fiber = element[key];

    const owners = [];
    const stackFrames = [];
    const seenKeys = new Set();

    let fallbackComponentName = null;
    let fallbackFileName = null;
    let fallbackLineNumber = null;
    let fallbackColumnNumber = null;

    while (fiber) {
      let fiberFile = null;
      let fiberLine = null;
      let fiberColumn = null;

      if (fiber._debugSource) {
        fiberFile = fiber._debugSource.fileName;
        fiberLine = fiber._debugSource.lineNumber;
        fiberColumn = fiber._debugSource.columnNumber || 0;
        if (fiberFile) {
          const frameKey = fiberFile + ':' + fiberLine + ':' + fiberColumn;
          if (!seenKeys.has(frameKey)) {
            seenKeys.add(frameKey);
            stackFrames.push({
              fileName: String(fiberFile).replace(/\\/g, '/'),
              lineNumber: fiberLine,
              columnNumber: fiberColumn
            });
          }
        }
      } else if (fiber._debugStack) {
        const frames = parseAllStackFrames(fiber._debugStack);
        for (const frame of frames) {
          const frameKey = frame.fileName + ':' + frame.lineNumber + ':' + frame.columnNumber;
          if (!seenKeys.has(frameKey)) {
            seenKeys.add(frameKey);
            stackFrames.push(frame);
          }
        }
        const best = pickBestFrame(frames);
        if (best) {
          fiberFile = best.fileName;
          fiberLine = best.lineNumber;
          fiberColumn = best.columnNumber;
        }
      }

      if (fiberFile) {
        fiberFile = String(fiberFile).replace(/\\/g, '/');
      }

      let name = null;
      if (fiber.type) {
        if (typeof fiber.type === 'function') {
          name = fiber.type.name || fiber.type.displayName;
        } else if (typeof fiber.type === 'object') {
          name = fiber.type.displayName || fiber.type.name || fiber.type.render?.name;
        }
      }

      if (name && name[0] === name[0].toUpperCase()) {
        const ignoredNames = [
          'Root', 'App', 'Layout', 'ServerRoot', 'Outer', 'Provider', 'Connect', 'Link', 'Image', 'html', 'body', 'Route', 'Router', 'Redirect', 'Switch',
          'NextFiber', 'StaticGenerationSearchParamsBypassProvider', 'AppRouterHeadersProvider',
          'MotionDOMComponent', 'AnimatePresence', 'LazyMotion', 'motion', 'Motion', 'PresenceChild',
          'Slot', 'Primitive', 'SlotChild', 'ForwardRef', 'Consumer', 'Context',
          'ClientPageRoot', 'ClientRoot', 'HotReload', 'Webpack', 'Next', 'Server', 'StaticGroup', 'OuterLayoutRouter'
        ];
        if (
          !ignoredNames.includes(name) &&
          !name.startsWith('Next') &&
          !name.startsWith('Webpack') &&
          !name.startsWith('HotReload')
        ) {
          const isBad = fiberFile && isThirdPartyOrCompiled(fiberFile);
          if (!isBad && fiberFile && looksLikeSourceFile(fiberFile)) {
            owners.push({
              componentName: name,
              fileName: fiberFile,
              lineNumber: fiberLine,
              columnNumber: fiberColumn || 0
            });
          } else if (!isBad && !owners.length) {
            // Keep the name even when React 19 gives no usable path — paths
            // come from data-kexari-source; Fiber is name enrichment only.
            owners.push({
              componentName: name,
              fileName: fiberFile || '',
              lineNumber: fiberLine || 0,
              columnNumber: fiberColumn || 0
            });
          } else if (isBad && !fallbackComponentName) {
            fallbackComponentName = name;
            fallbackFileName = fiberFile;
            fallbackLineNumber = fiberLine;
            fallbackColumnNumber = fiberColumn;
          }
        }
      }

      fiber = fiber.return;
    }

    const picked = pickBestOwner(owners, landmark);
    const bestOverall = pickBestFrame(stackFrames);

    return {
      componentName: picked?.componentName || fallbackComponentName || null,
      fileName: picked?.fileName || bestOverall?.fileName || fallbackFileName || null,
      lineNumber: picked?.lineNumber || bestOverall?.lineNumber || fallbackLineNumber || null,
      columnNumber: picked?.columnNumber || bestOverall?.columnNumber || fallbackColumnNumber || 0,
      stackFrames: stackFrames.slice(0, 12),
      owners: owners.slice(0, 8).map((o) => ({
        componentName: o.componentName,
        fileName: o.fileName,
        lineNumber: o.lineNumber
      }))
    };
  }

  function pickBestOwner(owners, landmark) {
    if (!owners || owners.length === 0) return null;

    const scored = owners.map((owner, index) => {
      // Closer owners (near the clicked node) rank higher by default.
      let score = Math.max(0, 40 - index * 4);
      const name = String(owner.componentName || '').toLowerCase();
      const file = String(owner.fileName || '').toLowerCase().replace(/\\/g, '/');

      if (landmark === 'header' || landmark === 'nav') {
        if (/header|navbar|nav\b|topbar|siteheader|sitenav/.test(name)) score += 60;
        if (/header|navbar|nav|topbar/.test(file)) score += 40;
        if (/hero|homepage|home-page|landing/.test(name)) score -= 50;
        if (/hero|homepage|home-page/.test(file)) score -= 35;
        if (/(^|\/)page\.(tsx|jsx|ts|js)$/.test(file) || /\/page\./.test(file)) score -= 25;
      } else if (landmark === 'footer') {
        if (/footer|sitefooter/.test(name) || /footer/.test(file)) score += 60;
      } else if (landmark === 'main') {
        if (/hero|homepage|home\b|landing|page\b/.test(name)) score += 15;
      }

      // Generic shared atoms are weak owners when a section component exists above.
      if (/^(button|btn|cta|link|anchor)$/i.test(name)) score -= 20;

      return { owner, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].owner;
  }

  function getDomLandmark(el) {
    let node = el;
    for (let i = 0; i < 12 && node; i++) {
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'header' || tag === 'nav' || tag === 'footer' || tag === 'main' || tag === 'aside') {
        return tag;
      }
      const role = (node.getAttribute && node.getAttribute('role')) || '';
      if (role === 'banner') return 'header';
      if (role === 'navigation') return 'nav';
      if (role === 'contentinfo') return 'footer';
      if (role === 'main') return 'main';

      const idClass = `${node.id || ''} ${typeof node.className === 'string' ? node.className : ''}`.toLowerCase();
      if (/\bheader\b|\bsite-header\b|\btopbar\b/.test(idClass)) return 'header';
      if (/\bnavbar\b|\bsite-nav\b/.test(idClass)) return 'nav';
      if (/\bfooter\b|\bsite-footer\b/.test(idClass)) return 'footer';
      if (/\bhero\b/.test(idClass)) return 'main';

      node = node.parentElement;
    }
    return '';
  }

  function getTextOccurrenceIndex(el, text) {
    if (!text) return 0;
    const tag = (el.tagName || '').toLowerCase();
    const matches = [];
    const nodes = document.body ? document.body.querySelectorAll(tag || '*') : [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (extractVisibleText(node) === text) {
        matches.push(node);
      }
    }
    const index = matches.indexOf(el);
    return index >= 0 ? index : 0;
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
          hideBadge();
          clearSelection();
          notifySelectionCleared();
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
      } else if (msg.type === 'KEXARI_LENS_APPLY_CSS') {
        if (selection.length > 0) {
          const el = selection[selection.length - 1].el;
          const newClass = msg.className || '';
          if (!el.dataset.kexariOriginalClass) {
            el.dataset.kexariOriginalClass = typeof el.className === 'string' ? el.className : '';
          }
          if (typeof el.className === 'string') {
            el.className = newClass;
          } else if (el.className && typeof el.className.baseVal === 'string') {
            el.className.baseVal = newClass;
          }
          selection[selection.length - 1].payload = buildTargetPayload(el);
        }
      } else if (msg.type === 'KEXARI_LENS_RESET_CSS') {
        if (selection.length > 0) {
          const el = selection[selection.length - 1].el;
          const orig = el.dataset.kexariOriginalClass;
          if (orig !== undefined) {
            if (typeof el.className === 'string') {
              el.className = orig;
            } else if (el.className && typeof el.className.baseVal === 'string') {
              el.className.baseVal = orig;
            }
            delete el.dataset.kexariOriginalClass;
            selection[selection.length - 1].payload = buildTargetPayload(el);
          }
        }
      } else if (msg.type === 'KEXARI_LENS_REFRESH_STYLES') {
        if (selection.length > 0) {
          const el = selection[selection.length - 1].el;
          const styles = extractKeyStyles(el);
          const cls = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
          window.parent.postMessage({
            type: 'KEXARI_LENS_STYLES_REFRESHED',
            styles,
            className: cls
          }, '*');
          if (selection[selection.length - 1].payload) {
            selection[selection.length - 1].payload.styles = styles;
            selection[selection.length - 1].payload.className = cls;
            selection[selection.length - 1].payload.stylesPrompt = formatStylesForPrompt(styles);
          }
        }
      }
    }
  });

  // Multi-select state. Ctrl+Click (Cmd+Click on Mac) toggles elements into this list.
  // Cyan outline = locked in. Esc or a normal click resets.
  const selection = [];

  function markSelected(el) {
    el.dataset.kexariSelected = '1';
    el.style.outline = '2px solid #22d3ee';
    el.style.outlineOffset = '-2px';
  }

  function unmarkSelected(el) {
    delete el.dataset.kexariSelected;
    el.style.outline = '';
    el.style.outlineOffset = '';
  }

  function clearSelection() {
    for (const item of selection) {
      unmarkSelected(item.el);
    }
    selection.length = 0;
  }

  // Matches Tailwind's default breakpoints so the AI knows which screen
  // the user is looking at, and which responsive prefixes to leave alone.
  function getViewportInfo() {
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;

    let label = 'Desktop';
    if (width < 640) {
      label = 'Mobile';
    } else if (width < 768) {
      label = 'Small';
    } else if (width < 1024) {
      label = 'Tablet';
    } else if (width < 1280) {
      label = 'Desktop';
    } else {
      label = 'Large Desktop';
    }

    return {
      width,
      height,
      label,
      summary: `${width}px (${label})`
    };
  }

  // Visible copy the user can edit — titles, paragraphs, labels, etc.
  // Prefer direct text nodes so parent wrappers don't swallow every child line.
  function extractVisibleText(el) {
    if (!el) return '';

    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') {
      return String(el.value || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    }
    if (tag === 'img') {
      return String(el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    }

    const directParts = [];
    if (el.childNodes && el.childNodes.length) {
      for (let i = 0; i < el.childNodes.length; i++) {
        const node = el.childNodes[i];
        if (node.nodeType === 3) {
          const part = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (part) directParts.push(part);
        }
      }
    }

    let text = directParts.length
      ? directParts.join(' ')
      : String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

    if (text.length > 240) {
      text = text.slice(0, 240).trim();
    }

    return text;
  }

  /** Grabs a focused set of computed styles useful for AI context. */
  function extractKeyStyles(el) {
    if (!el || !window.getComputedStyle) return null;
    try {
      const cs = window.getComputedStyle(el);
      return {
        color: cs.color || '',
        backgroundColor: cs.backgroundColor || '',
        fontSize: cs.fontSize || '',
        fontWeight: cs.fontWeight || '',
        fontFamily: cs.fontFamily ? cs.fontFamily.split(',')[0].replace(/['"]/g, '') : '',
        padding: cs.padding || '',
        margin: cs.margin || '',
        display: cs.display || '',
        position: cs.position || '',
        width: cs.width || '',
        height: cs.height || '',
        borderRadius: cs.borderRadius || '',
        border: cs.border || '',
        boxShadow: cs.boxShadow !== 'none' ? cs.boxShadow : '',
        opacity: cs.opacity !== '1' ? cs.opacity : '',
        gap: cs.gap !== 'normal' ? cs.gap : '',
        flexDirection: cs.flexDirection || '',
        alignItems: cs.alignItems || '',
        justifyContent: cs.justifyContent || '',
        textAlign: cs.textAlign || '',
        lineHeight: cs.lineHeight || ''
      };
    } catch {
      return null;
    }
  }

  /** Formats computed styles into a compact string for clipboard / AI prompts. */
  function formatStylesForPrompt(styles) {
    if (!styles) return '';
    const meaningful = [];
    const skip = ['width', 'height', 'display', 'position', 'fontFamily', 'fontWeight'];
    for (const [key, val] of Object.entries(styles)) {
      if (!val || val === 'none' || val === 'normal' || val === 'auto' || val === '0px' || val === 'rgba(0, 0, 0, 0)' || val === 'transparent' || val === 'rgb(0, 0, 0)') continue;
      // Convert camelCase to dash-case for readability
      const cssProp = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      meaningful.push(`  ${cssProp}: ${val}`);
    }
    if (!meaningful.length) return '';
    // Order important ones first
    return meaningful.join('\n');
  }

  function buildTargetPayload(el) {
    const landmark = getDomLandmark(el);
    const injected = findKexariSource(el);
    // Fiber is optional enrichment for component name only — paths come from
    // compile-time data-kexari-source (React 19 removed reliable _debugSource).
    const info = getReactInfo(el, landmark);
    const className = typeof el.className === 'string'
      ? el.className
      : (el.className?.baseVal || '');
    const text = extractVisibleText(el);
    const styles = extractKeyStyles(el);

    const componentName =
      injected?.componentName ||
      info?.componentName ||
      'Unknown';
    // Prefer compile-time attrs (required on React 19). Fall back to Fiber
    // _debugSource / _debugStack when present (React 17/18, or partial inject).
    const fiberFile =
      info?.fileName && !isThirdPartyOrCompiled(info.fileName) && looksLikeSourceFile(info.fileName)
        ? info.fileName
        : null;
    const fileName = injected?.fileName || fiberFile || 'Unknown';
    const lineNumber = injected?.lineNumber || (fiberFile ? info.lineNumber : 0) || 0;
    const columnNumber = injected?.columnNumber || (fiberFile ? info.columnNumber : 0) || 0;

    return {
      componentName,
      fileName,
      lineNumber,
      columnNumber,
      tagName: el.tagName.toLowerCase(),
      className,
      text,
      styles,
      stylesPrompt: formatStylesForPrompt(styles),
      landmark: landmark || '',
      textIndex: getTextOccurrenceIndex(el, text),
      owners: info?.owners || [],
      stackFrames: [],
      instrumented: !!injected
    };
  }

  // After load / hydration, tell the extension if the app lacks @kexari-lens/dev.
  function checkInstrumentation() {
    if (pageHasKexariInstrumentation()) {
      return;
    }
    notifyNeedsPlugin();
  }

  if (document.readyState === 'complete') {
    setTimeout(checkInstrumentation, 800);
  } else {
    window.addEventListener('load', () => setTimeout(checkInstrumentation, 800));
  }

  document.addEventListener('mouseover', (e) => {
    if (!inspectorEnabled) return;
    const el = e.target;
    if (!el || el === badge) return;

    // don't fight the persistent selection outline
    if (!el.dataset.kexariSelected) {
      el.dataset.kexariPrevOutline = el.style.outline;
      el.style.outline = '2px solid #6366f1';
      el.style.outlineOffset = '-2px';
    }

    showBadgeForElement(el);
  }, true);

  document.addEventListener('mouseout', (e) => {
    const el = e.target;
    if (!el || el === badge) return;

    if (el.dataset && el.dataset.kexariSelected) {
      // keep the cyan selection outline
      el.style.outline = '2px solid #22d3ee';
      el.style.outlineOffset = '-2px';
      delete el.dataset.kexariPrevOutline;
    } else if (el.dataset && 'kexariPrevOutline' in el.dataset) {
      el.style.outline = el.dataset.kexariPrevOutline || '';
      delete el.dataset.kexariPrevOutline;
    } else {
      el.style.outline = '';
    }

    hideBadge();
  }, true);

  document.addEventListener('click', (e) => {
    if (!inspectorEnabled) return;
    const el = e.target;
    if (!el || el === badge) return;

    e.preventDefault();
    e.stopPropagation();

    const payload = buildTargetPayload(el);

    // Shift+Click: add/remove from a multi-selection set
    if (e.ctrlKey || e.metaKey) {
      const existingIndex = selection.findIndex((item) => item.el === el);

      if (existingIndex >= 0) {
        unmarkSelected(selection[existingIndex].el);
        selection.splice(existingIndex, 1);
      } else {
        markSelected(el);
        selection.push({ el, payload });
      }

      if (selection.length === 0) {
        hideBadge();
        notifySelectionCleared();
        return;
      }

      showBadgeForElement(el);

      // Code button only targets the last selected element
      const jumpTarget = selection[selection.length - 1].payload;

      window.parent.postMessage({
        type: 'KEXARI_LENS_INSPECTOR_CLICK',
        payload: {
          mode: 'multi',
          viewport: getViewportInfo(),
          targets: selection.map((item) => item.payload),
          jumpTarget
        }
      }, '*');
      return;
    }

    // Normal click: replace selection with this one element
    clearSelection();
    markSelected(el);
    selection.push({ el, payload });
    showBadgeForElement(el);

    window.parent.postMessage({
      type: 'KEXARI_LENS_INSPECTOR_CLICK',
      payload: {
        mode: 'single',
        viewport: getViewportInfo(),
        targets: [payload],
        jumpTarget: payload
      }
    }, '*');
  }, true);

  document.addEventListener('keydown', (e) => {
    if (!inspectorEnabled) return;
    if (e.key === 'Escape') {
      clearSelection();
      hideBadge();
      notifySelectionCleared();
    }
  }, true);
})();
