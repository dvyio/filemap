/** @fileoverview Extends preserve-caught-error for promise handlers and custom error helpers. */
// @ts-check

import {
  getChildNodes,
  getStaticMemberPropertyName,
  getStaticPropertyKeyName,
} from './utils.js';

const ERROR_CONSTRUCTOR_NAME = 'Error';
const AGGREGATE_ERROR_CONSTRUCTOR_NAME = 'AggregateError';
const CORE_CAUGHT_ERROR_CONSTRUCTOR_NAMES = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);
const NON_ERROR_THROWN_VALUE_HELPER_NAME = 'createNonErrorThrownValueError';

/**
 * @typedef {{ create(context: import('eslint').Rule.RuleContext): Record<string, (node: import('@typescript-eslint/types').TSESTree.Node) => void>, meta: import('eslint').Rule.RuleMetaData }} LocalRuleModule
 */

/**
 * @typedef {import('@typescript-eslint/types').TSESTree.CallExpression | import('@typescript-eslint/types').TSESTree.NewExpression} ReplacementErrorNode
 */

/** @type {LocalRuleModule} */
const requireCaughtErrorCauseRule = {
  create(context) {
    return {
      /**
       * Checks promise `.catch((error) => ...)` handlers.
       *
       * @param {import('@typescript-eslint/types').TSESTree.Node} node - Call expression to inspect.
       */
      CallExpression(node) {
        const callback = getPromiseCatchCallback(node);

        if (callback === undefined) {
          return;
        }

        checkHandlerBody(
          context,
          callback.body,
          getCaughtErrorName(callback),
          'promiseCatch',
        );
      },

      /**
       * Checks catch clauses for gaps that `preserve-caught-error` does not own.
       *
       * @param {import('@typescript-eslint/types').TSESTree.Node} node - Catch clause to inspect.
       */
      CatchClause(node) {
        if (node.type !== 'CatchClause' || node.param?.type !== 'Identifier') {
          return;
        }

        checkHandlerBody(context, node.body, node.param.name, 'catchClause');
      },
    };
  },
  meta: {
    docs: {
      description:
        'Require caught errors to be preserved in promise handlers and local error helpers.',
      recommended: true,
    },
    messages: {
      missingCaughtErrorCause:
        'Wrap caught errors with new Error(message, { cause: error }) or createNonErrorThrownValueError(error).',
    },
    schema: [],
    type: 'problem',
  },
};

export default requireCaughtErrorCauseRule;

/**
 * Checks a caught-error handler body for replacement errors that drop cause.
 *
 * @param {import('eslint').Rule.RuleContext} context - ESLint rule context.
 * @param {import('@typescript-eslint/types').TSESTree.BlockStatement | import('@typescript-eslint/types').TSESTree.Expression} body - Handler body to inspect.
 * @param {string | undefined} caughtErrorName - Caught error variable name.
 * @param {'catchClause' | 'promiseCatch'} handlerKind - Handler kind being checked.
 */
function checkHandlerBody(context, body, caughtErrorName, handlerKind) {
  if (caughtErrorName === undefined) {
    return;
  }

  inspectNode(context, body, caughtErrorName, handlerKind);
}

/**
 * Checks one node in a catch handler.
 *
 * @param {import('eslint').Rule.RuleContext} context - ESLint rule context.
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Node to inspect.
 * @param {string} caughtErrorName - Caught error variable name.
 * @param {'catchClause' | 'promiseCatch'} handlerKind - Handler kind being checked.
 */
function inspectNode(context, node, caughtErrorName, handlerKind) {
  if (isNestedHandlerBoundary(node)) {
    return;
  }

  if (node.type === 'ThrowStatement') {
    reportMissingThrownCause(
      context,
      node,
      node.argument,
      caughtErrorName,
      handlerKind,
    );
  }

  if (node.type === 'CallExpression' && isPromiseRejectCall(node)) {
    reportMissingCause(context, node, node.arguments[0], caughtErrorName);
  }

  for (const child of getChildNodes(node)) {
    inspectNode(context, child, caughtErrorName, handlerKind);
  }
}

/**
 * Reports thrown values only when the core rule does not own that case.
 *
 * @param {import('eslint').Rule.RuleContext} context - ESLint rule context.
 * @param {import('@typescript-eslint/types').TSESTree.Node} reportNode - Node to report.
 * @param {import('@typescript-eslint/types').TSESTree.Node | undefined | null} replacementValue - Thrown value.
 * @param {string} caughtErrorName - Caught error variable name.
 * @param {'catchClause' | 'promiseCatch'} handlerKind - Handler kind being checked.
 */
