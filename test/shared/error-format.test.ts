import { describe, expect, test } from 'vitest';

import {
  createNonErrorThrownValueError,
  formatErrorChain,
  formatInvalidValueMessage,
} from '@/shared/error-format.js';

describe('formatInvalidValueMessage', () => {
  test('given a hidden control value, when formatting, then it escapes the value', () => {
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
});

describe('createNonErrorThrownValueError', () => {
  test('given boundary context, when wrapping a non-Error value, then it includes the context', () => {
    const error = createNonErrorThrownValueError(
      'open failed',
      'File open failed',
    );

    expect(error.message).toBe(
      'File open failed with a non-error value "open failed".',
    );
    expect(error.cause).toBe('open failed');
  });

  test('given an Error value, when wrapping, then it returns the same Error', () => {
    const error = new Error('Already an Error.');

    expect(createNonErrorThrownValueError(error, 'File open failed')).toBe(
      error,
    );
  });
});

describe('formatErrorChain', () => {
  test('given validation error without a cause, when formatting, then keeps the message unchanged', () => {
    expect(
      formatErrorChain(
        new Error('Invalid scope "x" — expected a file or directory.'),
      ),
    ).toBe('Invalid scope "x" — expected a file or directory.');
  });

  test('given normal cause chain, when formatting, then keeps the readable cause format', () => {
    const error = new Error('Top failure', {
      cause: new Error('Middle failure', {
        cause: new Error('Root failure'),
      }),
    });

    expect(formatErrorChain(error)).toBe(
      [
        'Top failure',
        '  caused by: Middle failure',
        '  caused by: Root failure',
      ].join('\n'),
    );
  });

  test('given a wrapper with the same message as its cause, when formatting, then it skips the duplicate line', () => {
    const error = new Error('Same failure', {
      cause: new Error('Same failure', {
        cause: new Error('Root failure'),
      }),
    });

    expect(formatErrorChain(error)).toBe(
      ['Same failure', '  caused by: Root failure'].join('\n'),
    );
  });

  test('given aggregate cleanup errors, when formatting, then prints each nested failure', () => {
    const error = new AggregateError(
      [
        new Error('Primary task failure', {
          cause: new Error('Worker stopped'),
        }),
        new Error('Failed to close worker "a".', {
          cause: new Error('Worker busy'),
        }),
        new Error('Failed to close worker "b".'),
      ],
      'Task failed.',
      {
        cause: new Error('Primary task failure', {
          cause: new Error('Worker stopped'),
        }),
      },
    );

    expect(formatErrorChain(error)).toBe(
      [
        'Task failed.',
        '  caused by: Primary task failure',
        '  caused by: Worker stopped',
        '  aggregate error: Failed to close worker "a".',
        '    caused by: Worker busy',
        '  aggregate error: Failed to close worker "b".',
      ].join('\n'),
    );
  });

  test('given nested aggregate errors, when formatting, then prints nested cleanup details', () => {
    const error = new AggregateError(
      [
        new AggregateError(
          [
            new Error('Failed to stop worker "a".'),
            new Error('Failed to close worker "b".'),
          ],
          '2 cleanup failure(s).',
        ),
      ],
      'Task finished, but cleanup failed.',
    );

    expect(formatErrorChain(error)).toBe(
      [
        'Task finished, but cleanup failed.',
        '  aggregate error: 2 cleanup failure(s).',
        '    aggregate error: Failed to stop worker "a".',
        '    aggregate error: Failed to close worker "b".',
      ].join('\n'),
    );
  });

  test('given an aggregate contains a non-error value, when formatting, then it prints the value', () => {
    const error = new AggregateError(['plain cleanup failure'], 'Task failed.');

    expect(formatErrorChain(error)).toBe(
      ['Task failed.', '  aggregate error: plain cleanup failure'].join('\n'),
    );
  });
});
