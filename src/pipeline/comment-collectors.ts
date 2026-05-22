/** @fileoverview Collects overview descriptions from source comments */

import { getOverviewPatternSource, type OverviewTag } from '@/pipeline/tag.js';
import { formatInvalidValueMessage } from '@/shared/error-format.js';
import { assertNever, formatDisplayValue } from '@/shared/validation.js';

const BLOCK_COMMENT_CLOSE_MARKER = '*/';
const HTML_COMMENT_CLOSE_MARKER = '-->';

export type DescriptionResult =
  | {
      readonly description: string;
      readonly state: 'complete';
    }
  | {
      readonly description: string;
      readonly state: 'open';
    }
  | {
      readonly state: 'none';
    };

type CommentFragment = {
  readonly isClosed: boolean;
  readonly text: string;
};

type MatchedOverviewComment =
  | {
      readonly afterTag: string;
      readonly linePrefix: string;
      readonly remaining: string;
      readonly state: 'line';
    }
  | {
      readonly afterTag: string;
      readonly remaining: string;
      readonly state: 'block';
    }
  | {
      readonly afterTag: string;
      readonly remaining: string;
      readonly state: 'html';
    }
  | {
      readonly state: 'skip';
    };

type CommentCloseMarker =
  | typeof BLOCK_COMMENT_CLOSE_MARKER
  | typeof HTML_COMMENT_CLOSE_MARKER;

interface CommentCollectorOptions {
  readonly cleanFragment: (value: string) => CommentFragment;
  readonly closeLineMarker?: CommentCloseMarker;
  readonly stripLeadingStar?: boolean;
}

/**
 * Collapses normal whitespace and escapes non-whitespace control characters in overview descriptions.
 *
 * @param value - Description text from an overview tag or sidecar.
 * @returns A safe one-line description, or `undefined` when no text remains.
 */
export function normalizeDescriptionText(value: string): string | undefined {
  const normalizedWhitespace = value.replace(/\s+/gu, ' ').trim();

  if (normalizedWhitespace === '') {
    return undefined;
  }

  return formatDisplayValue(normalizedWhitespace);
}

/**
 * Finds the first overview tag inside a supported source comment.
 *
 * @param fileContents - Source text already decoded as UTF-8.
 * @param tags - Overview tags to search for.
 * @returns The normalized description, or `undefined` when no tag is found.
 */
export function extractDescription(
  fileContents: string,
  tags: readonly OverviewTag[],
): string | undefined {
  return getDescriptionFromResult(extractDescriptionResult(fileContents, tags));
}

/**
 * Finds the first overview tag and reports whether its comment is complete.
 *
 * @param fileContents - Source text already decoded as UTF-8.
 * @param tags - Overview tags to search for.
 * @returns The extracted description state.
 */
export function extractDescriptionResult(
  fileContents: string,
  tags: readonly OverviewTag[],
): DescriptionResult {
  const pattern = new RegExp(getOverviewPatternSource(tags), 'g');

  for (const match of fileContents.matchAll(pattern)) {
    const comment = classifyMatchedComment(match, fileContents, tags);

    switch (comment.state) {
      case 'block':
        return collectBlockCommentDescription(
          comment.afterTag,
          comment.remaining,
        );

      case 'html':
        return collectHtmlCommentDescription(
          comment.afterTag,
          comment.remaining,
        );

      case 'line':
        return collectLineCommentDescription(
          comment.afterTag,
          comment.remaining,
          comment.linePrefix,
        );

      case 'skip':
        continue;

      default:
        return assertNever(
          comment,
          'matched overview comment',
          'block, html, line, or skip',
        );
    }
  }

  return { state: 'none' };
}