function reportMissingThrownCause(
  context,
  reportNode,
  replacementValue,
  caughtErrorName,
  handlerKind,
) {
  if (
    handlerKind === 'catchClause' &&
    !createsCaughtClauseExtensionError(replacementValue)
  ) {
    return;
  }

  reportMissingCause(context, reportNode, replacementValue, caughtErrorName);
}

/**
 * Reports replacement errors that do not keep the caught value.
 *
 * @param {import('eslint').Rule.RuleContext} context - ESLint rule context.
 * @param {import('@typescript-eslint/types').TSESTree.Node} reportNode - Node to report.
 * @param {import('@typescript-eslint/types').TSESTree.Node | undefined | null} replacementValue - Thrown or rejected value.
 * @param {string} caughtErrorName - Caught error variable name.
 */
function reportMissingCause(
  context,
  reportNode,
  replacementValue,
  caughtErrorName,
) {
  if (!createsError(replacementValue)) {
    return;
  }

  if (keepsCaughtErrorAsCause(replacementValue, caughtErrorName)) {
    return;
  }

  context.report({
    messageId: 'missingCaughtErrorCause',
    node: reportNode,
  });
}

/**
 * Checks if a node creates an error-like value this rule owns.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node | undefined | null} node - Node to inspect.
 * @returns {node is ReplacementErrorNode} True when the node creates an error.
 */
function createsError(node) {
  if (node === undefined || node === null) {
    return false;
  }

  if (isNonErrorThrownValueErrorCall(node)) {
    return true;
  }

  return isErrorConstructorCall(node);
}

/**
 * Checks if a catch-clause throw is outside the core rule coverage.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node | undefined | null} node - Node to inspect.
 * @returns {boolean} True when the local rule should inspect the thrown value.
 */
function createsCaughtClauseExtensionError(node) {
  if (node === undefined || node === null) {
    return false;
  }

  return (
    isNonErrorThrownValueErrorCall(node) || isCustomErrorConstructorCall(node)
  );
}

/**
 * Checks if a replacement error keeps the caught value as cause.
 *
 * @param {ReplacementErrorNode} node - Node to inspect.
 * @param {string} caughtErrorName - Caught error variable name.
 * @returns {boolean} True when the caught error is preserved.
 */
function keepsCaughtErrorAsCause(node, caughtErrorName) {
  if (isNonErrorThrownValueErrorCall(node)) {
    return isCaughtErrorIdentifier(node.arguments[0], caughtErrorName);
  }

  return hasCauseOption(getErrorOptionsArgument(node), caughtErrorName);
}

/**
 * Gets the constructor options argument that should carry `cause`.
 *
 * @param {ReplacementErrorNode} node - Error constructor call to inspect.
 * @returns {import('@typescript-eslint/types').TSESTree.Node | undefined} Options argument, when present.
 */
function getErrorOptionsArgument(node) {
  const constructorName = getConstructorName(node.callee);

  if (constructorName === AGGREGATE_ERROR_CONSTRUCTOR_NAME) {
    return node.arguments[2];
  }

  return node.arguments[1];
}

/**
 * Checks if an options object has `cause: error`.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node | undefined} node - Options value to inspect.
 * @param {string} caughtErrorName - Caught error variable name.
 * @returns {boolean} True when the options keep the caught error.
 */
function hasCauseOption(node, caughtErrorName) {
  if (node?.type !== 'ObjectExpression') {
    return false;
  }

  return node.properties.some((property) => {
    if (property.type !== 'Property') {
      return false;
    }

    return (
      getStaticPropertyKeyName(property) === 'cause' &&
      isCaughtErrorCauseValue(property.value, caughtErrorName)
    );
  });
}

/**
 * Checks if a cause expression keeps the caught error.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Cause value to inspect.
 * @param {string} caughtErrorName - Caught error variable name.
 * @returns {boolean} True when the value keeps the caught error.
 */
function isCaughtErrorCauseValue(node, caughtErrorName) {
  if (isCaughtErrorIdentifier(node, caughtErrorName)) {
    return true;
  }

  return (
    node.type === 'ConditionalExpression' &&
    isCaughtErrorCauseValue(node.consequent, caughtErrorName) &&
    isCaughtErrorCauseValue(node.alternate, caughtErrorName)
  );
}

/**
 * Gets the first parameter name from a promise catch callback.
 *
 * @param {import('@typescript-eslint/types').TSESTree.ArrowFunctionExpression | import('@typescript-eslint/types').TSESTree.FunctionExpression} callback - Promise catch callback.
 * @returns {string | undefined} Caught error name when the callback has one.
 */
