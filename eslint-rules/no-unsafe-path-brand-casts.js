/** @fileoverview Keeps path brand casts inside the checked path helpers. */
// @ts-check

import { getChildNodes, normalizeFilename } from './utils.js';

const BRAND_ALLOWED_FILE_SUFFIXES = new Map([
  ['CwdPath', ['/src/paths/brands.ts']],
  ['Depth', ['/src/pipeline/depth.ts']],
  ['Extension', ['/src/discovery/pattern-validation.ts']],
  ['MaxFiles', ['/src/shared/max-files.ts']],
  ['OverviewTag', ['/src/pipeline/tag.ts']],
  ['RepoGlob', ['/src/paths/brands.ts']],
  ['RepoPath', ['/src/paths/brands.ts']],
  ['RepoScope', ['/src/paths/scope.ts']],
  ['ResolvedPath', ['/src/paths/brands.ts']],
]);
const RUNTIME_SOURCE_PATH_PART = '/src/';

/**
 * @typedef {{ create(context: import('eslint').Rule.RuleContext): Record<string, (node: import('@typescript-eslint/types').TSESTree.Node) => void>, meta: import('eslint').Rule.RuleMetaData }} LocalRuleModule
 */

/** @type {LocalRuleModule} */
const noUnsafePathBrandCastsRule = {
  create(context) {
    return {
      /**
       * Checks `value as RepoPath` style casts.
       *
       * @param {import('@typescript-eslint/types').TSESTree.Node} node - Type assertion to inspect.
       */
      TSAsExpression(node) {
        checkPathBrandCast(context, node);
      },

      /**
       * Checks `<RepoPath>value` style casts.
       *
       * @param {import('@typescript-eslint/types').TSESTree.Node} node - Type assertion to inspect.
       */
      TSTypeAssertion(node) {
        checkPathBrandCast(context, node);
      },
    };
  },
  meta: {
    docs: {
      description: 'Keep domain brand casts inside their validator modules.',
      recommended: true,
    },
    messages: {
      unsafePathBrandCast:
        'Use the brand helper instead of casting directly to a domain brand.',
    },
    schema: [],
    type: 'problem',
  },
};

export default noUnsafePathBrandCastsRule;

/**
 * Reports direct domain brand casts outside their validator modules.
 *
 * @param {import('eslint').Rule.RuleContext} context - ESLint rule context.
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Type assertion to inspect.
 */
function checkPathBrandCast(context, node) {
  if (node.type !== 'TSAsExpression' && node.type !== 'TSTypeAssertion') {
    return;
  }

  const normalizedFilename = normalizeRuleFilename(context.filename);

  if (normalizedFilename === undefined) {
    return;
  }

  const typeNames = getReferencedTypeNames(node.typeAnnotation);

  for (const typeName of typeNames) {
    const allowedFileSuffixes = BRAND_ALLOWED_FILE_SUFFIXES.get(typeName);

    if (allowedFileSuffixes === undefined) {
      continue;
    }

    if (isAllowedBrandCastFile(normalizedFilename, allowedFileSuffixes)) {
      continue;
    }

    context.report({
      messageId: 'unsafePathBrandCast',
      node,
    });
    return;
  }
}

/**
 * Normalizes source filenames that should be checked.
 *
 * @param {string | undefined} filename - Filename from ESLint.
 * @returns {string | undefined} Normalized filename, when the file is runtime source.
 */
function normalizeRuleFilename(filename) {
  if (filename === undefined || filename === '<input>') {
    return undefined;
  }

  const normalizedFilename = normalizeFilename(filename);

  if (!normalizedFilename.includes(RUNTIME_SOURCE_PATH_PART)) {
    return undefined;
  }

  return normalizedFilename;
}

/**
 * Checks if a file owns the checked helper for a brand.
 *
 * @param {string} filename - Normalized filename from ESLint.
 * @param {readonly string[]} allowedFileSuffixes - File suffixes that may cast this brand.
 * @returns {boolean} True when the file may cast this brand.
 */
function isAllowedBrandCastFile(filename, allowedFileSuffixes) {
  return allowedFileSuffixes.some((suffix) => filename.endsWith(suffix));
}

/**
 * Gets every named type reference from an assertion.
 *
 * @param {import('@typescript-eslint/types').TSESTree.TypeNode} node - Type node to inspect.
 * @returns {ReadonlySet<string>} Type names used inside the assertion.
 */
function getReferencedTypeNames(node) {
  /** @type {Set<string>} */
  const typeNames = new Set();

  collectReferencedTypeNames(node, typeNames);

  return typeNames;
}

/**
 * Adds named type references from a type annotation and its nested children.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - AST node to inspect.
 * @param {Set<string>} typeNames - Type names found so far.
 */
function collectReferencedTypeNames(node, typeNames) {
  if (node.type === 'TSTypeReference') {
    const typeName = getRightmostTypeName(node.typeName);

    if (typeName !== undefined) {
      typeNames.add(typeName);
    }
  }

  for (const childNode of getChildNodes(node)) {
    collectReferencedTypeNames(childNode, typeNames);
  }
}

/**
 * Gets the final name from a type reference chain.
 *
 * @param {import('@typescript-eslint/types').TSESTree.EntityName} typeName - Type reference name to inspect.
 * @returns {string | undefined} Final type name when the chain ends in an identifier.
 */
function getRightmostTypeName(typeName) {
  if (typeName.type === 'Identifier') {
    return typeName.name;
  }

  if (typeName.type === 'TSQualifiedName') {
    return getRightmostTypeName(typeName.right);
  }

  return undefined;
}
