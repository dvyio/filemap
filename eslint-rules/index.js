/** @fileoverview Registers local ESLint rules under one plugin export. */
// @ts-check

/**
 * Usage in eslint.config.mjs:
 *   import localPlugin from './eslint-rules/index.js';
 *   export default [
 *     { plugins: { local: localPlugin } },
 *     { rules: { 'local/no-unsafe-path-brand-casts': 'error' } }
 *   ];
 */

import noUnsafePathBrandCasts from './no-unsafe-path-brand-casts.js';
import requireCaughtErrorCause from './require-caught-error-cause.js';

const localPlugin = {
  rules: {
    'no-unsafe-path-brand-casts': noUnsafePathBrandCasts,
    'require-caught-error-cause': requireCaughtErrorCause,
  },
};

export default localPlugin;