function classifyMatchedComment(
  match: RegExpExecArray,
  fileContents: string,
  tags: readonly OverviewTag[],
): MatchedOverviewComment {
  const matchedTag = getMatchedTag(match[0], tags);
  const lineStart = fileContents.lastIndexOf('\n', match.index) + 1;
  const nextLineBreak = fileContents.indexOf('\n', match.index);
  const lineEnd = nextLineBreak === -1 ? fileContents.length : nextLineBreak;
  const line = fileContents.slice(lineStart, lineEnd);
  const tagOffset = match.index - lineStart;
  const rawLinePrefix = line.slice(0, tagOffset);
  const linePrefix = rawLinePrefix.trim();
  const afterTag = line.slice(tagOffset + matchedTag.length);
  const remaining =
    nextLineBreak === -1 ? '' : fileContents.slice(nextLineBreak);

  if (
    !hasExactTagBoundaries(fileContents, match.index, matchedTag, rawLinePrefix)
  ) {
    return { state: 'skip' };
  }

  if (isInsideHtmlComment(fileContents, match.index)) {
    return {
      afterTag,
      remaining,
      state: 'html',
    };
  }

  if (linePrefix.startsWith('//') || linePrefix.startsWith('#')) {
    return {
      afterTag,
      linePrefix,
      remaining,
      state: 'line',
    };
  }

  if (
    isBlockCommentPrefix(linePrefix) &&
    isInsideBlockComment(fileContents, match.index)
  ) {
    return {
      afterTag,
      remaining,
      state: 'block',
    };
  }

  return { state: 'skip' };
}

function getDescriptionFromResult(
  descriptionResult: DescriptionResult,
): string | undefined {
  switch (descriptionResult.state) {
    case 'complete':
    case 'open':
      return descriptionResult.description;
    case 'none':
      return undefined;
    default:
      return assertNever(
        descriptionResult,
        'description result',
        'none, open, or complete',
      );
  }
}

function getMatchedTag(
  rawTag: string | undefined,
  tags: readonly OverviewTag[],
): OverviewTag {
  const matchedTag = tags.find((tag) => tag === rawTag);

  if (matchedTag === undefined) {
    throw new Error(
      formatInvalidValueMessage(
        'matched tag',
        rawTag,
        'one of the active overview tags',
      ),
    );
  }

  return matchedTag;
}

function hasExactTagBoundaries(
  fileContents: string,
  tagStartIndex: number,
  tag: OverviewTag,
  rawLinePrefix: string,
): boolean {
  return (
    hasTagStartBoundary(rawLinePrefix) &&
    hasTagEndBoundary(fileContents, tagStartIndex + tag.length)
  );
}

function hasTagStartBoundary(rawLinePrefix: string): boolean {
  if (rawLinePrefix === '' || /\s$/u.test(rawLinePrefix)) {
    return true;
  }

  const linePrefix = rawLinePrefix.trim();

  return (
    linePrefix === '/*' ||
    linePrefix === '/**' ||
    linePrefix === '*' ||
    linePrefix === '//' ||
    linePrefix === '///' ||
    linePrefix === '//!' ||
    linePrefix === '<!--' ||
    linePrefix === '#'
  );
}

function hasTagEndBoundary(fileContents: string, tagEndIndex: number): boolean {
  const nextCharacter = fileContents[tagEndIndex];

  if (nextCharacter === undefined || /\s/u.test(nextCharacter)) {
    return true;
  }

  return (
    fileContents.startsWith('*/', tagEndIndex) ||
    fileContents.startsWith('-->', tagEndIndex)
  );
}

function collectLineCommentDescription(
  afterTag: string,
  remaining: string,
  prefix: string,
): DescriptionResult {
  const parts = [cleanLineCommentFragment(afterTag)];
  const lines = remaining.split('\n').slice(1);
  let isComplete = false;

  for (const [index, rawLine] of lines.entries()) {
    const trimmed = rawLine.trimStart();

    if (!trimmed.startsWith(prefix)) {
      const isLastLine = index === lines.length - 1;

      if (rawLine !== '' || !isLastLine || !remaining.endsWith('\n')) {
        isComplete = true;
      }

      break;
    }

    const text = trimmed.slice(prefix.length).trimStart();

    if (text === '' || text.startsWith('@')) {
      const isLastLine = index === lines.length - 1;
      isComplete = !isLastLine || remaining.endsWith('\n');
      break;
    }

    parts.push(text);
  }

  return createDescriptionResult(parts, isComplete);
}

