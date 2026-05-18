import {
  parseDiffFromFile,
  parsePatchFiles,
  registerCustomTheme,
  type DiffLineAnnotation,
  type CodeViewItem,
  type CodeViewOptions,
  type FileDiffMetadata,
} from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import {
  useCallback,
  useEffect,
  Fragment,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import codexIconUrl from './assets/codex.svg';
import dunkelTheme from './themes/dunkel.json' with { type: 'json' };
import lichtTheme from './themes/licht.json' with { type: 'json' };
import type {
  ChangedFile,
  CodiffLaunchOptions,
  CodiffPreferences,
  DiffSection,
  GitIdentity,
  GitFileStatus,
  HistoryEntry,
  RepositoryState,
  ReviewAssistantRequest,
  Walkthrough,
  ReviewSource,
} from './types.ts';

type ReviewAnnotationMetadata = {
  commentIds: ReadonlyArray<string>;
};

type CodeViewInstance = NonNullable<
  ReturnType<CodeViewHandle<ReviewAnnotationMetadata>['getInstance']>
>;

type DiffSearchMatch = {
  filePath: string;
  itemId: string;
  lineNumber?: number;
  side?: 'additions' | 'deletions';
};

type DiffSearchResult = {
  file: ChangedFile;
  matchCount: number;
  matches: ReadonlyArray<DiffSearchMatch>;
};

type ReviewComment = {
  body: string;
  codexReply?: {
    body?: string;
    error?: string;
    status: 'error' | 'loading' | 'ready';
  };
  filePath: string;
  id: string;
  lineNumber: number;
  sectionId: string;
  side: 'additions' | 'deletions';
};

type SidebarMode = 'tree' | 'walkthrough' | 'history';

type WalkthroughNote = {
  action: Walkthrough['groups'][number]['files'][number]['action'];
  context: string;
  groupReason: string;
  groupTitle: string;
  impact: Walkthrough['groups'][number]['files'][number]['impact'];
  order: number;
  reason: string;
};

type SourceSession = {
  collapsed: Set<string>;
  reviewComments: ReadonlyArray<ReviewComment>;
  selectedPath: string | null;
  viewed: Record<string, string>;
  walkthrough: Walkthrough | null;
  walkthroughError: string | null;
};

const emptyWalkthroughNotes = new Map<string, WalkthroughNote>();

const HISTORY_PAGE_SIZE = 30;

registerCustomTheme('Licht', async () => lichtTheme as never);
registerCustomTheme('Dunkel', async () => dunkelTheme as never);

const statusLabel: Record<GitFileStatus, string> = {
  added: 'Added',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};

const sectionLabel: Record<DiffSection['kind'], string> = {
  commit: 'Commit',
  staged: 'Staged',
  unstaged: 'Unstaged',
};

const getSourceKey = (source: ReviewSource) =>
  source.type === 'commit' ? `commit:${source.ref}` : 'working-tree';

const getShortRef = (ref: string) => ref.slice(0, 7);

const getSourceLabel = (source: ReviewSource) =>
  source.type === 'commit' ? getShortRef(source.ref) : 'Uncommitted';

const renderInlineMarkdown = (text: string): ReactNode => {
  const nodes: Array<ReactNode> = [];
  const pattern = /`([^`\n]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const renderText = (value: string, keyPrefix: string): Array<ReactNode> => {
    const textNodes: Array<ReactNode> = [];
    const boldPattern = /\*\*([^*\n]+)\*\*/g;
    let textLastIndex = 0;
    let boldMatch: RegExpExecArray | null;

    while ((boldMatch = boldPattern.exec(value))) {
      if (boldMatch.index > textLastIndex) {
        textNodes.push(value.slice(textLastIndex, boldMatch.index));
      }

      textNodes.push(<strong key={`${keyPrefix}:bold:${boldMatch.index}`}>{boldMatch[1]}</strong>);
      textLastIndex = boldPattern.lastIndex;
    }

    if (textLastIndex < value.length) {
      textNodes.push(value.slice(textLastIndex));
    }

    return textNodes.length > 0 ? textNodes : [value];
  };

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      nodes.push(...renderText(text.slice(lastIndex, match.index), `${lastIndex}`));
    }

    nodes.push(
      <code className="walkthrough-inline-code" key={`${match.index}:${match[1]}`}>
        {match[1]}
      </code>,
    );
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderText(text.slice(lastIndex), `${lastIndex}`));
  }

  return nodes.length > 0 ? nodes : text;
};

const renderMarkdown = (text: string): ReactNode => {
  const blocks: Array<ReactNode> = [];
  const renderTextBlocks = (value: string, keyPrefix: string) => {
    for (const [index, block] of value
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean)
      .entries()) {
      const lines = block.split('\n');
      const listItems = lines
        .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1])
        .filter((line): line is string => line != null);

      if (listItems.length === lines.length) {
        blocks.push(
          <ul key={`${keyPrefix}:list:${index}`}>
            {listItems.map((line, lineIndex) => (
              <li key={`${keyPrefix}:list:${index}:${lineIndex}`}>{renderInlineMarkdown(line)}</li>
            ))}
          </ul>,
        );
      } else {
        blocks.push(
          <p key={`${keyPrefix}:p:${index}`}>
            {lines.map((line, lineIndex) => (
              <span key={`${keyPrefix}:p:${index}:${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineMarkdown(line)}
              </span>
            ))}
          </p>,
        );
      }
    }
  };

  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text))) {
    if (match.index > lastIndex) {
      renderTextBlocks(text.slice(lastIndex, match.index), `${lastIndex}`);
    }

    blocks.push(
      <pre key={`code:${match.index}`}>
        <code>{match[2]}</code>
      </pre>,
    );
    lastIndex = fencePattern.lastIndex;
  }

  if (lastIndex < text.length) {
    renderTextBlocks(text.slice(lastIndex), `${lastIndex}`);
  }

  return blocks.length > 0 ? blocks : renderInlineMarkdown(text);
};

const walkthroughActionLabel: Record<WalkthroughNote['action'], string> = {
  review: 'Review',
  scan: 'Scan',
  skim: 'Skim',
};

const walkthroughImpactLabel: Record<WalkthroughNote['impact'], string> = {
  contained: 'Contained',
  mechanical: 'Mechanical',
  wide: 'Wide impact',
};

const statusForTree: Record<
  GitFileStatus,
  'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'
> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  untracked: 'untracked',
};

// 11px needed to account for the box shadow around individual diffs
const DEFAULT_PADDING = 11;

const codeViewLayout = {
  // 2px is used to account for a 10px gap with the 1px box shadows
  gap: 12,
  paddingBottom: DEFAULT_PADDING,
  paddingTop: DEFAULT_PADDING,
};

const codeViewItemMetrics = {
  diffHeaderHeight: 54,
};

const codeViewItemMetricsWithWalkthrough = {
  diffHeaderHeight: 78,
};

const diffContextExpansionLineCount = 100;
const diffCollapsedContextThreshold = 12;

const workerHighlighterOptions = {
  lineDiffType: 'char' as const,
  maxLineDiffLength: 2000,
  theme: {
    dark: 'Dunkel',
    light: 'Licht',
  },
  tokenizeMaxLineLength: 20_000,
  useTokenTransformer: false,
};

const maxWorkerThreads = 3;

const fileTreeSort = (
  left: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
  right: { isDirectory: boolean; path: string; segments?: ReadonlyArray<string> },
) => compareTreePaths(left.path, right.path);

const defaultPreferences: CodiffPreferences = {
  showWhitespace: false,
};

const codeViewUnsafeCSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
    --diffs-light-bg: #ffffff;
    --diffs-dark-bg: #1c1c1c;
  }

  [data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns: minmax(0, 42fr) minmax(0, 58fr);
  }

  /* Align scrollbar with number column */
  [data-code]::-webkit-scrollbar-track {
    margin-left: var(--diffs-column-number-width);
  }

  /* Ensure right edge of scrollbar never gets cropped by rounded corners */
  [data-file] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="single"] [data-code]::-webkit-scrollbar-track,
  [data-diff-type="split"] [data-code][data-additions]::-webkit-scrollbar-track {
    margin-right: 14px;
  }

  .codiff-search-mark {
    background: var(--diffs-find-highlight-bg, rgb(255 216 92 / 0.65));
    border-radius: 3px;
    color: inherit;
    padding: 0 1px;
  }

  .codiff-search-mark.active {
    background: var(--diffs-find-active-bg, rgb(255 176 46 / 0.96));
    box-shadow: 0 0 0 1px rgb(255 142 36 / 0.4);
  }

  [data-utility-button] {
    background: color-mix(in srgb, var(--diffs-bg) 88%, var(--diffs-modified-base));
    border: 1px solid color-mix(in srgb, var(--diffs-modified-base) 34%, transparent);
    border-radius: 3px;
    box-shadow: 0 7px 18px -14px rgb(0 0 0 / 0.72);
    color: var(--diffs-modified-base);
    height: calc(1lh - 2px);
    width: calc(1lh - 2px);
  }
`;

const compactPath = (path: string) => {
  const homePath = path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~');
  const parts = homePath.split('/').filter(Boolean);

  if (parts.length <= 2) {
    return homePath;
  }

  const prefix = homePath.startsWith('/') ? '/' : '';
  const [first, ...rest] = parts;
  const last = rest.pop();
  const middle = rest.map((part) => part[0]).join('/');

  return `${prefix}${first}/${middle ? `${middle}/` : ''}${last}`;
};

function compareTreePaths(leftPath: string, rightPath: string) {
  const leftParts = leftPath.split('/');
  const rightParts = rightPath.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = leftParts[index];
    const right = rightParts[index];
    if (left === right) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return left.localeCompare(right);
  }

  return leftParts.length - rightParts.length;
}

const sortFiles = (files: ReadonlyArray<ChangedFile>) =>
  [...files].sort((left, right) => compareTreePaths(left.path, right.path));

const getWalkthroughNotes = (walkthrough: Walkthrough | null) => {
  const notes = new Map<string, WalkthroughNote>();
  if (!walkthrough) {
    return notes;
  }

  let order = 0;
  for (const group of walkthrough.groups) {
    for (const file of group.files) {
      if (!notes.has(file.path)) {
        notes.set(file.path, {
          action: file.action,
          context: file.context,
          groupReason: group.reason,
          groupTitle: group.title,
          impact: file.impact,
          order,
          reason: file.reason,
        });
        order += 1;
      }
    }
  }

  return notes;
};

const orderFilesByWalkthrough = (
  files: ReadonlyArray<ChangedFile>,
  walkthrough: Walkthrough | null,
) => {
  if (!walkthrough) {
    return files;
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedFiles: Array<ChangedFile> = [];
  const seen = new Set<string>();

  for (const group of walkthrough.groups) {
    for (const item of group.files) {
      const file = filesByPath.get(item.path);
      if (file && !seen.has(file.path)) {
        orderedFiles.push(file);
        seen.add(file.path);
      }
    }
  }

  for (const file of files) {
    if (!seen.has(file.path)) {
      orderedFiles.push(file);
    }
  }

  return orderedFiles;
};

const fuzzyMatches = (path: string, query: string) => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const normalizedPath = path.toLowerCase();
  let pathIndex = 0;
  for (const character of normalizedQuery) {
    pathIndex = normalizedPath.indexOf(character, pathIndex);
    if (pathIndex === -1) {
      return false;
    }
    pathIndex += 1;
  }
  return true;
};

type NativeInputEventTarget = EventTarget & {
  closest?: (selector: string) => Element | null;
  isContentEditable?: boolean;
};

export const isNativeInputTarget = (target: EventTarget | null) => {
  const candidate = target as NativeInputEventTarget | null;
  return (
    candidate?.closest?.('input, select, textarea') != null || candidate?.isContentEditable === true
  );
};

const isMacPlatform = (platform = navigator.platform) => platform.toLowerCase().includes('mac');

export const isDiffSearchShortcut = (
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
  platform = navigator.platform,
) => {
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') {
    return false;
  }

  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
};

const getViewedKey = (root: string) => `codiff:viewed:${root}`;

const getReloadShortcutLabel = () => {
  return isMacPlatform() ? '⌘R' : 'Ctrl+R';
};

const readViewed = (root: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(getViewedKey(root)) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const writeViewed = (root: string, viewed: Record<string, string>) => {
  localStorage.setItem(getViewedKey(root), JSON.stringify(viewed));
};

const getItemId = (section: DiffSection) => `diff:${section.id}`;

const countOccurrences = (text: string, normalizedQuery: string) => {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  let count = 0;
  let index = normalizedText.indexOf(normalizedQuery);
  while (index !== -1) {
    count += 1;
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length);
  }

  return count;
};

const lineContainsQuery = (text: string | undefined, normalizedQuery: string) =>
  text != null && text.toLowerCase().includes(normalizedQuery);

export const getDiffSearchResult = (
  file: ChangedFile,
  showWhitespace: boolean,
  query: string,
): DiffSearchResult | null => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  const matches: Array<DiffSearchMatch> = [];
  let matchCount = 0;
  const seenLineMatches = new Set<string>();

  const pushMatch = (match: DiffSearchMatch, occurrences: number) => {
    matchCount += occurrences;
    const key = `${match.itemId}:${match.side ?? 'header'}:${match.lineNumber ?? 'header'}`;
    if (!seenLineMatches.has(key)) {
      seenLineMatches.add(key);
      matches.push(match);
    }
  };

  const headerOccurrences =
    countOccurrences(file.path, normalizedQuery) +
    (file.oldPath ? countOccurrences(file.oldPath, normalizedQuery) : 0);

  if (headerOccurrences > 0) {
    const section = getFirstVisibleSection(file, showWhitespace);
    if (section) {
      pushMatch(
        {
          filePath: file.path,
          itemId: getItemId(section),
        },
        headerOccurrences,
      );
    }
  }

  for (const { fileDiff, section } of getVisibleDiffSections(file, showWhitespace)) {
    const itemId = getItemId(section);

    for (const hunk of fileDiff.hunks) {
      let deletionLineNumber = hunk.deletionStart;
      let additionLineNumber = hunk.additionStart;

      for (const content of hunk.hunkContent) {
        if (content.type === 'context') {
          for (let index = 0; index < content.lines; index += 1) {
            const line = fileDiff.additionLines[content.additionLineIndex + index];
            const occurrences = countOccurrences(line ?? '', normalizedQuery);
            if (occurrences > 0) {
              pushMatch(
                {
                  filePath: file.path,
                  itemId,
                  lineNumber: additionLineNumber + index,
                  side: 'additions',
                },
                occurrences,
              );
            }
          }

          deletionLineNumber += content.lines;
          additionLineNumber += content.lines;
          continue;
        }

        for (let index = 0; index < content.deletions; index += 1) {
          const line = fileDiff.deletionLines[content.deletionLineIndex + index];
          const occurrences = countOccurrences(line ?? '', normalizedQuery);
          if (occurrences > 0) {
            pushMatch(
              {
                filePath: file.path,
                itemId,
                lineNumber: deletionLineNumber + index,
                side: 'deletions',
              },
              occurrences,
            );
          }
        }

        for (let index = 0; index < content.additions; index += 1) {
          const line = fileDiff.additionLines[content.additionLineIndex + index];
          const occurrences = countOccurrences(line ?? '', normalizedQuery);
          if (occurrences > 0) {
            pushMatch(
              {
                filePath: file.path,
                itemId,
                lineNumber: additionLineNumber + index,
                side: 'additions',
              },
              occurrences,
            );
          }
        }

        deletionLineNumber += content.deletions;
        additionLineNumber += content.additions;
      }
    }

    if (section.summary?.reason && lineContainsQuery(section.summary.reason, normalizedQuery)) {
      pushMatch(
        {
          filePath: file.path,
          itemId,
          lineNumber: 1,
          side: 'additions',
        },
        countOccurrences(section.summary.reason, normalizedQuery),
      );
    }
  }

  return matches.length > 0
    ? {
        file,
        matchCount,
        matches,
      }
    : null;
};

const searchMarkSelector = 'mark.codiff-search-mark';

const clearSearchHighlights = (root: ParentNode) => {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(searchMarkSelector))) {
    const parent = mark.parentElement;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
    parent?.normalize();
  }
};

const getSearchableRoots = (element: HTMLElement): Array<ParentNode> => {
  const roots: Array<ParentNode> = [element];
  if (element.shadowRoot) {
    roots.push(element.shadowRoot);
  }
  return roots;
};

const isNodeInsideSearchMark = (node: Node) =>
  node.parentElement?.closest(searchMarkSelector) != null;

const highlightTextContainer = (
  container: HTMLElement,
  normalizedQuery: string,
  activeMatch: DiffSearchMatch | null,
) => {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent && node.textContent.toLowerCase().includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const textNodes: Array<Text> = [];
  let node = walker.nextNode();
  while (node) {
    if (!isNodeInsideSearchMark(node)) {
      textNodes.push(node as Text);
    }
    node = walker.nextNode();
  }

  const row = container.closest<HTMLElement>('[data-line]');
  const codeColumn = container.closest<HTMLElement>('[data-code]');
  const side = codeColumn?.hasAttribute('data-deletions') ? 'deletions' : 'additions';
  const isActiveLine =
    activeMatch?.lineNumber != null &&
    Number(row?.dataset.line) === activeMatch.lineNumber &&
    activeMatch.side === side;

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let matchIndex = text.toLowerCase().indexOf(normalizedQuery);

    while (matchIndex !== -1) {
      if (matchIndex > offset) {
        fragment.append(document.createTextNode(text.slice(offset, matchIndex)));
      }

      const mark = document.createElement('mark');
      mark.className = `codiff-search-mark${isActiveLine ? ' active' : ''}`;
      mark.textContent = text.slice(matchIndex, matchIndex + normalizedQuery.length);
      fragment.append(mark);
      offset = matchIndex + normalizedQuery.length;
      matchIndex = text.toLowerCase().indexOf(normalizedQuery, offset);
    }

    if (offset < text.length) {
      fragment.append(document.createTextNode(text.slice(offset)));
    }

    textNode.replaceWith(fragment);
  }
};

