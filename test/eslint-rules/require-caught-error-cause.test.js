import typescriptParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import { describe, test } from 'vitest';

import requireCaughtErrorCause from '../../eslint-rules/require-caught-error-cause.js';

const missingCaughtErrorCause = { messageId: 'missingCaughtErrorCause' };

RuleTester.describe = describe;
RuleTester.it = test;
RuleTester.itOnly = test.only;
RuleTester.setDefaultConfig({
  languageOptions: {
    ecmaVersion: 2024,
    parser: typescriptParser,
    sourceType: 'module',
  },
});

new RuleTester().run('require-caught-error-cause', requireCaughtErrorCause, {
  invalid: [
    {
      code: 'try { work(); } catch (error) { throw new FilemapError("Failed to work."); }',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'try { work(); } catch (error) { throw new errors.FilemapError("Failed to work."); }',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'try { work(); } catch (error) { throw createNonErrorThrownValueError(); }',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'try { work(); } catch (error) { return Promise.reject(new Error("Failed to work.")); }',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'work().catch((error) => { throw new Error("Failed to work."); });',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'work().catch((error) => { throw Error("Failed to work."); });',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'work().catch((error) => { return Promise.reject(new Error("Failed to work.")); });',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'work().catch((error) => { return Promise.reject(new TypeError("Failed to work.")); });',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'work().catch((error) => { throw new AggregateError(errors, "Failed to work."); });',
      errors: [missingCaughtErrorCause],
    },
    {
      code: 'work().catch((error) => { throw new Error("Failed to work.", { cause: other }); });',
      errors: [missingCaughtErrorCause],
    },
  ],
  valid: [
    'try { work(); } catch (error) { throw new Error("Core rule owns this case."); }',
    'try { work(); } catch (error) { throw new TypeError("Core rule owns this case."); }',
    'try { work(); } catch (error) { throw Error("Core rule owns this case."); }',
    'try { work(); } catch (error) { throw new AggregateError(errors, "Core rule owns this case."); }',
    'try { work(); } catch (error) { throw new Error("Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { throw new Error("Failed to work.", { ...options, cause: error }); }',
    'try { work(); } catch (error) { throw Error("Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { throw new FilemapError("Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { throw new errors.FilemapError("Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { throw new AggregateError(errors, "Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { throw createNonErrorThrownValueError(error); }',
    'try { work(); } catch (error) { if (error instanceof Error) { throw error; } throw new Error("Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { cleanup(error); }',
    'try { work(); } catch { throw new Error("No caught value here."); }',
    'try { work(); } catch (error) { function inner() { throw new Error("Nested failure."); } throw new Error("Failed to work.", { cause: error }); }',
    'try { work(); } catch (error) { Promise.reject(); }',
    'try { work(); } catch (error) { other.reject(new Error("Failed to work.")); }',
    'try { work(); } catch (error) { getPromise().reject(new Error("Failed to work.")); }',
    'try { work(); } catch (error) { reject(new Error("Failed to work.")); }',
    'try { work(); } catch (error) { throw makeError("Failed to work."); }',
    'try { work(); } catch (error) { throw Namespace.Error("Failed to work."); }',
    'try { work(); } catch (error) { throw new Failure("Core rule owns this case."); }',
    'work().catch(() => { throw new Error("No caught value here."); });',
    'work().catch(handleFailure);',
    'work().catch(({ message }) => { log(message); });',
    'work().catch((error) => { throw new Failure("Not an error constructor name."); });',
    'work().catch((error) => { throw new (getError())("Dynamic constructor."); });',
    'work().catch((error) => { return Promise.reject(new Error("Failed to work.", { cause: error })); });',
  ],
});
