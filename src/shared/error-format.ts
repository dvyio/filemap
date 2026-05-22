/** @fileoverview Formats errors so CLI failures show useful recovery details */

import { formatDisplayValue } from '@/shared/validation.js';

const INDENT = '  ';

export { formatInvalidValueMessage } from '@/shared/validation.js';

/**
 * Keeps Error values as-is and wraps non-Error values with boundary context.
 *
 * @param error - Value caught by a boundary.
 * @param context - Optional action that failed, such as `File read failed`.
 * @returns The caught Error, or a clear Error that keeps the original value as cause.
 */
export function createNonErrorThrownValueError(
  error: unknown,
  context?: string,
): Error {
  if (error instanceof Error) {
    return error;
  }

  const displayedValue = formatDisplayValue(String(error));
  const message =
    context === undefined
      ? `Caught non-Error value "${displayedValue}".`
      : `${context} with a non-error value "${displayedValue}".`;

  return new Error(message, { cause: error });
}

/**
 * Formats an error and its causes for CLI output.
 *
 * @param error - Error thrown by the CLI flow.
 * @returns A plain error message with nested causes.
 */
export function formatErrorChain(error: Error): string {
  const messages: string[] = [formatDisplayValue(error.message)];
  const causeChain = getPrintableCauseChain(error);
  const renderedCauseChains = new Set(
    causeChain.map((causeError) => getErrorChainKey(causeError)),
  );

  for (const causeError of causeChain) {
    messages.push(
      `${INDENT}caused by: ${formatDisplayValue(causeError.message)}`,
    );
  }

  appendAggregateErrors(error, messages, INDENT, renderedCauseChains);

  return messages.join('\n');
}

/**
 * Adds aggregate errors that are not already shown through the cause chain.
 */
function appendAggregateErrors(
  error: Error,
  messages: string[],
  indent: string,
  duplicateErrorChains: ReadonlySet<string>,
): void {
  if (!(error instanceof AggregateError)) {
    return;
  }

  for (const aggregateError of error.errors) {
    if (aggregateError instanceof Error) {
      const errorChainKey = getErrorChainKey(aggregateError);

      if (duplicateErrorChains.has(errorChainKey)) {
        continue;
      }

      messages.push(
        `${indent}aggregate error: ${formatDisplayValue(aggregateError.message)}`,
      );
      appendCauseChain(aggregateError, messages, `${indent}${INDENT}`);
      appendAggregateErrors(
        aggregateError,
        messages,
        `${indent}${INDENT}`,
        duplicateErrorChains,
      );
      continue;
    }

    messages.push(
      `${indent}aggregate error: ${formatDisplayValue(String(aggregateError))}`,
    );
  }
}

function appendCauseChain(
  error: Error,
  messages: string[],
  indent: string,
): void {
  for (const causeError of getPrintableCauseChain(error)) {
    messages.push(
      `${indent}caused by: ${formatDisplayValue(causeError.message)}`,
    );
  }
}

function getPrintableCauseChain(error: Error): readonly Error[] {
  return getCauseChain(error).filter((causeError, index) => {
    return index !== 0 || causeError.message !== error.message;
  });
}

function getCauseChain(error: Error): readonly Error[] {
  const causeChain: Error[] = [];
  let current: unknown = error.cause;

  while (current instanceof Error) {
    causeChain.push(current);
    current = current.cause;
  }

  return causeChain;
}

function getErrorChainKey(error: Error): string {
  return [
    error.message,
    ...getCauseChain(error).map((cause) => cause.message),
  ].join('\n');
}
