/** @fileoverview Defines the picomatch matcher surface filemap uses */

declare module 'picomatch' {
  export interface PicomatchOptions {
    readonly dot?: boolean;
  }

  export type PicomatchMatcher = (path: string) => boolean;

  export default function picomatch(
    patterns: readonly string[] | string,
    options?: PicomatchOptions,
  ): PicomatchMatcher;
}