function getCaughtErrorName(callback) {
  const firstParameter = callback.params[0];

  return firstParameter?.type === 'Identifier'
    ? firstParameter.name
    : undefined;
}

/**
 * Gets the callback from a promise `.catch(...)` call.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Call expression to inspect.
 * @returns {import('@typescript-eslint/types').TSESTree.ArrowFunctionExpression | import('@typescript-eslint/types').TSESTree.FunctionExpression | undefined} Callback when this is a promise catch call.
 */
function getPromiseCatchCallback(node) {
  if (node.type !== 'CallExpression') {
    return undefined;
  }

  if (getCalledPropertyName(node) !== 'catch') {
    return undefined;
  }

  const firstArgument = node.arguments[0];

  if (
    firstArgument?.type !== 'ArrowFunctionExpression' &&
    firstArgument?.type !== 'FunctionExpression'
  ) {
    return undefined;
  }

  return firstArgument;
}

/**
 * Gets the called member name from a call.
 *
 * @param {import('@typescript-eslint/types').TSESTree.CallExpression} node - Call expression to inspect.
 * @returns {string | undefined} Called member name.
 */
function getCalledPropertyName(node) {
  if (node.callee.type !== 'MemberExpression') {
    return undefined;
  }

  return getStaticMemberPropertyName(node.callee);
}

/**
 * Checks whether a call is `Promise.reject(...)`.
 *
 * @param {import('@typescript-eslint/types').TSESTree.CallExpression} node - Call expression to inspect.
 * @returns {boolean} True when the call rejects a promise.
 */
function isPromiseRejectCall(node) {
  if (node.callee.type !== 'MemberExpression') {
    return false;
  }

  if (node.callee.object.type !== 'Identifier') {
    return false;
  }

  return (
    node.callee.object.name === 'Promise' &&
    getStaticMemberPropertyName(node.callee) === 'reject'
  );
}

/**
 * Checks if a node calls `createNonErrorThrownValueError`.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Node to inspect.
 * @returns {node is import('@typescript-eslint/types').TSESTree.CallExpression} True when the node calls the helper.
 */
function isNonErrorThrownValueErrorCall(node) {
  if (node.type !== 'CallExpression') {
    return false;
  }

  return (
    node.callee.type === 'Identifier' &&
    node.callee.name === NON_ERROR_THROWN_VALUE_HELPER_NAME
  );
}

/**
 * Checks if a node creates an error with a constructor this rule owns.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Node to inspect.
 * @returns {node is ReplacementErrorNode} True when the node calls an error constructor.
 */
function isErrorConstructorCall(node) {
  if (node.type === 'NewExpression') {
    return (
      getConstructorName(node.callee)?.endsWith(ERROR_CONSTRUCTOR_NAME) === true
    );
  }

  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === ERROR_CONSTRUCTOR_NAME
  );
}

/**
 * Checks for custom error constructors that the core rule misses.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Node to inspect.
 * @returns {node is import('@typescript-eslint/types').TSESTree.NewExpression} True when this is a local error constructor.
 */
function isCustomErrorConstructorCall(node) {
  if (node.type !== 'NewExpression') {
    return false;
  }

  const constructorName = getConstructorName(node.callee);

  if (constructorName?.endsWith(ERROR_CONSTRUCTOR_NAME) !== true) {
    return false;
  }

  if (node.callee.type === 'MemberExpression') {
    return true;
  }

  return !CORE_CAUGHT_ERROR_CONSTRUCTOR_NAMES.has(constructorName);
}

/**
 * Gets the final name from a constructor or namespace constructor.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Constructor callee to inspect.
 * @returns {string | undefined} Constructor name when it can be read safely.
 */
function getConstructorName(node) {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'MemberExpression') {
    return getStaticMemberPropertyName(node);
  }

  return undefined;
}

/**
 * Checks if a node is the caught error variable.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node | undefined} node - Node to inspect.
 * @param {string} caughtErrorName - Caught error variable name.
 * @returns {boolean} True when the node is the caught error.
 */
function isCaughtErrorIdentifier(node, caughtErrorName) {
  return node?.type === 'Identifier' && node.name === caughtErrorName;
}

/**
 * Checks if a node starts a handler that owns its own caught error.
 *
 * @param {import('@typescript-eslint/types').TSESTree.Node} node - Node to inspect.
 * @returns {boolean} True when the node's children should be skipped.
 */
function isNestedHandlerBoundary(node) {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'CatchClause' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression'
  );
}
