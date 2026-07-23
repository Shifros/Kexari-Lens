'use strict';

/**
 * @deprecated Turbopack loader rules with `as: '*.tsx'` caused Next 16 to
 * resolve modules as `page.tsx.tsx`. Kexari Lens on Next 16 uses
 * `next dev --webpack` + the webpack plugin instead.
 *
 * Kept for API compatibility; returns an empty rules object.
 *
 * @returns {Record<string, never>}
 */
function kexariLensTurbopackRules() {
  return {};
}

module.exports = { kexariLensTurbopackRules, LOADER: '@kexari-lens/dev/loader' };
