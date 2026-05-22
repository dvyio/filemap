/** @fileoverview Validates overview tags and builds tag match patterns */

import { formatInvalidValueMessage } from '@/shared/error-format.js';

const TAG_PATTERN = /^@[A-Za-z][A-Za-z0-9_-]*$/u;

declare const overviewTagBrand: unique symbol;
export type OverviewTag = {
  readonly [overviewTagBrand]: 'OverviewTag';
} & string;

export const DEFAULT_OVERVIEW_TAGS = [
  validateTag('@fileoverview'),
  validateTag('@file'),
  validateTag('@overview'),
] as const;

/**
 * Checks a caller-provided overview tag before scanning or extracting files.
 *
 * @param tag - Tag string to check.
 * @returns The same tag after validation.
 */
export function validateTag(tag: unknown): OverviewTag {
  const normalizedTag = typeof tag === 'string' ? tag.trim() : tag;

  if (typeof normalizedTag !== 'string' || !TAG_PATTERN.test(normalizedTag)) {
    throw new Error(
      formatInvalidValueMessage(
        'tag',
        normalizedTag,
        'a tag like "@fileoverview" using letters, numbers, underscores, or hyphens',
      ),
    );
  }

  return normalizedTag as OverviewTag;
}

/**
 * Returns the default tag list or a single custom tag list.
 *
 * @param tag - Custom tag from CLI options.
 * @returns Tags to search for while reading source files.
 */
export function getOverviewTags(
  tag: string | undefined,
): readonly OverviewTag[] {
  if (tag === undefined) {
    return DEFAULT_OVERVIEW_TAGS;
  }

  const overviewTag = validateTag(tag);
  return [overviewTag];
}

/**
 * Builds the regular expression source used to find active overview tags.
 *
 * @param tags - Tags to search for in source comments.
 * @returns Escaped tag alternatives, longest tag first.
 */
export function getOverviewPatternSource(tags: readonly OverviewTag[]): string {
  return sortTagsForMatching(tags).map(escapeRegularExpression).join('|');
}

function sortTagsForMatching(
  tags: readonly OverviewTag[],
): readonly OverviewTag[] {
  return [...tags].sort((firstTag, secondTag) => {
    return secondTag.length - firstTag.length;
  });
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
