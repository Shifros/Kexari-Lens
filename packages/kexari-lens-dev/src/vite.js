'use strict';

const path = require('path');
const { transformJsx } = require('./transform');

const JSX_RE = /\.(jsx|tsx)([?#].*)?$/;

/**
 * Vite plugin — transforms JSX/TSX in serve (dev) mode only.
 * @param {{ cwd?: string }} [options]
 */
function kexariLensVitePlugin(options = {}) {
  const cwd = options.cwd || process.cwd();
  let enabled = true;

  return {
    name: 'kexari-lens-dev',
    __kexariLens: true,
    enforce: 'pre',
    configResolved(config) {
      enabled =
        config.command === 'serve' &&
        process.env.KEXARI_LENS_DEV !== '0' &&
        process.env.NODE_ENV !== 'production';
    },
    transform(code, id) {
      if (!enabled) {
        return null;
      }
      if (!JSX_RE.test(id)) {
        return null;
      }
      if (id.includes('node_modules')) {
        return null;
      }

      const filePath = id.split('?')[0];
      try {
        const result = transformJsx({ content: code, filePath, cwd });
        if (result === code) {
          return null;
        }
        return { code: result, map: null };
      } catch {
        return null;
      }
    }
  };
}

module.exports = { kexariLensVitePlugin };