const applySearchHighlights = (
  renderedItems: ReadonlyArray<{ element: HTMLElement; id: string }>,
  query: string,
  activeMatch: DiffSearchMatch | null,
) => {
  const normalizedQuery = query.trim().toLowerCase();

  for (const { element, id } of renderedItems) {
    for (const root of getSearchableRoots(element)) {
      clearSearchHighlights(root);

      if (!normalizedQuery) {
        continue;
      }

      const matchForItem = activeMatch && activeMatch.itemId === id ? activeMatch : null;

      for (const container of Array.from(
        root.querySelectorAll<HTMLElement>('[data-code] [data-column-content]'),
      )) {
        highlightTextContainer(container, normalizedQuery, matchForItem);
      }
    }
  }
};

const getItemVersion = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash >>> 0;
};

type CodeViewItemMetadata = {
  file: ChangedFile;
  isCollapsed: boolean;
  isSelected: boolean;
  isViewed: boolean;
  section: DiffSection;
  sectionCount: number;
  walkthroughNote?: WalkthroughNote;
};

const createBinaryFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: [`${section.summary?.reason ?? 'Binary file changed.'}\n`],
  cacheKey: `summary:${file.fingerprint}:${section.id}:${section.loadState ?? 'binary'}:${
    section.summary?.reason ?? ''
  }`,
  deletionLines: [],
  hunks: [
    {
      additionCount: 1,
      additionLineIndex: 0,
      additionLines: 1,
      additionStart: 1,
      collapsedBefore: 0,
      deletionCount: 0,
      deletionLineIndex: 0,
      deletionLines: 0,
      deletionStart: 0,
      hunkContent: [
        {
          additionLineIndex: 0,
          additions: 1,
          deletionLineIndex: 0,
          deletions: 0,
          type: 'change',
        },
      ],
      hunkSpecs: '@@ -0,0 +1 @@\n',
      noEOFCRAdditions: false,
      noEOFCRDeletions: false,
      splitLineCount: 1,
      splitLineStart: 0,
      unifiedLineCount: 1,
      unifiedLineStart: 0,
    },
  ],
  isPartial: true,
  name: file.path,
  prevName: file.oldPath,
  splitLineCount: 1,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 1,
});

const createEmptyFileDiff = (file: ChangedFile, section: DiffSection): FileDiffMetadata => ({
  additionLines: section.newFile?.contents.split('\n') ?? [],
  cacheKey: `empty:${file.fingerprint}:${section.id}`,
  deletionLines: section.oldFile?.contents.split('\n') ?? [],
  hunks: [],
  isPartial: false,
  name: section.newFile?.name ?? file.path,
  prevName: section.oldFile?.name ?? file.oldPath,
  splitLineCount: 0,
  type: file.status === 'deleted' ? 'deleted' : file.status === 'added' ? 'new' : 'change',
  unifiedLineCount: 0,
});

const parsedDiffCache = new Map<string, FileDiffMetadata>();

const getSectionCacheIdentity = (section: DiffSection) =>
  [
    section.loadState ?? 'ready',
    section.summary?.reason ?? '',
    section.oldFile?.cacheKey ?? '',
    section.newFile?.cacheKey ?? '',
    section.patch.length,
  ].join(':');

const parseSectionDiffWithOptions = (
  file: ChangedFile,
  section: DiffSection,
  showWhitespace: boolean,
): FileDiffMetadata => {
  const cacheKey = `${file.fingerprint}:${section.id}:${getSectionCacheIdentity(section)}:${
    showWhitespace ? 'ws' : 'ignore-ws'
  }`;
  const cached = parsedDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let fileDiff: FileDiffMetadata;
  if (section.binary || (section.loadState != null && section.loadState !== 'ready')) {
    fileDiff = createBinaryFileDiff(file, section);
  } else if (section.oldFile && section.newFile) {
    try {
      fileDiff = {
        ...parseDiffFromFile(section.oldFile, section.newFile, {
          ignoreWhitespace: !showWhitespace,
        }),
        cacheKey,
      };
    } catch {
      fileDiff = createEmptyFileDiff(file, section);
    }
  } else {
    const parsedFileDiff = parsePatchFiles(section.patch)[0]?.files[0];
    fileDiff = parsedFileDiff
      ? {
          ...parsedFileDiff,
          cacheKey,
        }
      : createBinaryFileDiff(file, section);
  }

  parsedDiffCache.set(cacheKey, fileDiff);
  return fileDiff;
};

const fileHasMetadataDiff = (file: ChangedFile) =>
  file.status === 'renamed' && file.oldPath != null && file.oldPath !== file.path;

