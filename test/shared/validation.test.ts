import { describe, expect, test } from 'vitest';

import {
  formatDisplayValue,
  formatInvalidValueMessage,
  hasControlCharacter,
  hasUnicodeFormatControl,
  parseDecimalIntegerText,
  validateArray,
  validateIntegerInRange,
  validateNonEmptyString,
  validateNonEmptyStringArray,
  validateOptionalArray,
  validateOptionalBoolean,
} from '@/shared/validation.js';

describe('validation helpers', () => {
  test('given a hidden control value, when formatting an invalid value, then it escapes the value', () => {
    expect(
      formatInvalidValueMessage(
        'cwd',
        '/tmp/bad\u0001path',
        'an existing directory',
      ),
    ).toBe(
      'Invalid cwd "/tmp/bad\\u0001path" — expected an existing directory.',
    );
  });

  test('given valid arrays, when checking array values, then returns the array', () => {
    const values = ['src/app.ts'];

    expect(validateArray(values, 'include', 'an array')).toBe(values);
    expect(validateOptionalArray(undefined, 'include', 'an array')).toBe(
      undefined,
    );
    expect(validateOptionalArray(values, 'include', 'an array')).toBe(values);
  });

  test('given invalid arrays, when checking array values, then rejects them', () => {
    expect(() => validateArray('src/app.ts', 'include', 'an array')).toThrow(
      'Invalid include "src/app.ts" — expected an array.',
    );
    expect(() =>
      validateOptionalArray('src/app.ts', 'include', 'an array'),
    ).toThrow('Invalid include "src/app.ts" — expected an array.');
  });

  test('given valid string arrays, when checking list values, then returns the strings', () => {
    const values = ['src/app.ts', ' src/util.ts '];

    expect(
      validateNonEmptyStringArray(
        values,
        'filePaths',
        'an array of paths',
        (index) => `filePaths[${String(index)}]`,
        'a non-empty path',
      ),
    ).toEqual(values);
  });

  test.each([
    [
      'not an array',
      'src/app.ts',
      'Invalid filePaths "src/app.ts" — expected an array of paths.',
    ],
    [
      'not a string',
      ['src/app.ts', 3],
      'Invalid filePaths[1] "3" — expected a non-empty path.',
    ],
    [
      'empty text',
      ['src/app.ts', '   '],
      'Invalid filePaths[1] "   " — expected a non-empty path.',
    ],
  ])(
    'given %s, when checking list values, then rejects it',
    (_name, value, message) => {
      expect(() =>
        validateNonEmptyStringArray(
          value,
          'filePaths',
          'an array of paths',
          (index) => `filePaths[${String(index)}]`,
          'a non-empty path',
        ),
      ).toThrow(message);
    },
  );

  test('given boolean options, when checking optional booleans, then returns valid values', () => {
    expect(validateOptionalBoolean(undefined, 'debug', 'a boolean')).toBe(
      undefined,
    );
    expect(validateOptionalBoolean(true, 'debug', 'a boolean')).toBe(true);
    expect(validateOptionalBoolean(false, 'debug', 'a boolean')).toBe(false);
  });

  test('given a non-boolean option, when checking optional booleans, then rejects it', () => {
    expect(() => validateOptionalBoolean('true', 'debug', 'a boolean')).toThrow(
      'Invalid debug "true" — expected a boolean.',
    );
  });

  test('given valid strings and integers, when checking values, then returns them', () => {
    expect(validateNonEmptyString(' src ', 'path', 'a path')).toBe(' src ');
    expect(parseDecimalIntegerText('42', 'depth', 'decimal text')).toBe(42);
    expect(validateIntegerInRange(0, 'depth', 'a checked depth', 0)).toBe(0);
    expect(validateIntegerInRange(5, 'limit', '1 to 5', 1, 5)).toBe(5);
  });

  test.each([undefined, '', '   ', 3])(
    'given invalid string %s, when checking it, then rejects it',
    (value) => {
      expect(() => validateNonEmptyString(value, 'path', 'a path')).toThrow(
        /Invalid path/u,
      );
    },
  );

  test.each(['0x10', '1e3', '-1', ''])(
    'given non-decimal integer text %s, when parsing it, then rejects it',
    (value) => {
      expect(() =>
        parseDecimalIntegerText(value, 'depth', 'decimal text'),
      ).toThrow(`Invalid depth "${value}" — expected decimal text.`);
    },
  );

  test.each([
    ['a string', '1'],
    ['a decimal', 1.5],
    ['too small', 0],
    ['too large', 6],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])(
    'given %s, when checking a bounded integer, then rejects it',
    (_name, value) => {
      expect(() =>
        validateIntegerInRange(value, 'limit', 'an integer from 1 to 5', 1, 5),
      ).toThrow(
        `Invalid limit "${String(value)}" — expected an integer from 1 to 5.`,
      );
    },
  );

  test('given hidden characters, when formatting for display, then escapes them', () => {
    expect(hasControlCharacter('a\nb')).toBe(true);
    expect(hasControlCharacter('abc')).toBe(false);
    expect(hasUnicodeFormatControl('a\u202eb')).toBe(true);
    expect(hasUnicodeFormatControl('abc')).toBe(false);
    expect(formatDisplayValue('a\nb\u007fc\u202ed😀')).toBe(
      'a\\u000ab\\u007fc\\u202ed😀',
    );
    expect(formatDisplayValue('a\rb')).toBe('a\\u000db');
    expect(formatDisplayValue('a\nb\rc\td\u001be\u007ff\0g')).toBe(
      'a\\u000ab\\u000dc\\u0009d\\u001be\\u007ff\\u0000g',
    );
    expect(formatDisplayValue('src/café\u202e.ts')).toBe('src/café\\u202e.ts');
  });
});
