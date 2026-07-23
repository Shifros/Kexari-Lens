'use strict';

const { KexariLensWebpackPlugin } = require('./webpack');
const { kexariLensVitePlugin } = require('./vite');

function createWebpackPlugin(cwd) {
  return new KexariLensWebpackPlugin({ cwd });
}

function createVitePlugin(cwd) {
  return kexariLensVitePlugin({ cwd });
}

/**
 * Wrap a Next.js config so Kexari Lens injects safely without editing the
 * project's webpack() body (avoids `dev is not defined`, odd signatures, etc.).
 *
 * @param {object|Function} userConfig
 * @returns {object|Function}
 */
function withKexariLens(userConfig) {
  if (typeof userConfig === 'function') {
    return async function kexariWrappedNextConfig(...args) {
      const resolved = await userConfig(...args);
      return wrapNextConfigObject(resolved || {});
    };
  }
  return wrapNextConfigObject(userConfig || {});
}

function wrapNextConfigObject(userConfig) {
  const prevWebpack = userConfig.webpack;
  return {
    ...userConfig,
    // Next 16+: keep turbopack key so `next build` doesn't fail when webpack() exists
    turbopack:
      userConfig.turbopack !== undefined && userConfig.turbopack !== null
        ? userConfig.turbopack
        : {},
    webpack: (config, options) => {
      if (options && options.dev) {
        if (!config.plugins) {
          config.plugins = [];
        }
        config.plugins.push(createWebpackPlugin());
      }
      if (typeof prevWebpack === 'function') {
        return prevWebpack(config, options);
      }
      return config;
    }
  };
}

/**
 * Wrap a Vite config — prepends the Kexari plugin without rewriting plugins: [...].
 *
 * @param {object|Function} userConfig
 * @returns {object|Function}
 */
function withKexariVite(userConfig) {
  if (typeof userConfig === 'function') {
    return function kexariWrappedViteConfig(env) {
      const resolved = userConfig(env);
      if (resolved && typeof resolved.then === 'function') {
        return resolved.then((cfg) => wrapViteConfigObject(cfg || {}));
      }
      return wrapViteConfigObject(resolved || {});
    };
  }
  return wrapViteConfigObject(userConfig || {});
}

function wrapViteConfigObject(userConfig) {
  const prev = Array.isArray(userConfig.plugins) ? userConfig.plugins : [];
  const already = prev.some(
    (p) => p && (p.name === 'kexari-lens-dev' || p.__kexariLens)
  );
  const plugin = Object.assign(createVitePlugin(), { __kexariLens: true });
  return {
    ...userConfig,
    plugins: already ? prev : [plugin, ...prev]
  };
}

module.exports = {
  withKexariLens,
  withKexariVite,
  wrapNextConfigObject,
  wrapViteConfigObject
};