const sectionHasVisibleDiff = (
  file: ChangedFile,
  section: DiffSection,
  fileDiff: FileDiffMetadata,
) =>
  section.binary ||
  (section.loadState != null && section.loadState !== 'ready') ||
  fileHasMetadataDiff(file) ||
  fileDiff.hunks.length > 0;

export const getVisibleDiffSections = (file: ChangedFile, showWhitespace: boolean) =>
  file.sections
    .map((section) => ({
      fileDiff: parseSectionDiffWithOptions(file, section, showWhitespace),
      section,
    }))
    .filter(({ fileDiff, section }) => sectionHasVisibleDiff(file, section, fileDiff));

export const fileHasVisibleDiff = (file: ChangedFile, showWhitespace: boolean) =>
  getVisibleDiffSections(file, showWhitespace).length > 0;

const getFirstVisibleSection = (file: ChangedFile, showWhitespace: boolean) =>
  getVisibleDiffSections(file, showWhitespace)[0]?.section;

const getCommentKey = (comment: Pick<ReviewComment, 'lineNumber' | 'sectionId' | 'side'>) =>
  `${comment.sectionId}:${comment.side}:${comment.lineNumber}`;

const getReviewCommentsDigest = (comments: ReadonlyArray<ReviewComment>) =>
  comments
    .map((comment) => `${comment.id}:${comment.sectionId}:${comment.side}:${comment.lineNumber}`)
    .join('\0');

const getMarkdownFence = (content: string) => {
  let fence = '```';
  while (content.includes(fence)) {
    fence += '`';
  }
  return fence;
};

const indentMarkdown = (value: string) =>
  value
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');

const formatReviewLineNumber = (lineNumber: number | string) => String(lineNumber).padStart(4);

const getReviewCommentPatchContext = (
  file: ChangedFile,
  section: DiffSection,
  comment: ReviewComment,
  showWhitespace: boolean,
) => {
  const fileDiff = parseSectionDiffWithOptions(file, section, showWhitespace);

  for (const hunk of fileDiff.hunks) {
    const rows: Array<{
      additionLineNumber?: number;
      deletionLineNumber?: number;
      prefix: '+' | '-' | ' ';
      side?: ReviewComment['side'];
      text: string;
    }> = [];
    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let index = 0; index < content.lines; index += 1) {
          rows.push({
            additionLineNumber: additionLineNumber + index,
            deletionLineNumber: deletionLineNumber + index,
            prefix: ' ',
            text: fileDiff.additionLines[content.additionLineIndex + index] ?? '',
          });
        }
        deletionLineNumber += content.lines;
        additionLineNumber += content.lines;
        continue;
      }

      for (let index = 0; index < content.deletions; index += 1) {
        rows.push({
          deletionLineNumber: deletionLineNumber + index,
          prefix: '-',
          side: 'deletions',
          text: fileDiff.deletionLines[content.deletionLineIndex + index] ?? '',
        });
      }

      for (let index = 0; index < content.additions; index += 1) {
        rows.push({
          additionLineNumber: additionLineNumber + index,
          prefix: '+',
          side: 'additions',
          text: fileDiff.additionLines[content.additionLineIndex + index] ?? '',
        });
      }

      deletionLineNumber += content.deletions;
      additionLineNumber += content.additions;
    }

    const targetIndex = rows.findIndex((row) =>
      row.side
        ? row.side === comment.side &&
          (comment.side === 'additions'
            ? row.additionLineNumber === comment.lineNumber
            : row.deletionLineNumber === comment.lineNumber)
        : comment.side === 'additions'
          ? row.additionLineNumber === comment.lineNumber
          : row.deletionLineNumber === comment.lineNumber,
    );

    if (targetIndex === -1) {
      continue;
    }

    const start = Math.max(0, targetIndex - 3);
    const end = Math.min(rows.length, targetIndex + 4);
    const context = rows.slice(start, end).map((row) => {
      const lineNumber =
        row.prefix === '+'
          ? row.additionLineNumber
          : row.prefix === '-'
            ? row.deletionLineNumber
            : `${row.deletionLineNumber ?? ''}/${row.additionLineNumber ?? ''}`;
      return `${row.prefix}${formatReviewLineNumber(lineNumber ?? '')} | ${row.text}`;
    });

    return [hunk.hunkSpecs?.trim(), ...context].filter(Boolean).join('\n');
  }

  return section.summary?.reason || section.patch.trim() || 'No patch context available.';
};

export const buildReviewCommentsMarkdown = (
  files: ReadonlyArray<ChangedFile>,
  comments: ReadonlyArray<ReviewComment>,
  showWhitespace: boolean,
) => {
  const pendingComments = comments.filter((comment) => comment.body.trim());
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const orderedComments = pendingComments.sort((left, right) => {
    const leftFileIndex = files.findIndex((file) => file.path === left.filePath);
    const rightFileIndex = files.findIndex((file) => file.path === right.filePath);
    return (
      leftFileIndex - rightFileIndex ||
      left.lineNumber - right.lineNumber ||
      left.id.localeCompare(right.id)
    );
  });

  const markdown = orderedComments
    .map((comment, index) => {
      const file = filesByPath.get(comment.filePath);
      const section = file?.sections.find((candidate) => candidate.id === comment.sectionId);
      const context =
        file && section
          ? getReviewCommentPatchContext(file, section, comment, showWhitespace)
          : 'No patch context available.';
      const fence = getMarkdownFence(context);

      return [
        `${index + 1}. **${comment.filePath}** (${comment.side} line ${comment.lineNumber})`,
        '',
        indentMarkdown(`${fence}diff\n${context}\n${fence}`),
        '',
        indentMarkdown(comment.body.trim()),
      ].join('\n');
    })
    .join('\n\n');

  return markdown ? `# Address these Review Comments\n\n${markdown}` : '';
};

export const shouldDiscardReviewCommentOnEscape = (
  body: string,
  confirmDiscard: (message: string) => boolean = window.confirm,
) => body.trim().length === 0 || confirmDiscard('Discard this review comment?');

