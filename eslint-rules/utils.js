/** @fileoverview Shares AST helpers used by local ESLint rules. */
// @ts-check

import { AST_NODE_TYPES } from '@typescript-eslint/types';

const AST_METADATA_KEYS = new Set([
  'comments',
  'innerComments',
  'leadingComments',
  'loc',
  'parent',
  'range',
  'tokens',
  'trailingComments',
]);
/** @type {ReadonlySet<string>} */
const AST_NODE_TYPE_NAMES = new Set(Object.values(AST_NODE_TYPES));

/**
 * Returns direct AST child nodes while skipping parser metadata.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Node to inspect.
 * @returns {Array<import('@typescript-eslint/types').TSESTree.Node>} Child nodes.
 */
export function getChildNodes(node) {
  /** @type {Array<import('@typescript-eslint/types').TSESTree.Node>} */
  const childNodes = [];

  for (const [key, value] of Object.entries(node)) {
    if (AST_METADATA_KEYS.has(key)) {
      continue;
    }

    if (isAstNode(value)) {
      childNodes.push(value);
      continue;
    }

    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      if (isAstNode(item)) {
        childNodes.push(item);
      }
    }
  }

  return childNodes;
}

/**
 * Checks if a value is a real TypeScript ESTree node.
 *
 * @param {unknown} value - Value to inspect.
 * @returns {value is import('@typescript-eslint/types').TSESTree.Node} True when the value is a parsed AST node.
 */
export function isAstNode(value) {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value['type'] !== 'string') {
    return false;
  }

  if (!AST_NODE_TYPE_NAMES.has(value['type'])) {
    return false;
  }

  return Array.isArray(value['range']) && isSourceLocation(value['loc']);
}

/**
 * Normalizes a filename to POSIX-style slashes.
 *
 * @param {string} filename - Filename to normalize.
 * @returns {string} Filename with forward slashes.
 */
export function normalizeFilename(filename) {
  return filename.replaceAll('\\', '/');
}

/**
 * Gets a static member property name.
 *
 * @param {import('@typescript-eslint/types').TSESTree.MemberExpression} node - Member expression to inspect.
 * @returns {string | undefined} Static property name, when present.
 */
export function getStaticMemberPropertyName(node) {
  if (!node.computed) {
    return node.property.type === 'Identifier' ? node.property.name : undefined;
  }

  return node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
    ? node.property.value
    : undefined;
}

/**
 * Gets a static object-property key name.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Property} node - Property to inspect.
 * @returns {string | undefined} Static property key name, when present.
 */
export function getStaticPropertyKeyName(node) {
  if (!node.computed) {
    return node.key.type === 'Identifier' ? node.key.name : undefined;
  }

  return node.key.type === 'Literal' && typeof node.key.value === 'string'
    ? node.key.value
    : undefined;
}

/**
 * Checks whether a value is a plain object.
 *
 * @param {unknown} value - Value to check.
 * @returns {value is Record<string, unknown>} True when the value is an object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Checks whether a value has the shape of a parser source location.
 *
 * @param {unknown} value - Value to check.
 * @returns {boolean} True when the value has start and end positions.
 */
function isSourceLocation(value) {
  return isRecord(value) && isRecord(value['start']) && isRecord(value['end']);
}
