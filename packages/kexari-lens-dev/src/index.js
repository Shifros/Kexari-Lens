'use strict';

const { KexariLensWebpackPlugin } = require('./webpack');
const { kexariLensVitePlugin } = require('./vite');
const { kexariLensTurbopackRules } = require('./turbopack');
const { transformJsx, ATTR_SOURCE, ATTR_COMPONENT } = require('./transform');
const { withKexariLens, withKexariVite } = require('./withKexari');

/**
 * @typedef {'webpack' | 'vite' | 'turbopack'} Bundler
 *
 * @typedef {object} KexariLensOptions
 * @property {Bundler} bundler
 * @property {string} [cwd]
 */

/**
 * Create the bundler integration for Kexari Lens compile-time injection.
 *
 * Prefer withKexariLens() / withKexariVite() in app configs — they wrap safely
 * without editing existing webpack()/plugins bodies.
 *
 * @param {KexariLensOptions} options
 * @returns {any}
 */
function kexariLens(options) {
  if (!options || !options.bundler) {
    throw new Error(
      '@kexari-lens/dev: pass { bundler: "webpack" | "vite" | "turbopack" }'
    );
  }

  const { bundler, cwd } = options;

  switch (bundler) {
    case 'webpack':
      return new KexariLensWebpackPlugin({ cwd });
    case 'vite':
      return kexariLensVitePlugin({ cwd });
    case 'turbopack':
      return kexariLensTurbopackRules();
    default:
      throw new Error(
        `@kexari-lens/dev: unsupported bundler "${bundler}". Use webpack, vite, or turbopack.`
      );
  }
}

module.exports = {
  kexariLens,
  withKexariLens,
  withKexariVite,
  KexariLensWebpackPlugin,
  kexariLensVitePlugin,
  kexariLensTurbopackRules,
  transformJsx,
  ATTR_SOURCE,
  ATTR_COMPONENT
};
module.exports.default = kexariLens;