function Sidebar({
  currentSource,
  files,
  historyEntries,
  historyHasMore,
  historyLoading,
  mode,
  onActivatePath,
  onLoadMoreHistory,
  onModeChange,
  onSearchQueryChange,
  onSelectPath,
  onSelectSource,
  searchQuery,
  selectedPath,
  walkthroughAvailable,
  walkthroughError,
  walkthroughLoading,
  walkthroughNotes,
  walkthroughSummary,
  walkthroughUnread,
}: {
  currentSource: ReviewSource;
  files: ReadonlyArray<ChangedFile>;
  historyEntries: ReadonlyArray<HistoryEntry>;
  historyHasMore: boolean;
  historyLoading: boolean;
  mode: SidebarMode;
  onActivatePath: (path: string) => void;
  onLoadMoreHistory: () => void;
  onModeChange: (mode: SidebarMode) => void;
  onSearchQueryChange: (query: string) => void;
  onSelectPath: (path: string) => void;
  onSelectSource: (source: ReviewSource) => void;
  searchQuery: string;
  selectedPath: string | null;
  walkthroughAvailable: boolean;
  walkthroughError: string | null;
  walkthroughLoading: boolean;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  walkthroughSummary: Walkthrough['summary'] | null;
  walkthroughUnread: boolean;
}) {
  const allowSelectionScroll = useRef(false);
  const allowSelectionScrollTimer = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const treeHostRef = useRef<HTMLDivElement>(null);
  const suppressSelectionChange = useRef(false);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const filePathSet = useMemo(() => new Set(paths), [paths]);
  const status = useMemo(
    () =>
      files.map((file) => ({
        path: file.path,
        status: statusForTree[file.status],
      })),
    [files],
  );
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    gitStatus: status,
    initialExpansion: 'open',
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    itemHeight: 30,
    onSelectionChange: (paths) => {
      if (suppressSelectionChange.current) {
        return;
      }

      if (!allowSelectionScroll.current) {
        return;
      }
      allowSelectionScroll.current = false;
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
        allowSelectionScrollTimer.current = null;
      }

      const path = paths.at(-1);
      if (path) {
        onSelectPath(path);
      }
    },
    paths,
    sort: fileTreeSort,
    unsafeCSS: `
      :host {
        --trees-padding-inline-override: 4px;
        color: var(--sidebar-text);
        font: 13px/1.35 var(--font-sans);
      }

      button[data-type='item'] {
        border-radius: 14px;
        corner-shape: squircle;
      }
    `,
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(status);
  }, [model, paths, status]);

  const scrollPathIntoView = useCallback(
    (path: string) => {
      model.focusPath(path);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const host = treeHostRef.current?.querySelector('file-tree-container');
          const row = Array.from(
            host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-item-path]') ?? [],
          ).find((element) => element.getAttribute('data-item-path') === path);
          row?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
          });
        });
      });
    },
    [model],
  );

  const handleTreeClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      for (const target of event.nativeEvent.composedPath()) {
        if (!('getAttribute' in target) || typeof target.getAttribute !== 'function') {
          continue;
        }

        const path = target.getAttribute('data-item-path');
        if (path && filePathSet.has(path)) {
          onActivatePath(path);
          return;
        }
      }
    },
    [filePathSet, onActivatePath],
  );

  useEffect(
    () => () => {
      if (allowSelectionScrollTimer.current != null) {
        window.clearTimeout(allowSelectionScrollTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !isNativeInputTarget(event.target) &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      return;
    }

    const selectedPaths = model.getSelectedPaths();
    if (selectedPaths.length === 1 && selectedPaths[0] === selectedPath) {
      return;
    }

    suppressSelectionChange.current = true;
    for (const path of selectedPaths) {
      model.getItem(path)?.deselect();
    }
    model.getItem(selectedPath)?.select();
    requestAnimationFrame(() => scrollPathIntoView(selectedPath));
    window.setTimeout(() => {
      suppressSelectionChange.current = false;
    }, 0);
  }, [model, scrollPathIntoView, selectedPath]);

  return (
    <>
      <div className="sidebar-search-row">
        <input
          aria-label="Filter changed files"
          className="sidebar-search"
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          placeholder={mode === 'history' ? 'Filter history' : 'Filter files'}
          ref={searchInputRef}
          spellCheck={false}
          type="search"
          value={searchQuery}
        />
      </div>
      <div aria-label="Review order" className="sidebar-mode-toggle" role="tablist">
        <button
          aria-selected={mode === 'tree'}
          onClick={() => onModeChange('tree')}
          role="tab"
          type="button"
        >
          Tree
        </button>
        <button
          aria-selected={mode === 'walkthrough'}
          onClick={() => onModeChange('walkthrough')}
          role="tab"
          type="button"
        >
          <span>Walkthrough</span>
          {walkthroughUnread ? <span aria-hidden className="sidebar-tab-dot" /> : null}
        </button>
        <button
          aria-selected={mode === 'history'}
          onClick={() => onModeChange('history')}
          role="tab"
          type="button"
        >
          History
        </button>
      </div>
      {mode === 'history' ? (
        <HistorySidebar
          currentSource={currentSource}
          entries={historyEntries}
          hasMore={historyHasMore}
          loading={historyLoading}
          onLoadMore={onLoadMoreHistory}
          onSelectSource={onSelectSource}
          searchQuery={searchQuery}
        />
      ) : mode === 'walkthrough' && walkthroughAvailable ? (
        <WalkthroughSidebar
          files={files}
          onActivatePath={onActivatePath}
          selectedPath={selectedPath}
          walkthroughNotes={walkthroughNotes}
          walkthroughSummary={walkthroughSummary}
        />
      ) : mode === 'walkthrough' ? (
        <>
          {walkthroughLoading ? (
            <div className="sidebar-walkthrough-status-shell">
              <div className="sidebar-walkthrough-status codex">
                <strong>Waiting on Codex…</strong>
              </div>
            </div>
          ) : walkthroughError ? (
            <div className="sidebar-walkthrough-status" title={walkthroughError}>
              <strong>Walkthrough unavailable</strong>
              <span>{walkthroughError}</span>
            </div>
          ) : null}
          {!walkthroughLoading ? (
            <div className="file-tree-shell" ref={treeHostRef}>
              <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="file-tree-shell" ref={treeHostRef}>
          <FileTree className="file-tree" model={model} onClick={handleTreeClick} />
        </div>
      )}
    </>
  );
}

function HistorySidebar({
  currentSource,
  entries,
  hasMore,
  loading,
  onLoadMore,
  onSelectSource,
  searchQuery,
}: {
  currentSource: ReviewSource;
  entries: ReadonlyArray<HistoryEntry>;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onSelectSource: (source: ReviewSource) => void;
  searchQuery: string;
}) {
  const currentSourceKey = getSourceKey(currentSource);
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => [
      {
        committedAt: null,
        key: 'working-tree',
        ref: '',
        source: { type: 'working-tree' } satisfies ReviewSource,
        subject: 'Uncommitted',
      },
      ...entries.map((entry) => ({
        committedAt: entry.committedAt,
        key: `commit:${entry.ref}`,
        ref: entry.ref,
        source: { ref: entry.ref, type: 'commit' } satisfies ReviewSource,
        subject: entry.subject,
      })),
    ],
    [entries],
  );
  const visibleRows = useMemo(
    () =>
      normalizedQuery
        ? rows.filter(
            (row) =>
              row.subject.toLowerCase().includes(normalizedQuery) ||
              row.ref.toLowerCase().includes(normalizedQuery),
          )
        : rows,
    [normalizedQuery, rows],
  );
  const maybeLoadMore = useCallback(() => {
    const element = listRef.current;
    if (!element || loading || !hasMore || normalizedQuery) {
      return;
    }

    if (element.scrollHeight - element.scrollTop - element.clientHeight < 120) {
      onLoadMore();
    }
  }, [hasMore, loading, normalizedQuery, onLoadMore]);

  return (
    <div className="history-list" onScroll={maybeLoadMore} ref={listRef}>
      {visibleRows.map((row) => {
        const selected = row.key === currentSourceKey;
        return (
          <button
            className={`history-entry${selected ? ' selected' : ''}`}
            key={row.key}
            onClick={() => onSelectSource(row.source)}
            title={row.subject}
            type="button"
          >
            <span className="history-entry-ref">
              {row.source.type === 'commit' ? getShortRef(row.source.ref) : 'local'}
            </span>
            <span className="history-entry-subject">{row.subject}</span>
          </button>
        );
      })}
      {loading ? (
        <div className="history-loading">
          <span>Loading history…</span>
        </div>
      ) : null}
    </div>
  );
}

function WalkthroughSidebar({
  files,
  onActivatePath,
  selectedPath,
  walkthroughNotes,
  walkthroughSummary,
}: {
  files: ReadonlyArray<ChangedFile>;
  onActivatePath: (path: string) => void;
  selectedPath: string | null;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
  walkthroughSummary: Walkthrough['summary'] | null;
}) {
  const groups = useMemo(() => {
    const nextGroups: Array<{
      files: Array<{ file: ChangedFile; note?: WalkthroughNote }>;
      key: string;
      reason: string;
      title: string;
    }> = [];
    const groupsByTitle = new Map<string, (typeof nextGroups)[number]>();

    for (const file of files) {
      const note = walkthroughNotes.get(file.path);
      const title = note?.groupTitle ?? 'Other changed files';
      const reason = note?.groupReason ?? 'Review after the primary walkthrough.';
      const key = `${title}:${reason}`;
      let group = groupsByTitle.get(key);

      if (!group) {
        group = {
          files: [],
          key,
          reason,
          title,
        };
        groupsByTitle.set(key, group);
        nextGroups.push(group);
      }

      group.files.push({ file, note });
    }

    return nextGroups;
  }, [files, walkthroughNotes]);

  return (
    <div className="walkthrough-list">
      {walkthroughSummary ? (
        <div className="walkthrough-summary">
          <strong>Review Focus</strong>
          <span>{renderInlineMarkdown(walkthroughSummary.focus)}</span>
          <span>{renderInlineMarkdown(walkthroughSummary.skim)}</span>
        </div>
      ) : null}
      {groups.map((group) => (
        <section className="walkthrough-group" key={group.key}>
          <div className="walkthrough-group-header" title={`${group.title}. ${group.reason}`}>
            <span>{group.title}</span>
            <small>{renderInlineMarkdown(group.reason)}</small>
          </div>
          {group.files.map(({ file, note }) => (
            <button
              className={`walkthrough-file${selectedPath === file.path ? ' selected' : ''}`}
              key={file.path}
              onClick={() => onActivatePath(file.path)}
              title={note?.reason ?? file.path}
              type="button"
            >
              <span className="walkthrough-file-path">{file.path}</span>
              {note ? (
                <span className="walkthrough-file-meta">
                  {walkthroughImpactLabel[note.impact]} · {walkthroughActionLabel[note.action]}
                </span>
              ) : null}
              <span className="walkthrough-file-reason">
                {renderInlineMarkdown(note?.context ?? note?.reason ?? 'Review this changed file.')}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function CodeViewHeader({
  meta,
  onOpenFile,
  onToggleCollapsed,
  onToggleViewed,
}: {
  meta: CodeViewItemMetadata;
  onOpenFile: (file: ChangedFile) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
}) {
  const { file, isCollapsed, isSelected, isViewed, section, sectionCount, walkthroughNote } = meta;
  const canOpenFile = file.status !== 'deleted';

  return (
    <div
      className={`codiff-file-header${walkthroughNote ? ' with-note' : ''}${
        isCollapsed ? ' collapsed' : ''
      }${isSelected ? ' selected' : ''}${isViewed ? ' viewed' : ''}`}
    >
      <button
        aria-expanded={!isCollapsed}
        aria-label={isCollapsed ? 'Expand file' : 'Collapse file'}
        className="codiff-header-toggle"
        onClick={() => onToggleCollapsed(file, isCollapsed)}
        title={isCollapsed ? 'Expand' : 'Collapse'}
        type="button"
      >
        <span className="codiff-chevron-box">
          <span className={isCollapsed ? 'codiff-chevron collapsed' : 'codiff-chevron'} />
        </span>
        <span className="codiff-file-heading">
          <span className="codiff-file-path">{file.path}</span>
          {file.oldPath ? <span className="codiff-file-old-path">{file.oldPath}</span> : null}
          {walkthroughNote ? (
            <span className="codiff-file-note">{walkthroughNote.reason}</span>
          ) : null}
        </span>
        {sectionCount > 1 ? (
          <span className={`codiff-section-badge ${section.kind}`}>
            {sectionLabel[section.kind]}
          </span>
        ) : null}
      </button>
      <div className={`codiff-status-badge ${file.status}`}>{statusLabel[file.status]}</div>
      <button
        className="codiff-open-button"
        disabled={!canOpenFile}
        onClick={() => onOpenFile(file)}
        title={canOpenFile ? 'Open file in editor' : 'Deleted files cannot be opened'}
        type="button"
      >
        Open
      </button>
      <button
        aria-pressed={isViewed}
        className={`codiff-viewed-button${isViewed ? ' active' : ''}`}
        onClick={() => onToggleViewed(file, isViewed)}
        type="button"
      >
        <span aria-hidden className="codiff-viewed-checkbox" />
        Viewed
      </button>
    </div>
  );
}

function ReviewAvatar({ identity }: { identity: GitIdentity | null }) {
  const label = identity?.name || identity?.email || 'Git user';

  return identity?.gravatarUrl ? (
    <img alt="" className="review-comment-avatar" draggable={false} src={identity.gravatarUrl} />
  ) : (
    <span aria-hidden className="review-comment-avatar fallback">
      {label.trim()[0]?.toUpperCase() ?? '?'}
    </span>
  );
}

function CodexAvatar() {
  return (
    <img alt="" className="review-comment-avatar codex" draggable={false} src={codexIconUrl} />
  );
}

const canAskCodexForComment = (comment: ReviewComment) =>
  comment.body.trim().length > 0 && comment.codexReply?.status !== 'loading';

function ReviewAnnotation({
  annotation,
  comments,
  focusCommentId,
  focusCommentRequest,
  identity,
  onAskCodex,
  onDeleteComment,
  onUpdateComment,
}: {
  annotation: DiffLineAnnotation<ReviewAnnotationMetadata>;
  comments: ReadonlyArray<ReviewComment>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  identity: GitIdentity | null;
  onAskCodex: (commentId: string) => void;
  onDeleteComment: (commentId: string) => void;
  onUpdateComment: (commentId: string, body: string) => void;
}) {
  const focusTextareaRef = useRef<HTMLTextAreaElement>(null);
  const annotationComments = annotation.metadata.commentIds
    .map((commentId) => comments.find((comment) => comment.id === commentId))
    .filter((comment): comment is ReviewComment => comment != null);
  const hasFocusedComment =
    focusCommentId != null && annotationComments.some((comment) => comment.id === focusCommentId);

  useEffect(() => {
    if (hasFocusedComment) {
      focusTextareaRef.current?.focus();
    }
  }, [focusCommentId, focusCommentRequest, hasFocusedComment]);

  const handleCommentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>, comment: ReviewComment) => {
      if (
        event.key === 'Enter' &&
        event.metaKey &&
        !event.shiftKey &&
        canAskCodexForComment(comment)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onAskCodex(comment.id);
        return;
      }

      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (shouldDiscardReviewCommentOnEscape(comment.body)) {
        onDeleteComment(comment.id);
      }
    },
    [onAskCodex, onDeleteComment],
  );

  if (annotationComments.length === 0) {
    return null;
  }

  return (
    <div className="review-comment-thread">
      {annotationComments.map((comment) => {
        const canAskCodex = canAskCodexForComment(comment);

        return (
          <Fragment key={comment.id}>
            <div className="review-comment">
              <ReviewAvatar identity={identity} />
              <div className="review-comment-body">
                <div className="review-comment-header">
                  <strong>{identity?.name || identity?.email || 'Git user'}</strong>
                  <span>
                    {comment.side === 'additions' ? 'New' : 'Old'} line {comment.lineNumber}
                  </span>
                  <button
                    className="review-comment-ask"
                    disabled={!canAskCodex}
                    onClick={() => onAskCodex(comment.id)}
                    title={canAskCodex ? 'Ask Codex' : 'Write a note before asking Codex'}
                    type="button"
                  >
                    Ask
                  </button>
                  <button
                    aria-label="Delete comment"
                    className="review-comment-delete"
                    onClick={() => onDeleteComment(comment.id)}
                    title="Delete comment"
                    type="button"
                  >
                    <span aria-hidden className="review-comment-delete-icon" />
                  </button>
                </div>
                <textarea
                  aria-label={`Comment on ${comment.filePath} line ${comment.lineNumber}`}
                  className="review-comment-input"
                  onChange={(event) => onUpdateComment(comment.id, event.currentTarget.value)}
                  onKeyDown={(event) => handleCommentKeyDown(event, comment)}
                  placeholder="Write a review comment…"
                  ref={comment.id === focusCommentId ? focusTextareaRef : undefined}
                  rows={3}
                  spellCheck
                  value={comment.body}
                />
              </div>
            </div>
            {comment.codexReply ? (
              <div className="review-comment codex">
                <CodexAvatar />
                <div className="review-comment-body codex">
                  <div className="review-comment-header codex">
                    <strong>Codex</strong>
                  </div>
                  <div
                    className={`review-comment-codex-reply${
                      comment.codexReply.status === 'loading' ? ' is-loading' : ''
                    }${comment.codexReply.status === 'error' ? ' error' : ''}`}
                  >
                    {comment.codexReply.status === 'loading' ? (
                      <span className="review-comment-codex-loading">Waiting for Codex…</span>
                    ) : (
                      renderMarkdown(comment.codexReply.body ?? comment.codexReply.error ?? '')
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function ReviewCodeView({
  activeSearchMatch,
  collapsed,
  comments,
  files,
  focusCommentId,
  focusCommentRequest,
  forceExpandedPaths,
  gitIdentity,
  itemVersionByPath,
  onAskCodex,
  onCreateComment,
  onDeleteComment,
  onOpenFile,
  onSelectPathFromScroll,
  onToggleCollapsed,
  onToggleViewed,
  onUpdateComment,
  scrollTarget,
  searchQuery,
  selectedPath,
  showWhitespace,
  viewed,
  walkthroughNotes,
}: {
  activeSearchMatch: DiffSearchMatch | null;
  collapsed: ReadonlySet<string>;
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  focusCommentId: string | null;
  focusCommentRequest: number;
  forceExpandedPaths: ReadonlySet<string>;
  gitIdentity: GitIdentity | null;
  itemVersionByPath: Readonly<Record<string, number>>;
  onAskCodex: (commentId: string) => void;
  onCreateComment: (comment: Omit<ReviewComment, 'body' | 'id'>) => void;
  onDeleteComment: (commentId: string) => void;
  onOpenFile: (file: ChangedFile) => void;
  onSelectPathFromScroll: (viewer: CodeViewInstance) => void;
  onToggleCollapsed: (file: ChangedFile, isCollapsed: boolean) => void;
  onToggleViewed: (file: ChangedFile, isViewed: boolean) => void;
  onUpdateComment: (commentId: string, body: string) => void;
  scrollTarget: { path: string; request: number } | null;
  searchQuery: string;
  selectedPath: string | null;
  showWhitespace: boolean;
  viewed: Record<string, string>;
  walkthroughNotes: ReadonlyMap<string, WalkthroughNote>;
}) {
  const codeViewRef = useRef<CodeViewHandle<ReviewAnnotationMetadata>>(null);
  const handledScrollRequestRef = useRef<number | null>(null);
  const highlightFrameRef = useRef<number | null>(null);
  const commentsBySection = useMemo(() => {
    const map = new Map<string, Array<ReviewComment>>();
    for (const comment of comments) {
      const list = map.get(comment.sectionId) ?? [];
      list.push(comment);
      map.set(comment.sectionId, list);
    }
    return map;
  }, [comments]);

  const { firstItemByPath, itemMetadata, items } = useMemo(() => {
    const nextItems: Array<CodeViewItem<ReviewAnnotationMetadata>> = [];
    const nextFirstItemByPath = new Map<string, string>();
    const nextItemMetadata = new Map<string, CodeViewItemMetadata>();

    for (const file of files) {
      const isViewed = viewed[file.path] === file.fingerprint;
      const isCollapsed = collapsed.has(file.path) && !forceExpandedPaths.has(file.path);
      const visibleSections = getVisibleDiffSections(file, showWhitespace);
      const sections = isCollapsed ? visibleSections.slice(0, 1) : visibleSections;

      for (const [index, { fileDiff, section }] of sections.entries()) {
        const id = getItemId(section);
        const annotationMap = new Map<string, DiffLineAnnotation<ReviewAnnotationMetadata>>();
        for (const comment of commentsBySection.get(section.id) ?? []) {
          const key = getCommentKey(comment);
          const existing = annotationMap.get(key);
          if (existing) {
            annotationMap.set(key, {
              ...existing,
              metadata: {
                commentIds: [...existing.metadata.commentIds, comment.id],
              },
            });
          } else {
            annotationMap.set(key, {
              lineNumber: comment.lineNumber,
              metadata: {
                commentIds: [comment.id],
              },
              side: comment.side,
            });
          }
        }

        nextItemMetadata.set(id, {
          file,
          isCollapsed,
          isSelected: selectedPath === file.path,
          isViewed,
          section,
          sectionCount: file.sections.length,
          walkthroughNote: walkthroughNotes.get(file.path),
        });
        nextFirstItemByPath.set(file.path, nextFirstItemByPath.get(file.path) ?? id);
        nextItems.push({
          annotations: [...annotationMap.values()],
          collapsed: isCollapsed,
          fileDiff,
          id,
          type: 'diff',
          version: getItemVersion(
            `${itemVersionByPath[file.path] ?? 0}:${file.fingerprint}:${section.id}:${
              isCollapsed ? 'collapsed' : 'open'
            }:${isViewed ? 'viewed' : 'pending'}:${index}:${
              selectedPath === file.path ? 'selected' : 'idle'
            }:${walkthroughNotes.get(file.path)?.reason ?? ''}:${
              showWhitespace ? 'ws' : 'ignore-ws'
            }:${getReviewCommentsDigest(commentsBySection.get(section.id) ?? [])}`,
          ),
        });
      }
    }

    return {
      firstItemByPath: nextFirstItemByPath,
      itemMetadata: nextItemMetadata,
      items: nextItems,
    };
  }, [
    collapsed,
    commentsBySection,
    files,
    forceExpandedPaths,
    itemVersionByPath,
    selectedPath,
    showWhitespace,
    viewed,
    walkthroughNotes,
  ]);

  const codeViewOptions: CodeViewOptions<ReviewAnnotationMetadata> = useMemo(
    () =>
      ({
        collapsedContextThreshold: diffCollapsedContextThreshold,
        diffIndicators: 'bars',
        diffStyle: 'split',
        enableGutterUtility: true,
        enableLineSelection: false,
        expandUnchanged: false,
        expansionLineCount: diffContextExpansionLineCount,
        hunkSeparators: 'line-info-basic',
        itemMetrics:
          walkthroughNotes.size > 0 ? codeViewItemMetricsWithWalkthrough : codeViewItemMetrics,
        layout: codeViewLayout,
        lineDiffType: 'char',
        onGutterUtilityClick: (range, context) => {
          const meta = itemMetadata.get(context.item.id);
          if (!meta || meta.isCollapsed) {
            return;
          }
          const side = range.side ?? range.endSide ?? 'additions';
          onCreateComment({
            filePath: meta.file.path,
            lineNumber: range.start,
            sectionId: meta.section.id,
            side,
          });
        },
        onLineClick: (line, context) => {
          if (line.type !== 'diff-line') {
            return;
          }
          const meta = itemMetadata.get(context.item.id);
          if (!meta || meta.isCollapsed) {
            return;
          }
          onCreateComment({
            filePath: meta.file.path,
            lineNumber: line.lineNumber,
            sectionId: meta.section.id,
            side: line.annotationSide,
          });
        },
        stickyHeaders: true,
        theme: {
          dark: 'Dunkel',
          light: 'Licht',
        },
        themeType: 'system',
        tokenizeMaxLength: 100_000,
        unsafeCSS: codeViewUnsafeCSS,
      }) satisfies CodeViewOptions<ReviewAnnotationMetadata>,
    [itemMetadata, onCreateComment, walkthroughNotes.size],
  );

  const workerPoolOptions = useMemo(
    () => ({
      poolSize: Math.min(
        maxWorkerThreads,
        Math.max(1, navigator.hardwareConcurrency || maxWorkerThreads),
      ),
      workerFactory: () =>
        new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), {
          type: 'module',
        }),
    }),
    [],
  );

  const scrollItemHeaderIntoView = useCallback((itemId: string) => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || viewer.getTopForItem(itemId) == null) {
      return false;
    }

    handle.scrollTo({
      behavior: 'instant',
      id: itemId,
      offset: DEFAULT_PADDING,
      type: 'item',
    });

    return true;
  }, []);

  useEffect(() => {
    if (!scrollTarget || handledScrollRequestRef.current === scrollTarget.request) {
      return;
    }

    let frame: number | null = null;
    let attempts = 0;
    let canceled = false;

    const tryScroll = () => {
      if (canceled || handledScrollRequestRef.current === scrollTarget.request) {
        return;
      }

      const itemId = firstItemByPath.get(scrollTarget.path);
      if (itemId && scrollItemHeaderIntoView(itemId)) {
        handledScrollRequestRef.current = scrollTarget.request;
        return;
      }

      if (attempts < 6) {
        attempts += 1;
        frame = window.requestAnimationFrame(tryScroll);
      }
    };

    tryScroll();

    return () => {
      canceled = true;
      if (frame != null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [firstItemByPath, scrollItemHeaderIntoView, scrollTarget]);

  const scheduleSearchHighlights = useCallback(() => {
    const viewer = codeViewRef.current?.getInstance();
    if (!viewer) {
      return;
    }

    if (highlightFrameRef.current != null) {
      window.cancelAnimationFrame(highlightFrameRef.current);
    }

    highlightFrameRef.current = window.requestAnimationFrame(() => {
      highlightFrameRef.current = null;
      applySearchHighlights(viewer.getRenderedItems(), searchQuery, activeSearchMatch);
    });
  }, [activeSearchMatch, searchQuery]);

  useEffect(
    () => () => {
      if (highlightFrameRef.current != null) {
        window.cancelAnimationFrame(highlightFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    scheduleSearchHighlights();
  }, [items, scheduleSearchHighlights]);

  useEffect(() => {
    const handle = codeViewRef.current;
    const viewer = handle?.getInstance();
    if (!handle || !viewer || !activeSearchMatch) {
      return;
    }

    if (activeSearchMatch.lineNumber == null) {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: activeSearchMatch.itemId,
        type: 'item',
      });
    } else {
      handle.scrollTo({
        align: 'center',
        behavior: 'smooth-auto',
        id: activeSearchMatch.itemId,
        lineNumber: activeSearchMatch.lineNumber,
        offset: DEFAULT_PADDING,
        side: activeSearchMatch.side,
        type: 'line',
      });
    }

    scheduleSearchHighlights();
  }, [activeSearchMatch, scheduleSearchHighlights]);

  const renderCustomHeader = useCallback(
    (item: CodeViewItem<ReviewAnnotationMetadata>) => {
      const meta = itemMetadata.get(item.id);
      return meta ? (
        <CodeViewHeader
          meta={meta}
          onOpenFile={onOpenFile}
          onToggleCollapsed={onToggleCollapsed}
          onToggleViewed={onToggleViewed}
        />
      ) : null;
    },
    [itemMetadata, onOpenFile, onToggleCollapsed, onToggleViewed],
  );

  const renderAnnotation = useCallback(
    (
      annotation: DiffLineAnnotation<ReviewAnnotationMetadata>,
      item: CodeViewItem<ReviewAnnotationMetadata>,
    ) =>
      item.type === 'diff' ? (
        <ReviewAnnotation
          annotation={annotation}
          comments={comments}
          focusCommentId={focusCommentId}
          focusCommentRequest={focusCommentRequest}
          identity={gitIdentity}
          onAskCodex={onAskCodex}
          onDeleteComment={onDeleteComment}
          onUpdateComment={onUpdateComment}
        />
      ) : null,
    [
      comments,
      focusCommentId,
      focusCommentRequest,
      gitIdentity,
      onAskCodex,
      onDeleteComment,
      onUpdateComment,
    ],
  );

  const handleScroll = useCallback(
    (_scrollTop: number, viewer: CodeViewInstance) => {
      onSelectPathFromScroll(viewer);
      scheduleSearchHighlights();
    },
    [onSelectPathFromScroll, scheduleSearchHighlights],
  );

  return (
    <WorkerPoolContextProvider
      highlighterOptions={workerHighlighterOptions}
      poolOptions={workerPoolOptions}
    >
      <CodeView
        className="code-view"
        items={items}
        onScroll={handleScroll}
        options={codeViewOptions}
        ref={codeViewRef}
        renderAnnotation={renderAnnotation}
        renderCustomHeader={renderCustomHeader}
      />
    </WorkerPoolContextProvider>
  );
}

function RepositoryChangeBanner({ visible }: { visible: boolean }) {
  return (
    <div aria-live="polite" className={`repository-change-banner${visible ? ' visible' : ''}`}>
      <span>Local changes detected,</span>
      <button onClick={() => window.location.reload()} type="button">
        {getReloadShortcutLabel()} to reload.
      </button>
    </div>
  );
}

function DiffSearchPanel({
  activeIndex,
  focusRequest,
  matchCount,
  onChange,
  onClose,
  onNext,
  onPrevious,
  query,
  visible,
}: {
  activeIndex: number;
  focusRequest: number;
  matchCount: number;
  onChange: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  query: string;
  visible: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }

    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [focusRequest, visible]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          onPrevious();
        } else {
          onNext();
        }
      }
    },
    [onClose, onNext, onPrevious],
  );

  return (
    <div className={`diff-search-panel${visible ? ' visible' : ''}`}>
      <input
        aria-label="Search diffs"
        className="diff-search-input"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in diffs"
        ref={inputRef}
        spellCheck={false}
        type="search"
        value={query}
      />
      <span className="diff-search-count">
        {query.trim() ? (matchCount > 0 ? `${activeIndex + 1}/${matchCount}` : '0/0') : ''}
      </span>
      <button
        aria-label="Previous match"
        disabled={matchCount === 0}
        onClick={onPrevious}
        title="Previous match"
        type="button"
      >
        <span aria-hidden className="diff-search-chevron up" />
      </button>
      <button
        aria-label="Next match"
        disabled={matchCount === 0}
        onClick={onNext}
        title="Next match"
        type="button"
      >
        <span aria-hidden className="diff-search-chevron down" />
      </button>
      <button aria-label="Close search" onClick={onClose} title="Close" type="button">
        <span aria-hidden className="diff-search-close-icon" />
      </button>
    </div>
  );
}

function CopyCommentsButton({
  comments,
  files,
  showWhitespace,
}: {
  comments: ReadonlyArray<ReviewComment>;
  files: ReadonlyArray<ChangedFile>;
  showWhitespace: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const pendingCommentCount = comments.filter((comment) => comment.body.trim()).length;

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const copyComments = useCallback(async () => {
    const markdown = buildReviewCommentsMarkdown(files, comments, showWhitespace);
    if (!markdown) {
      return;
    }

    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    if (copiedTimerRef.current != null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
  }, [comments, files, showWhitespace]);

  if (pendingCommentCount === 0) {
    return null;
  }

  return (
    <button
      aria-label={`Copy ${pendingCommentCount} review ${
        pendingCommentCount === 1 ? 'comment' : 'comments'
      }`}
      className={`copy-comments-button${copied ? ' copied' : ''}`}
      onClick={() => void copyComments()}
      title="Copy review comments"
      type="button"
    >
      <span aria-hidden className={copied ? 'copy-comments-icon check' : 'copy-comments-icon'} />
    </button>
  );
}

export default function App() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [activeDiffSearchMatchIndex, setActiveDiffSearchMatchIndex] = useState(0);
  const [diffSearchFocusRequest, setDiffSearchFocusRequest] = useState(0);
  const [diffSearchQuery, setDiffSearchQuery] = useState('');
  const [diffSearchVisible, setDiffSearchVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusCommentId, setFocusCommentId] = useState<string | null>(null);
  const [focusCommentRequest, setFocusCommentRequest] = useState(0);
  const [gitIdentity, setGitIdentity] = useState<GitIdentity | null>(null);
  const [historyEntries, setHistoryEntries] = useState<ReadonlyArray<HistoryEntry>>([]);
  const [historyHasMore, setHistoryHasMore] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [itemVersionByPath, setItemVersionByPath] = useState<Record<string, number>>({});
  const [localChangesDetected, setLocalChangesDetected] = useState(false);
  const [launchOptions, setLaunchOptions] = useState<CodiffLaunchOptions>({ walkthrough: false });
  const [preferences, setPreferences] = useState<CodiffPreferences>(defaultPreferences);
  const [reviewComments, setReviewComments] = useState<ReadonlyArray<ReviewComment>>([]);
  const [scrollTarget, setScrollTarget] = useState<{ path: string; request: number } | null>(null);
  const [fileSearchQuery, setFileSearchQuery] = useState('');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [pendingSource, setPendingSource] = useState<ReviewSource | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('tree');
  const [state, setState] = useState<RepositoryState | null>(null);
  const [viewed, setViewed] = useState<Record<string, string>>({});
  const [walkthrough, setWalkthrough] = useState<Walkthrough | null>(null);
  const [walkthroughError, setWalkthroughError] = useState<string | null>(null);
  const [walkthroughLoading, setWalkthroughLoading] = useState(false);
  const [walkthroughUnread, setWalkthroughUnread] = useState(false);
  const historyRequestRef = useRef(0);
  const loadingSectionKeysRef = useRef<Set<string>>(new Set());
  const programmaticScrollPathRef = useRef<string | null>(null);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const sourceSessionsRef = useRef<Map<string, SourceSession>>(new Map());
  const stateRef = useRef<RepositoryState | null>(null);
  const collapsedRef = useRef<Set<string>>(new Set());
  const reviewCommentsRef = useRef<ReadonlyArray<ReviewComment>>([]);
  const selectedPathRef = useRef<string | null>(null);
  const sidebarModeRef = useRef<SidebarMode>('tree');
  const sourceRequestRef = useRef(0);
  const viewedRef = useRef<Record<string, string>>({});
  const walkthroughRef = useRef<Walkthrough | null>(null);
  const walkthroughErrorRef = useRef<string | null>(null);

  const bumpItemVersion = useCallback((path: string) => {
    setItemVersionByPath((current) => ({
      ...current,
      [path]: (current[path] ?? 0) + 1,
    }));
  }, []);

  const saveCurrentSourceSession = useCallback(() => {
    const currentState = stateRef.current;
    if (!currentState) {
      return;
    }

    sourceSessionsRef.current.set(getSourceKey(currentState.source), {
      collapsed: new Set(collapsedRef.current),
      reviewComments: reviewCommentsRef.current,
      selectedPath: selectedPathRef.current,
      viewed: viewedRef.current,
      walkthrough: walkthroughRef.current,
      walkthroughError: walkthroughErrorRef.current,
    });
  }, []);

  useEffect(() => {
    let canceled = false;

    const load = async () => {
      const nextLaunchOptions = await window.codiff.getLaunchOptions();
      if (canceled) {
        return;
      }

      const [nextState, history] = await Promise.all([
        window.codiff.getRepositoryState(),
        window.codiff.getRepositoryHistory(HISTORY_PAGE_SIZE),
      ]);

      if (canceled) {
        return;
      }

      const orderedState = {
        ...nextState,
        files: sortFiles(nextState.files),
      };
      const shouldLoadWalkthrough = nextLaunchOptions.walkthrough && orderedState.files.length > 0;
      const shouldStartInHistory =
        orderedState.source.type === 'working-tree' && orderedState.files.length === 0;

      setLaunchOptions({
        ...nextLaunchOptions,
        walkthrough: shouldLoadWalkthrough,
      });
      setSidebarMode(
        shouldLoadWalkthrough ? 'walkthrough' : shouldStartInHistory ? 'history' : 'tree',
      );
      setWalkthroughLoading(shouldLoadWalkthrough);

      const walkthroughResult = shouldLoadWalkthrough
        ? await window.codiff.getWalkthrough(orderedState.source)
        : null;

      if (canceled) {
        return;
      }

      const nextWalkthrough =
        walkthroughResult?.status === 'ready' ? walkthroughResult.walkthrough : null;

      if (walkthroughResult?.status === 'unavailable') {
        setWalkthroughError(walkthroughResult.reason);
        setSidebarMode('tree');
      } else {
        setWalkthroughError(null);
      }

      setWalkthrough(nextWalkthrough);
      setWalkthroughLoading(false);

      const nextViewed =
        orderedState.source.type === 'working-tree' ? readViewed(orderedState.root) : {};
      const initialFiles = nextLaunchOptions.walkthrough
        ? orderFilesByWalkthrough(orderedState.files, nextWalkthrough)
        : orderedState.files;

      setHistoryEntries(history.entries);
      setHistoryHasMore(history.entries.length >= HISTORY_PAGE_SIZE);
      setHistoryLimit(HISTORY_PAGE_SIZE);
      setState(orderedState);
      setError(null);
      setCollapsed(
        new Set(
          orderedState.files
            .filter((file) => nextViewed[file.path] === file.fingerprint)
            .map((file) => file.path),
        ),
      );
      setItemVersionByPath({});
      setFocusCommentId(null);
      setFocusCommentRequest(0);
      setReviewComments([]);
      setViewed(nextViewed);
      setSelectedPath((current) => current ?? initialFiles[0]?.path ?? null);
    };

    load().catch((error: unknown) => {
      if (canceled) {
        return;
      }

      setError(error instanceof Error ? error.message : String(error));
      setWalkthroughLoading(false);
    });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(
    () =>
      window.codiff.onRepositoryChanged(() => {
        setLocalChangesDetected(true);
      }),
    [],
  );

  useEffect(() => {
    let canceled = false;

    window.codiff
      .getGitIdentity()
      .then((identity) => {
        if (!canceled) {
          setGitIdentity(identity);
        }
      })
      .catch(() => {
        if (!canceled) {
          setGitIdentity(null);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!state || state.source.type !== 'working-tree' || !selectedPath) {
      return;
    }

    const selectedFile = state.files.find((file) => file.path === selectedPath);
    if (!selectedFile) {
      return;
    }

    const deferredSections = selectedFile.sections.filter(
      (section) => section.loadState === 'deferred' && section.summary?.canLoad !== false,
    );

    if (!deferredSections.length) {
      return;
    }

    let canceled = false;
    const sourceKey = getSourceKey(state.source);

    for (const section of deferredSections) {
      const key = `${state.root}:${section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        continue;
      }

      loadingSectionKeysRef.current.add(key);
      window.codiff
        .getDiffSectionContent({
          force: true,
          kind: section.kind,
          path: selectedFile.path,
          source: state.source,
        })
        .then((loadedSection) => {
          if (canceled) {
            return;
          }

          setState((current) => {
            if (
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === selectedFile.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === section.id ? loadedSection : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(selectedFile.path);
        })
        .catch(() => {
          if (!canceled) {
            setState((current) => {
              if (
                !current ||
                current.root !== state.root ||
                getSourceKey(current.source) !== sourceKey
              ) {
                return current;
              }

              return {
                ...current,
                files: current.files.map((file) =>
                  file.path === selectedFile.path
                    ? {
                        ...file,
                        sections: file.sections.map((candidate) =>
                          candidate.id === section.id
                            ? {
                                ...candidate,
                                loadState: 'error',
                                summary: {
                                  canLoad: false,
                                  reason: 'Codiff could not load this file.',
                                },
                              }
                            : candidate,
                        ),
                      }
                    : file,
                ),
              };
            });
            bumpItemVersion(selectedFile.path);
          }
        })
        .finally(() => {
          loadingSectionKeysRef.current.delete(key);
        });
    }

    return () => {
      canceled = true;
    };
  }, [bumpItemVersion, selectedPath, state]);

  useEffect(() => {
    if (!state || state.source.type !== 'working-tree' || !diffSearchQuery.trim()) {
      return;
    }

    const searchableFiles = sortFiles(state.files).filter(
      (file) =>
        fuzzyMatches(file.path, fileSearchQuery) &&
        fileHasVisibleDiff(file, preferences.showWhitespace),
    );
    const requests = searchableFiles.flatMap((file) =>
      file.sections
        .filter((section) => section.loadState === 'deferred' && section.summary?.canLoad !== false)
        .map((section) => ({
          file,
          section,
        })),
    );

    if (!requests.length) {
      return;
    }

    let canceled = false;
    let cursor = 0;
    const sourceKey = getSourceKey(state.source);

    const loadNext = async (): Promise<void> => {
      if (canceled) {
        return;
      }

      const request = requests[cursor];
      cursor += 1;
      if (!request) {
        return;
      }

      const key = `${state.root}:${request.section.id}`;
      if (loadingSectionKeysRef.current.has(key)) {
        return loadNext();
      }

      loadingSectionKeysRef.current.add(key);

      try {
        const loadedSection = await window.codiff.getDiffSectionContent({
          force: true,
          kind: request.section.kind,
          path: request.file.path,
          source: state.source,
        });

        if (!canceled) {
          setState((current) => {
            if (
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === request.file.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === request.section.id ? loadedSection : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(request.file.path);
        }
      } catch {
        if (!canceled) {
          setState((current) => {
            if (
              !current ||
              current.root !== state.root ||
              getSourceKey(current.source) !== sourceKey
            ) {
              return current;
            }

            return {
              ...current,
              files: current.files.map((file) =>
                file.path === request.file.path
                  ? {
                      ...file,
                      sections: file.sections.map((candidate) =>
                        candidate.id === request.section.id
                          ? {
                              ...candidate,
                              loadState: 'error',
                              summary: {
                                canLoad: false,
                                reason: 'Codiff could not load this file.',
                              },
                            }
                          : candidate,
                      ),
                    }
                  : file,
              ),
            };
          });
          bumpItemVersion(request.file.path);
        }
      } finally {
        loadingSectionKeysRef.current.delete(key);
      }

      return loadNext();
    };

    void Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => loadNext()));

    return () => {
      canceled = true;
    };
  }, [bumpItemVersion, diffSearchQuery, fileSearchQuery, preferences.showWhitespace, state]);

  useEffect(() => {
    let canceled = false;

    window.codiff.getPreferences().then((nextPreferences) => {
      if (!canceled) {
        setPreferences(nextPreferences);
      }
    });

    const removeListener = window.codiff.onPreferencesChanged((nextPreferences) => {
      setPreferences(nextPreferences);
    });

    return () => {
      canceled = true;
      removeListener();
    };
  }, []);

  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    sidebarModeRef.current = sidebarMode;
  }, [sidebarMode]);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    reviewCommentsRef.current = reviewComments;
  }, [reviewComments]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    viewedRef.current = viewed;
  }, [viewed]);

  useEffect(() => {
    walkthroughRef.current = walkthrough;
  }, [walkthrough]);

  useEffect(() => {
    walkthroughErrorRef.current = walkthroughError;
  }, [walkthroughError]);

  const showWhitespace = preferences.showWhitespace;
  const walkthroughNotes = useMemo(() => getWalkthroughNotes(walkthrough), [walkthrough]);
  const orderedFiles = useMemo(
    () =>
      state
        ? sidebarMode === 'walkthrough'
          ? orderFilesByWalkthrough(sortFiles(state.files), walkthrough)
          : sortFiles(state.files)
        : [],
    [sidebarMode, state, walkthrough],
  );
  const fileFilteredFiles = useMemo(
    () =>
      state
        ? orderedFiles.filter(
            (file) =>
              fuzzyMatches(file.path, fileSearchQuery) && fileHasVisibleDiff(file, showWhitespace),
          )
        : [],
    [fileSearchQuery, orderedFiles, showWhitespace, state],
  );

  const diffSearchResults = useMemo(
    () =>
      diffSearchQuery.trim()
        ? fileFilteredFiles
            .map((file) => getDiffSearchResult(file, showWhitespace, diffSearchQuery))
            .filter((result): result is DiffSearchResult => result != null)
        : [],
    [diffSearchQuery, fileFilteredFiles, showWhitespace],
  );

  const diffSearchMatches = useMemo(
    () => diffSearchResults.flatMap((result) => result.matches),
    [diffSearchResults],
  );

  const diffSearchMatchPathSet = useMemo(
    () => new Set(diffSearchResults.map((result) => result.file.path)),
    [diffSearchResults],
  );

  const visibleFiles = useMemo(
    () =>
      diffSearchQuery.trim()
        ? fileFilteredFiles.filter((file) => diffSearchMatchPathSet.has(file.path))
        : fileFilteredFiles,
    [diffSearchMatchPathSet, diffSearchQuery, fileFilteredFiles],
  );

  const effectiveActiveDiffSearchMatchIndex =
    diffSearchMatches.length === 0
      ? 0
      : Math.min(activeDiffSearchMatchIndex, diffSearchMatches.length - 1);
  const activeDiffSearchMatch = diffSearchMatches[effectiveActiveDiffSearchMatchIndex] ?? null;

  const openDiffSearch = useCallback(() => {
    setDiffSearchVisible(true);
    setDiffSearchFocusRequest((current) => current + 1);
  }, []);

  const closeDiffSearch = useCallback(() => {
    setDiffSearchVisible(false);
    setDiffSearchQuery('');
    setActiveDiffSearchMatchIndex(0);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isDiffSearchShortcut(event)) {
        event.preventDefault();
        openDiffSearch();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openDiffSearch]);

  useEffect(() => window.codiff.onFindInDiffs(openDiffSearch), [openDiffSearch]);

  const updateDiffSearchQuery = useCallback((query: string) => {
    setDiffSearchQuery(query);
    setDiffSearchVisible(true);
    setActiveDiffSearchMatchIndex(0);
  }, []);

  const loadMoreHistory = useCallback(() => {
    if (historyLoading || !historyHasMore) {
      return;
    }

    const nextLimit = historyLimit + HISTORY_PAGE_SIZE;
    const request = historyRequestRef.current + 1;
    historyRequestRef.current = request;
    setHistoryLoading(true);
    window.codiff
      .getRepositoryHistory(nextLimit)
      .then((history) => {
        if (historyRequestRef.current !== request) {
          return;
        }

        setHistoryEntries(history.entries);
        setHistoryLimit(nextLimit);
        setHistoryHasMore(history.entries.length >= nextLimit);
      })
      .catch(() => {
        if (historyRequestRef.current === request) {
          setHistoryHasMore(false);
        }
      })
      .finally(() => {
        if (historyRequestRef.current === request) {
          setHistoryLoading(false);
        }
      });
  }, [historyHasMore, historyLimit, historyLoading]);

  const moveDiffSearchMatch = useCallback(
    (direction: 1 | -1) => {
      setDiffSearchVisible(true);
      setActiveDiffSearchMatchIndex((current) => {
        const matchCount = diffSearchMatches.length;
        if (matchCount === 0) {
          return 0;
        }

        return (current + direction + matchCount) % matchCount;
      });
    },
    [diffSearchMatches.length],
  );

  const selectPath = useCallback((path: string) => {
    setSelectedPath(path);
  }, []);

  const activatePath = useCallback((path: string) => {
    setSelectedPath(path);
    setScrollTarget((current) => ({
      path,
      request: (current?.request ?? 0) + 1,
    }));
    programmaticScrollPathRef.current = path;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }

    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollPathRef.current = null;
      programmaticScrollTimerRef.current = null;
    }, 1200);
  }, []);

  const selectSource = useCallback(
    (source: ReviewSource) => {
      const currentState = stateRef.current;
      const sourceKey = getSourceKey(source);
      const currentDisplayKey = getSourceKey(pendingSource ?? currentState?.source ?? source);
      if (currentDisplayKey === sourceKey) {
        return;
      }

      saveCurrentSourceSession();
      const request = sourceRequestRef.current + 1;
      sourceRequestRef.current = request;
      setPendingSource(source);
      setError(null);
      setFocusCommentId(null);
      setFocusCommentRequest(0);
      setDiffSearchQuery('');
      setActiveDiffSearchMatchIndex(0);
      setScrollTarget(null);

      window.codiff
        .getRepositoryState(source)
        .then((nextState) => {
          if (sourceRequestRef.current !== request) {
            return;
          }

          const orderedState = {
            ...nextState,
            files: sortFiles(nextState.files),
          };
          const session = sourceSessionsRef.current.get(getSourceKey(orderedState.source));
          const nextViewed =
            session?.viewed ??
            (orderedState.source.type === 'working-tree' ? readViewed(orderedState.root) : {});
          const nextSelectedPath =
            session?.selectedPath &&
            orderedState.files.some((file) => file.path === session.selectedPath)
              ? session.selectedPath
              : (orderedState.files[0]?.path ?? null);
          const nextCollapsed =
            session?.collapsed ??
            new Set(
              orderedState.files
                .filter((file) => nextViewed[file.path] === file.fingerprint)
                .map((file) => file.path),
            );

          setState(orderedState);
          setCollapsed(new Set(nextCollapsed));
          setItemVersionByPath({});
          setReviewComments(session?.reviewComments ?? []);
          setViewed(nextViewed);
          setSelectedPath(nextSelectedPath);
          setWalkthrough(session?.walkthrough ?? null);
          setWalkthroughError(session?.walkthroughError ?? null);
          setWalkthroughLoading(false);
          setWalkthroughUnread(false);
          setPendingSource(null);
        })
        .catch((error: unknown) => {
          if (sourceRequestRef.current === request) {
            setError(error instanceof Error ? error.message : String(error));
            setWalkthroughLoading(false);
            setPendingSource(null);
          }
        });
    },
    [pendingSource, saveCurrentSourceSession],
  );

  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
      if (mode === 'tree') {
        setSidebarMode('tree');
        return;
      }

      if (mode === 'history') {
        setSidebarMode('history');
        return;
      }

      setSidebarMode('walkthrough');
      setWalkthroughUnread(false);
      if (walkthrough || walkthroughLoading || !state) {
        return;
      }
      if (state.files.length === 0) {
        setWalkthrough(null);
        setWalkthroughError(null);
        setWalkthroughLoading(false);
        return;
      }

      const sourceKey = getSourceKey(state.source);
      setWalkthroughLoading(true);
      setWalkthroughError(null);
      window.codiff
        .getWalkthrough(state.source)
        .then((result) => {
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          if (result.status === 'ready') {
            setWalkthrough(result.walkthrough);
            if (sidebarModeRef.current === 'walkthrough') {
              setSidebarMode('walkthrough');
            } else {
              setWalkthroughUnread(true);
            }
          } else {
            setWalkthroughError(result.reason);
            if (sidebarModeRef.current === 'walkthrough') {
              setSidebarMode('tree');
            }
          }
        })
        .catch((error: unknown) => {
          if (getSourceKey(stateRef.current?.source ?? state.source) !== sourceKey) {
            return;
          }

          setWalkthroughError(error instanceof Error ? error.message : String(error));
          if (sidebarModeRef.current === 'walkthrough') {
            setSidebarMode('tree');
          }
        })
        .finally(() => {
          if (getSourceKey(stateRef.current?.source ?? state.source) === sourceKey) {
            setWalkthroughLoading(false);
          }
        });
    },
    [state, walkthrough, walkthroughLoading],
  );

  const toggleCollapsed = useCallback(
    (file: ChangedFile, isCollapsed: boolean) => {
      setCollapsed((current) => {
        const next = new Set(current);
        if (isCollapsed) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion],
  );

  const openFile = useCallback((file: ChangedFile) => {
    void window.codiff.openFile(file.path).catch(() => {});
  }, []);

  const updateSelectedPathFromScroll = useCallback(
    (viewer: CodeViewInstance) => {
      if (!visibleFiles.length) {
        return;
      }

      const scrollTop = viewer.getScrollTop();
      const activationTop = scrollTop + DEFAULT_PADDING;
      let nextPath = visibleFiles[0]?.path ?? null;
      let nextDistance = Number.NEGATIVE_INFINITY;

      for (const file of visibleFiles) {
        const section = getFirstVisibleSection(file, showWhitespace);
        const itemId = section ? getItemId(section) : null;
        const itemTop = itemId ? viewer.getTopForItem(itemId) : undefined;
        if (itemTop == null) {
          continue;
        }

        const distance = itemTop - activationTop;
        if (distance <= 0 && distance > nextDistance) {
          nextDistance = distance;
          nextPath = file.path;
        }
      }

      const programmaticScrollPath = programmaticScrollPathRef.current;
      if (programmaticScrollPath && nextPath !== programmaticScrollPath) {
        return;
      }

      if (programmaticScrollPath) {
        programmaticScrollPathRef.current = null;
        if (programmaticScrollTimerRef.current != null) {
          window.clearTimeout(programmaticScrollTimerRef.current);
          programmaticScrollTimerRef.current = null;
        }
      }

      if (nextPath) {
        setSelectedPath((current) => (current === nextPath ? current : nextPath));
      }
    },
    [showWhitespace, visibleFiles],
  );

  const toggleViewed = useCallback(
    (file: ChangedFile, isViewed: boolean) => {
      if (!state) {
        return;
      }

      setViewed((current) => {
        if (isViewed) {
          const next = { ...current };
          delete next[file.path];
          if (state.source.type === 'working-tree') {
            writeViewed(state.root, next);
          }
          return next;
        }

        const next = {
          ...current,
          [file.path]: file.fingerprint,
        };
        if (state.source.type === 'working-tree') {
          writeViewed(state.root, next);
        }
        return next;
      });

      setCollapsed((current) => {
        if (isViewed) {
          const next = new Set(current);
          next.delete(file.path);
          return next;
        }

        const next = new Set(current);
        next.add(file.path);
        return next;
      });
      bumpItemVersion(file.path);
    },
    [bumpItemVersion, state],
  );

  const createComment = useCallback((comment: Omit<ReviewComment, 'body' | 'id'>) => {
    const emptyExistingComment = reviewCommentsRef.current.find(
      (candidate) =>
        candidate.body.length === 0 && getCommentKey(candidate) === getCommentKey(comment),
    );
    if (emptyExistingComment) {
      setFocusCommentId(emptyExistingComment.id);
      setFocusCommentRequest((current) => current + 1);
      return;
    }

    const id = crypto.randomUUID();
    setFocusCommentId(id);
    setFocusCommentRequest((current) => current + 1);

    setReviewComments((current) => [
      ...current,
      {
        ...comment,
        body: '',
        id,
      },
    ]);
  }, []);

  const updateComment = useCallback((commentId: string, body: string) => {
    setReviewComments((current) =>
      current.map((comment) => (comment.id === commentId ? { ...comment, body } : comment)),
    );
  }, []);

  const deleteComment = useCallback((commentId: string) => {
    setFocusCommentId((current) => (current === commentId ? null : current));
    setReviewComments((current) => current.filter((comment) => comment.id !== commentId));
  }, []);

  const updateCodexReply = useCallback(
    (commentId: string, filePath: string, codexReply: NonNullable<ReviewComment['codexReply']>) => {
      setReviewComments((current) =>
        current.map((comment) =>
          comment.id === commentId
            ? {
                ...comment,
                codexReply,
              }
            : comment,
        ),
      );
      bumpItemVersion(filePath);
    },
    [bumpItemVersion],
  );

  const askCodex = useCallback(
    (commentId: string) => {
      const currentState = stateRef.current;
      const comment = reviewCommentsRef.current.find((candidate) => candidate.id === commentId);
      if (
        !currentState ||
        !comment ||
        comment.body.trim().length === 0 ||
        comment.codexReply?.status === 'loading'
      ) {
        return;
      }

      const note = walkthroughNotes.get(comment.filePath);
      const request: ReviewAssistantRequest = {
        comment: {
          body: comment.body,
          filePath: comment.filePath,
          lineNumber: comment.lineNumber,
          sectionId: comment.sectionId,
          side: comment.side,
        },
        source: currentState.source,
        walkthroughNote: note
          ? {
              action: note.action,
              context: note.context,
              groupReason: note.groupReason,
              groupTitle: note.groupTitle,
              impact: note.impact,
              reason: note.reason,
            }
          : undefined,
      };

      updateCodexReply(comment.id, comment.filePath, { status: 'loading' });
      void window.codiff
        .askReviewAssistant(request)
        .then((result) => {
          updateCodexReply(
            comment.id,
            comment.filePath,
            result.status === 'ready'
              ? {
                  body: result.reply,
                  status: 'ready',
                }
              : {
                  error: result.reason,
                  status: 'error',
                },
          );
        })
        .catch((error: unknown) => {
          updateCodexReply(comment.id, comment.filePath, {
            error: error instanceof Error ? error.message : String(error),
            status: 'error',
          });
        });
    },
    [updateCodexReply, walkthroughNotes],
  );

  if (error) {
    return (
      <main className="empty-state">
        <div className="empty-panel squircle">
          <strong>Unable to read repository</strong>
          <span>{error}</span>
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className={`loading italic${launchOptions.walkthrough ? ' codex' : ''}`}>
        {launchOptions.walkthrough ? 'Waiting on Codex…' : 'Thinking…'}
      </main>
    );
  }

  const selectedOrSearchPath = activeDiffSearchMatch?.filePath ?? selectedPath;
  const visibleSelectedPath =
    selectedOrSearchPath && visibleFiles.some((file) => file.path === selectedOrSearchPath)
      ? selectedOrSearchPath
      : (visibleFiles[0]?.path ?? null);
  const hasDiffSearchQuery = diffSearchQuery.trim().length > 0;

  return (
    <div className="app-shell">
      <RepositoryChangeBanner
        visible={localChangesDetected && (pendingSource ?? state.source).type === 'working-tree'}
      />
      <DiffSearchPanel
        activeIndex={effectiveActiveDiffSearchMatchIndex}
        focusRequest={diffSearchFocusRequest}
        matchCount={diffSearchMatches.length}
        onChange={updateDiffSearchQuery}
        onClose={closeDiffSearch}
        onNext={() => moveDiffSearchMatch(1)}
        onPrevious={() => moveDiffSearchMatch(-1)}
        query={diffSearchQuery}
        visible={diffSearchVisible}
      />
      <CopyCommentsButton
        comments={reviewComments}
        files={orderedFiles}
        showWhitespace={showWhitespace}
      />
      <aside className="sidebar squircle">
        <div className="sidebar-header">
          <div className="sidebar-path-row">
            <div className="sidebar-path" title={state.root}>
              {compactPath(state.root)}
              {state.source.type === 'commit' ? ` · ${getSourceLabel(state.source)}` : ''}
            </div>
          </div>
        </div>
        <Sidebar
          currentSource={pendingSource ?? state.source}
          files={visibleFiles}
          historyEntries={historyEntries}
          historyHasMore={historyHasMore}
          historyLoading={historyLoading}
          mode={sidebarMode}
          onActivatePath={activatePath}
          onLoadMoreHistory={loadMoreHistory}
          onModeChange={changeSidebarMode}
          onSearchQueryChange={
            sidebarMode === 'history' ? setHistorySearchQuery : setFileSearchQuery
          }
          onSelectPath={selectPath}
          onSelectSource={selectSource}
          searchQuery={sidebarMode === 'history' ? historySearchQuery : fileSearchQuery}
          selectedPath={visibleSelectedPath}
          walkthroughAvailable={walkthrough != null}
          walkthroughError={walkthroughError}
          walkthroughLoading={walkthroughLoading}
          walkthroughNotes={walkthroughNotes}
          walkthroughSummary={walkthrough?.summary ?? null}
          walkthroughUnread={walkthroughUnread}
        />
      </aside>
      <main className="review">
        {state.files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>
                {state.source.type === 'commit' ? 'No changes in commit' : 'No local changes'}
              </strong>
              <span>
                {state.source.type === 'commit' ? getShortRef(state.source.ref) : state.root}
              </span>
            </div>
          </div>
        ) : visibleFiles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-panel squircle">
              <strong>{hasDiffSearchQuery ? 'No matches in diffs' : 'No matching files'}</strong>
              <span>
                {diffSearchQuery ||
                  fileSearchQuery ||
                  (showWhitespace ? state.root : 'Whitespace-only changes hidden')}
              </span>
            </div>
          </div>
        ) : (
          <ReviewCodeView
            activeSearchMatch={activeDiffSearchMatch}
            collapsed={collapsed}
            comments={reviewComments}
            files={visibleFiles}
            focusCommentId={focusCommentId}
            focusCommentRequest={focusCommentRequest}
            forceExpandedPaths={diffSearchMatchPathSet}
            gitIdentity={gitIdentity}
            itemVersionByPath={itemVersionByPath}
            onAskCodex={askCodex}
            onCreateComment={createComment}
            onDeleteComment={deleteComment}
            onOpenFile={openFile}
            onSelectPathFromScroll={updateSelectedPathFromScroll}
            onToggleCollapsed={toggleCollapsed}
            onToggleViewed={toggleViewed}
            onUpdateComment={updateComment}
            scrollTarget={scrollTarget}
            searchQuery={diffSearchQuery}
            selectedPath={visibleSelectedPath}
            showWhitespace={showWhitespace}
            viewed={viewed}
            walkthroughNotes={
              sidebarMode === 'walkthrough' ? walkthroughNotes : emptyWalkthroughNotes
            }
          />
        )}
      </main>
    </div>
  );
}
