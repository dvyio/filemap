/** @fileoverview Shares small boundary validators across CLI and internal entry points */

const FIRST_CONTROL_CHARACTER = String.fromCharCode(0x00);
const LAST_CONTROL_CHARACTER = String.fromCharCode(0x1f);
const DELETE_CONTROL_CHARACTER = String.fromCharCode(0x7f);
const CONTROL_CHARACTER_PATTERN = new RegExp(
  `[${FIRST_CONTROL_CHARACTER}-${LAST_CONTROL_CHARACTER}${DELETE_CONTROL_CHARACTER}]`,
  'u',
);
const UNICODE_FORMAT_CONTROL_PATTERN = /\p{Cf}/u;
const DECIMAL_INTEGER_TEXT_PATTERN = /^\d+$/u;

/**
 * Formats a validation error so unsafe values are escaped before they reach output.
 *
 * @param fieldName - Field name used in the error message.
 * @param value - Invalid value shown in the error message.
 * @param expectedDescription - Plain-language rule shown after "expected".
 * @returns A safe validation error message.
 */
export function formatInvalidValueMessage(
  fieldName: string,
  value: unknown,
  expectedDescription: string,
): string {
  return `Invalid ${fieldName} "${formatDisplayValue(String(value))}" — expected ${expectedDescription}.`;
}

/**
 * Fails when an exhaustive switch receives a variant it does not know.
 *
 * @param value - The impossible value that reached the default branch.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language list of allowed variants.
 */
export function assertNever(
  value: never,
  fieldName: string,
  expectedDescription: string,
): never {
  throw new Error(
    formatInvalidValueMessage(fieldName, value, expectedDescription),
  );
}

/**
 * Checks that a boundary value is an array.
 *
 * @param value - Value from the CLI or shared code.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language rule shown when validation fails.
 * @returns The value as an array.
 */
export function validateArray(
  value: unknown,
  fieldName: string,
  expectedDescription: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, expectedDescription),
    );
  }

  return value;
}

/**
 * Checks that an optional boundary value is an array when present.
 *
 * @param value - Value from the CLI or shared code.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language rule shown when validation fails.
 * @returns The value as an array, or `undefined` when omitted.
 */
export function validateOptionalArray(
  value: unknown,
  fieldName: string,
  expectedDescription: string,
): readonly unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return validateArray(value, fieldName, expectedDescription);
}

/**
 * Checks that a boundary value is an array of non-empty strings.
 *
 * @param value - Value from the CLI or shared code.
 * @param arrayFieldName - Field name used when the value is not an array.
 * @param arrayExpectedDescription - Plain-language array rule shown when validation fails.
 * @param getItemFieldName - Field name used when an item is not a non-empty string.
 * @param itemExpectedDescription - Plain-language item rule shown when validation fails.
 * @returns The original strings after their type and contents are checked.
 */
export function validateNonEmptyStringArray(
  value: unknown,
  arrayFieldName: string,
  arrayExpectedDescription: string,
  getItemFieldName: ((index: number) => string) | string,
  itemExpectedDescription: string,
): readonly string[] {
  return validateArray(value, arrayFieldName, arrayExpectedDescription).map(
    (item, index) => {
      const itemFieldName =
        typeof getItemFieldName === 'string'
          ? getItemFieldName
          : getItemFieldName(index);

      return validateNonEmptyString(
        item,
        itemFieldName,
        itemExpectedDescription,
      );
    },
  );
}

/**
 * Checks that an optional boundary value is a boolean when present.
 *
 * @param value - Value from the CLI or shared code.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language rule shown when validation fails.
 * @returns The value as a boolean, or `undefined` when omitted.
 */
export function validateOptionalBoolean(
  value: unknown,
  fieldName: string,
  expectedDescription: string,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, expectedDescription),
    );
  }

  return value;
}

/**
 * Checks that a boundary value is an options object.
 *
 * @param value - Value from JavaScript or shared code.
 * @param fieldName - Field name used in the error message.
 * @returns The value as an object with unchecked fields.
 */
export function validateOptionsObject(
  value: unknown,
  fieldName: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, 'an options object'),
    );
  }

  return value as Readonly<Record<string, unknown>>;
}

/**
 * Checks that a boundary value is a non-empty string.
 *
 * @param value - Value from the CLI or shared code.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language rule shown when validation fails.
 * @returns The original string after its type and contents are checked.
 */
export function validateNonEmptyString(
  value: unknown,
  fieldName: string,
  expectedDescription: string,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, expectedDescription),
    );
  }

  return value;
}

/**
 * Parses only base-10 integer text from CLI and environment inputs.
 *
 * @param value - Text value from a process boundary.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language rule shown when validation fails.
 * @returns The parsed integer.
 */
export function parseDecimalIntegerText(
  value: string,
  fieldName: string,
  expectedDescription: string,
): number {
  if (!DECIMAL_INTEGER_TEXT_PATTERN.test(value)) {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, expectedDescription),
    );
  }

  return Number(value);
}

/**
 * Checks that a boundary value is an integer within an allowed range.
 *
 * @param value - Value from the CLI or shared code.
 * @param fieldName - Field name used in the error message.
 * @param expectedDescription - Plain-language rule shown when validation fails.
 * @param minimum - Smallest allowed integer.
 * @param maximum - Largest allowed integer, when there is a cap.
 * @returns The checked integer.
 */
export function validateIntegerInRange(
  value: unknown,
  fieldName: string,
  expectedDescription: string,
  minimum: number,
  maximum?: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(
      formatInvalidValueMessage(fieldName, value, expectedDescription),
    );
  }

  return value;
}

/**
 * Checks whether a string contains ASCII control characters.
 *
 * @param value - String to inspect.
 * @returns `true` when the string contains a control character.
 */
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * Checks whether a string contains Unicode format controls.
 *
 * @param value - String to inspect.
 * @returns `true` when the string contains a Unicode format control.
 */
export function hasUnicodeFormatControl(value: string): boolean {
  return UNICODE_FORMAT_CONTROL_PATTERN.test(value);
}

/**
 * Escapes hidden display controls so terminal output cannot spoof text.
 *
 * @param value - User or tool text shown in an error or CLI output.
 * @returns The text with hidden display controls shown as Unicode escapes.
 */
export function formatDisplayValue(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = getCodePoint(character);

      if (
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        UNICODE_FORMAT_CONTROL_PATTERN.test(character)
      ) {
        return formatCodePoint(codePoint);
      }

      return character;
    })
    .join('');
}

function getCodePoint(character: string): number {
  const firstCodeUnit = character.charCodeAt(0);

  if (
    firstCodeUnit >= 0xd800 &&
    firstCodeUnit <= 0xdbff &&
    character.length > 1
  ) {
    const secondCodeUnit = character.charCodeAt(1);

    if (secondCodeUnit >= 0xdc00 && secondCodeUnit <= 0xdfff) {
      return (
        (firstCodeUnit - 0xd800) * 0x400 + (secondCodeUnit - 0xdc00) + 0x10000
      );
    }
  }

  return firstCodeUnit;
}

function formatCodePoint(codePoint: number): string {
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }

  return `\\u{${codePoint.toString(16)}}`;
}