function collectBlockCommentDescription(
  afterTag: string,
  remaining: string,
): DescriptionResult {
  return collectCommentDescription(afterTag, remaining, {
    cleanFragment: (value) =>
      splitOnCloseMarker(value, BLOCK_COMMENT_CLOSE_MARKER),
    closeLineMarker: BLOCK_COMMENT_CLOSE_MARKER,
    stripLeadingStar: true,
  });
}

function collectHtmlCommentDescription(
  afterTag: string,
  remaining: string,
): DescriptionResult {
  return collectCommentDescription(afterTag, remaining, {
    cleanFragment: (value) =>
      splitOnCloseMarker(value, HTML_COMMENT_CLOSE_MARKER),
  });
}

function collectCommentDescription(
  afterTag: string,
  remaining: string,
  options: CommentCollectorOptions,
): DescriptionResult {
  const firstFragment = options.cleanFragment(afterTag);
  const parts = [firstFragment.text];

  if (firstFragment.isClosed) {
    return createDescriptionResult(parts, true);
  }

  const lines = remaining.split('\n').slice(1);
  let isComplete = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed === '') {
      continue;
    }

    if (
      options.closeLineMarker !== undefined &&
      trimmed === options.closeLineMarker
    ) {
      isComplete = true;
      break;
    }

    let candidate = trimmed;

    if (options.stripLeadingStar === true && candidate.startsWith('*')) {
      candidate = candidate.slice(1).trimStart();
    }

    const fragment = options.cleanFragment(candidate);

    if (fragment.text.startsWith('@')) {
      isComplete = true;
      break;
    }

    parts.push(fragment.text);

    if (fragment.isClosed) {
      isComplete = true;
      break;
    }
  }

  return createDescriptionResult(parts, isComplete);
}

function createDescriptionResult(
  parts: readonly string[],
  isComplete: boolean,
): DescriptionResult {
  const description = normalizeDescriptionParts(parts);

  if (description === undefined) {
    return { state: 'none' };
  }

  if (isComplete) {
    return {
      description,
      state: 'complete',
    };
  }

  return {
    description,
    state: 'open',
  };
}

function isBlockCommentPrefix(linePrefix: string): boolean {
  return linePrefix.startsWith('/*') || linePrefix.startsWith('*');
}

function isInsideBlockComment(
  fileContents: string,
  tagStartIndex: number,
): boolean {
  const openIndex = fileContents.lastIndexOf('/*', tagStartIndex);

  if (openIndex === -1) {
    return false;
  }

  const closeIndex = fileContents.lastIndexOf('*/', tagStartIndex);

  return openIndex > closeIndex;
}

function isInsideHtmlComment(
  fileContents: string,
  tagStartIndex: number,
): boolean {
  const openIndex = fileContents.lastIndexOf('<!--', tagStartIndex);

  if (openIndex === -1) {
    return false;
  }

  const closeIndex = fileContents.lastIndexOf('-->', tagStartIndex);

  if (closeIndex > openIndex) {
    return false;
  }

  const openLineStart = fileContents.lastIndexOf('\n', openIndex) + 1;
  const openLinePrefix = fileContents.slice(openLineStart, openIndex).trim();

  return openLinePrefix === '';
}

function normalizeDescriptionParts(
  parts: readonly string[],
): string | undefined {
  return normalizeDescriptionText(parts.join(' '));
}

function cleanLineCommentFragment(value: string): string {
  return value.replace(/\s*\*\/\s*$/, '').trim();
}

function splitOnCloseMarker(
  value: string,
  closeMarker: CommentCloseMarker,
): CommentFragment {
  const closeIndex = value.indexOf(closeMarker);

  if (closeIndex === -1) {
    return {
      isClosed: false,
      text: value.trim(),
    };
  }

  return {
    isClosed: true,
    text: value.slice(0, closeIndex).trim(),
  };
}
