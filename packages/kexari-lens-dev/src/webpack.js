'use strict';

const path = require('path');

const LOADER = path.join(__dirname, 'loader.js');

const FILE_PATTERN = /\.(jsx|tsx)$/;

/**
 * Webpack plugin that prepends the Kexari Lens JSX loader in development.
 */
class KexariLensWebpackPlugin {
  /**
   * @param {{ cwd?: string }} [options]
   */
  constructor(options = {}) {
    this.options = options;
  }

  apply(compiler) {
    const mode = compiler.options.mode || process.env.NODE_ENV;
    if (mode === 'production' || process.env.KEXARI_LENS_DEV === '0') {
      return;
    }

    compiler.hooks.afterEnvironment.tap('KexariLensWebpackPlugin', () => {
      const rule = {
        test: FILE_PATTERN,
        enforce: 'pre',
        exclude: /node_modules/,
        use: [
          {
            loader: LOADER,
            options: {}
          }
        ]
      };

      if (!compiler.options.module) {
        compiler.options.module = { rules: [] };
      }
      if (!compiler.options.module.rules) {
        compiler.options.module.rules = [];
      }
      compiler.options.module.rules.unshift(rule);
    });
  }
}

module.exports = { KexariLensWebpackPlugin, LOADER, FILE_PATTERN };
