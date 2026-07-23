'use strict';

const path = require('path');
const { transformJsx } = require('./transform');

/**
 * Webpack / Turbopack loader: injects data-kexari-* on JSX host elements.
 * Only runs when KEXARI_LENS_DEV is not explicitly '0' and NODE_ENV !== 'production'
 * (webpack plugin / turbopack rule should already gate this; this is a safety net).
 */
module.exports = function kexariLensLoader(source) {
  if (this && this.cacheable) {
    this.cacheable(true);
  }

  if (process.env.NODE_ENV === 'production' || process.env.KEXARI_LENS_DEV === '0') {
    return source;
  }

  const filePath =
    (this && this.resourcePath) ||
    (this && this.resource) ||
    '';

  if (!filePath) {
    return source;
  }

  const cwd = (this && this.rootContext) || process.cwd();

  try {
    return transformJsx({
      content: source,
      filePath,
      cwd
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (this && this.emitWarning) {
      this.emitWarning(new Error(`[kexari-lens/dev] transform skipped for ${path.basename(filePath)}: ${msg}`));
    }
    return source;
  }
};
