// @ts-check

const { promises: fs } = require('node:fs');
const { join } = require('node:path');
const {
  createSection,
  createSummary,
  fileSort,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getFingerprint,
  getGravatarHash,
  getWhitespaceDiffArgs,
  git,
  MAX_UNTRACKED_INITIAL_ITEMS,
  parseStatus,
  readFileStat,
  readGitFile,
  readGitImageFile,
  readImageSpec,
  readIndexImageFile,
  readWorkingTreeFile,
  readWorkingTreeImageFile,
  resolveRepositoryRoot,
  resolveRepositoryRootOrEmpty,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const {
  getJujutsuRoot,
  readJujutsuDiffPatch,
  readJujutsuIdentity,
  readJujutsuStatus,
  readJujutsuWorkingCopyInfo,
} = require('./jj.cjs');

/**
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {'staged' | 'unstaged'} WorkingTreeSectionKind
 * @typedef {{force?: boolean; patch?: {binary: boolean; patch: string}; patchOnly?: boolean; showWhitespace?: boolean}} ReadFileOptionsWithPatch
 */

const diffGitHeaderPattern = /^diff --git (.+)$/;

/** @param {string} value */
const unquoteGitPath = (value) => {
  if (!value.startsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value.slice(1, value.endsWith('"') ? -1 : undefined);
  }
};

/** @param {string} line */
const splitDiffGitHeader = (line) => {
  const match = line.match(diffGitHeaderPattern);
  if (!match) {
    return null;
  }

  const paths = [];
  let index = 0;
  const value = match[1];
  while (index < value.length && paths.length < 2) {
    while (value[index] === ' ') {
      index += 1;
    }

    if (value[index] === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < value.length) {
        const char = value[end];
        if (char === '"' && !escaped) {
          end += 1;
          break;
        }
        escaped = char === '\\' && !escaped;
        if (char !== '\\') {
          escaped = false;
        }
        end += 1;
      }
      paths.push(unquoteGitPath(value.slice(index, end)));
      index = end;
      continue;
    }

    const end = value.indexOf(' ', index);
    if (end === -1) {
      paths.push(value.slice(index));
      break;
    }

    paths.push(value.slice(index, end));
    index = end + 1;
  }

  return paths.length === 2 ? paths : null;
};

/** @param {string} path */
const stripGitDiffPrefix = (path) =>
  path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;

/** @param {string} path */
const shouldEagerlyReadWorkingTreeContents = (path) => /\.md$/i.test(path);

/** @param {string} rawPatch @returns {Map<string, {binary: boolean; patch: string}>} */
const splitPatchByPath = (rawPatch) => {
  const patches = new Map();
  const starts = [];
  const pattern = /^diff --git .+$/gm;
  let match;

  while ((match = pattern.exec(rawPatch))) {
    starts.push(match.index);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? rawPatch.length;
    const patch = rawPatch.slice(start, end);
    const header = patch.slice(0, patch.indexOf('\n') === -1 ? patch.length : patch.indexOf('\n'));
    const paths = splitDiffGitHeader(header);
    const path = paths ? stripGitDiffPrefix(paths[1]) : null;
    if (path) {
      patches.set(path, {
        binary: /Binary files .* differ/.test(patch),
        patch,
      });
    }
  }

  return patches;
};

/**
 * @param {string} repoRoot
 * @param {WorkingTreeSectionKind} kind
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<Map<string, {binary: boolean; patch: string}>>}
 */
const readPatchMap = async (repoRoot, kind, options = {}) => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  const args =
    kind === 'staged'
      ? ['diff', '--cached', '--patch', '--no-ext-diff', ...whitespaceArgs]
      : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs];
  return splitPatchByPath(await git(repoRoot, args));
};

/** @param {string} repoRoot @returns {Promise<Array<StatusItem>>} */
const listUntrackedItems = async (repoRoot) => {
  const rawFiles = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
    ...generatedDirectoryPathspecExcludes,
  ]);
  const paths = rawFiles.split('\0').filter(Boolean).sort();
  /** @type {Array<StatusItem>} */
  const items = paths.slice(0, MAX_UNTRACKED_INITIAL_ITEMS).map((path) => ({
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  }));

  if (paths.length > MAX_UNTRACKED_INITIAL_ITEMS) {
    const omitted = paths.length - MAX_UNTRACKED_INITIAL_ITEMS;
    items.push({
      directory: true,
      path: `Untracked files not shown (${omitted} more)`,
      staged: false,
      status: 'untracked',
      summary: createSummary(`${omitted} untracked files are not shown.`, {
        canLoad: false,
        fileCount: omitted,
        loadState: 'directory',
      }),
      unstaged: true,
      untracked: true,
    });
  }

  const rawDirectories = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--directory',
    '-z',
    '--',
    ...generatedDirectoryPathspecs,
  ]);

  for (const path of rawDirectories.split('\0').filter(Boolean)) {
    items.push({
      directory: true,
      path: path.endsWith('/') ? path.slice(0, -1) : path,
      staged: false,
      status: 'untracked',
      unstaged: true,
      untracked: true,
    });
  }

  const unique = new Map();
  for (const item of items) {
    unique.set(item.path, item);
  }

  return [...unique.values()].sort(fileSort);
};

// `git show` against this spec always fails, which the file readers already
// treat as "the file did not exist on that side of the diff".
const MISSING_COMMIT = '0'.repeat(40);

/**
 * jj has no staging area: the working copy is the commit `@`, and its changes
 * are the diff against `@`'s first parent. Every changed file therefore gets a
 * single section. New files are tracked automatically by jj, so they arrive
 * as regular additions instead of a separate untracked bucket.
 *
 * @param {import('./jj.cjs').JujutsuStatusItem} item
 * @returns {StatusItem}
 */
const toJujutsuStatusItem = (item) => ({
  oldPath: item.oldPath,
  path: item.path,
  staged: false,
  status: item.status,
  unstaged: true,
  untracked: false,
});

/**
 * @param {string} repoRoot
 * @param {string} parentCommitId
 * @param {StatusItem} item
 * @param {ReadFileOptionsWithPatch} [options]
 * @returns {Promise<DiffSection>}
 */
const createJujutsuSection = async (repoRoot, parentCommitId, item, options = {}) => {
  const id = `${item.path}:unstaged`;
  const readPatch = async () => {
    const paths =
      item.oldPath && item.oldPath !== item.path ? [item.oldPath, item.path] : [item.path];
    const patch = await readJujutsuDiffPatch(repoRoot, {
      paths,
      showWhitespace: options.showWhitespace,
    });
    return {
      binary: /Binary files .* differ/.test(patch),
      patch,
    };
  };

  if (options.patchOnly) {
    const patch = options.patch ?? (await readPatch());

    if (patch.binary) {
      return {
        binary: true,
        id,
        kind: 'unstaged',
        loadState: 'binary',
        patch: '',
        summary: createSummary('Binary file changed.', {
          canLoad: false,
        }),
      };
    }

    return {
      binary: false,
      id,
      kind: 'unstaged',
      loadState: 'ready',
      patch: patch.patch,
    };
  }

  const oldFile = await readGitFile(repoRoot, parentCommitId, item.oldPath || item.path, options);
  const newFile = await readWorkingTreeFile(repoRoot, item.path, options);
  const summary = summarizeContent(oldFile, newFile);

  if (summary.loadState !== 'ready') {
    return {
      binary: summary.binary,
      id,
      kind: 'unstaged',
      loadState: summary.loadState,
      patch: '',
      summary: summary.summary,
    };
  }

  const patch = await readPatch();

  return {
    binary: patch.binary || summary.binary,
    id,
    kind: 'unstaged',
    loadState: 'ready',
    newFile: newFile.file,
    oldFile: oldFile.file,
    patch: patch.patch,
  };
};

/** @param {StatusItem} item @param {ReadonlyArray<DiffSection>} sections */
const getChangedFileFingerprint = (item, sections) =>
  getFingerprint(
    `${item.status}\n${item.oldPath || ''}\n${sections
      .map(
        (section) =>
          `${section.loadState || 'ready'}\n${section.binary ? 'binary' : 'text'}\n${
            section.patch
          }\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${
            section.oldFile?.contents || ''
          }\n${section.newFile?.contents || ''}`,
      )
      .join('\n')}`,
  );

/**
 * @param {string} repoRoot
 * @param {string} launchPath
 * @param {{eagerContents?: boolean; showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readJujutsuWorkingTreeState = async (repoRoot, launchPath, options = {}) => {
  // The status read snapshots the working copy, so the follow-up
  // `--ignore-working-copy` reads all observe the same state.
  const status = (await readJujutsuStatus(repoRoot)).map(toJujutsuStatusItem).sort(fileSort);
  const workingCopy = await readJujutsuWorkingCopyInfo(repoRoot);
  const parentCommitId = workingCopy.parentCommitId || MISSING_COMMIT;
  const shouldUsePatchOnly = options.eagerContents === false;
  const patches = shouldUsePatchOnly
    ? splitPatchByPath(
        await readJujutsuDiffPatch(repoRoot, { showWhitespace: options.showWhitespace }),
      )
    : new Map();
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    const patchOnly = shouldUsePatchOnly && !shouldEagerlyReadWorkingTreeContents(item.path);
    const sections = [
      await createJujutsuSection(repoRoot, parentCommitId, item, {
        patch: patches.get(item.path),
        patchOnly,
        showWhitespace: options.showWhitespace,
      }),
    ];

    files.push({
      fingerprint: getChangedFileFingerprint(item, sections),
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

/**
 * @param {string} launchPath
 * @param {{eagerContents?: boolean; showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readWorkingTreeState = async (launchPath, options = {}) => {
  const jujutsuRoot = getJujutsuRoot(launchPath);
  if (jujutsuRoot) {
    return readJujutsuWorkingTreeState(jujutsuRoot, launchPath, options);
  }

  const repoRoot = await resolveRepositoryRoot(launchPath);
  const [trackedStatus, untrackedItems] = await Promise.all([
    git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
    listUntrackedItems(repoRoot),
  ]);
  const status = [...parseStatus(trackedStatus), ...untrackedItems].sort(fileSort);
  const shouldUsePatchOnly = options.eagerContents === false;
  const [stagedPatches, unstagedPatches] = shouldUsePatchOnly
    ? await Promise.all([
        readPatchMap(repoRoot, 'staged', options),
        readPatchMap(repoRoot, 'unstaged', options),
      ])
    : [new Map(), new Map()];
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    /** @type {Array<DiffSection>} */
    const sections = [];
    const patchOnly = shouldUsePatchOnly && !shouldEagerlyReadWorkingTreeContents(item.path);

    if (item.staged) {
      sections.push(
        await createSection(repoRoot, item, 'staged', {
          patch: stagedPatches.get(item.path),
          patchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    if (item.unstaged) {
      sections.push(
        await createSection(repoRoot, item, 'unstaged', {
          patch: unstagedPatches.get(item.path),
          patchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    files.push({
      fingerprint: getChangedFileFingerprint(item, sections),
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

/** @param {string} repoRoot @param {string} path @returns {Promise<StatusItem>} */
const getStatusItemForPath = async (repoRoot, path) => {
  const trackedStatus = parseStatus(
    await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
  );
  const trackedItem = trackedStatus.find((item) => item.path === path);
  if (trackedItem) {
    return trackedItem;
  }

  const stat = await readFileStat(repoRoot, path);
  return {
    directory: Boolean(stat?.isDirectory()),
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  };
};

/**
 * @param {string} repoRoot
 * @param {string} path
 * @returns {Promise<{item: StatusItem; parentCommitId: string}>}
 */
const getJujutsuStatusItemForPath = async (repoRoot, path) => {
  const status = (await readJujutsuStatus(repoRoot)).map(toJujutsuStatusItem);
  const workingCopy = await readJujutsuWorkingCopyInfo(repoRoot);
  return {
    item: status.find((item) => item.path === path) || {
      path,
      staged: false,
      status: 'modified',
      unstaged: true,
      untracked: false,
    },
    parentCommitId: workingCopy.parentCommitId || MISSING_COMMIT,
  };
};

/** @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (launchPath, request) => {
  const path = validateRepositoryPath(request.path);
  if (request.kind === 'commit' || request.source?.type === 'commit') {
    throw new Error('Lazy loading commit diffs is not supported.');
  }

  const jujutsuRoot = getJujutsuRoot(launchPath);
  if (jujutsuRoot) {
    const { item, parentCommitId } = await getJujutsuStatusItemForPath(jujutsuRoot, path);
    return createJujutsuSection(jujutsuRoot, parentCommitId, item, {
      force: request.force,
      showWhitespace: request.showWhitespace,
    });
  }

  const repoRoot = await resolveRepositoryRoot(launchPath);
  const item = await getStatusItemForPath(repoRoot, path);
  return createSection(repoRoot, item, /** @type {WorkingTreeSectionKind} */ (request.kind), {
    force: request.force,
    showWhitespace: request.showWhitespace,
  });
};

/**
 * @param {string} launchPath
 * @param {DiffImageContentRequest} request
 * @returns {Promise<DiffImageContentResult>}
 */
const readDiffImageContent = async (launchPath, request) => {
  try {
    const path = validateRepositoryPath(request.path);
    if (request.kind === 'commit' || request.source?.type === 'commit') {
      throw new Error('Commit image diffs are loaded through the commit reader.');
    }

    const jujutsuRoot = getJujutsuRoot(launchPath);
    if (jujutsuRoot) {
      const { item, parentCommitId } = await getJujutsuStatusItemForPath(jujutsuRoot, path);
      const oldPath = item.oldPath || item.path;
      const [oldImage, newImage] = await Promise.all([
        item.status === 'added'
          ? undefined
          : readImageSpec(jujutsuRoot, `${parentCommitId}:${oldPath}`, oldPath),
        readWorkingTreeImageFile(jujutsuRoot, item.path),
      ]);

      if (!oldImage && !newImage) {
        return {
          reason: 'Codiff could not load either side of this image.',
          status: 'unavailable',
        };
      }

      return {
        ...(newImage ? { newImage } : {}),
        ...(oldImage ? { oldImage } : {}),
        status: 'ready',
      };
    }

    const repoRoot = await resolveRepositoryRoot(launchPath);
    const item = await getStatusItemForPath(repoRoot, path);
    const oldPath = item.oldPath || item.path;
    const [oldImage, newImage] =
      request.kind === 'staged'
        ? await Promise.all([
            readGitImageFile(repoRoot, 'HEAD', oldPath),
            readIndexImageFile(repoRoot, item.path),
          ])
        : await Promise.all([
            item.untracked ? undefined : readIndexImageFile(repoRoot, oldPath),
            readWorkingTreeImageFile(repoRoot, item.path),
          ]);

    if (!oldImage && !newImage) {
      return {
        reason: 'Codiff could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

/** @param {string} repoRoot @param {string} path */
const readWorkingTreePathSignature = async (repoRoot, path) => {
  try {
    const absolutePath = join(repoRoot, path);
    const stat = await fs.lstat(absolutePath);

    if (stat.isDirectory()) {
      return `${path}\0directory\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}`;
    }

    if (stat.isSymbolicLink()) {
      return `${path}\0symlink\0${stat.mode}\0${await fs.readlink(absolutePath)}`;
    }

    if (!stat.isFile()) {
      return `${path}\0other\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}`;
    }

    const content =
      stat.size <= 64 * 1024 * 1024
        ? getFingerprint(await fs.readFile(absolutePath))
        : `${stat.size}\0${stat.mtimeMs}`;

    return `${path}\0file\0${stat.mode}\0${stat.size}\0${content}`;
  } catch {
    return `${path}\0missing`;
  }
};

/** @param {string} repoRoot @param {Iterable<string>} [additionalPaths] */
const readWorkingTreeChangeSignatures = async (repoRoot, additionalPaths = []) => {
  const status = parseStatus(await git(repoRoot, ['status', '--porcelain=v1', '-z', '-uall']));
  const signatures = new Map();

  for (const item of status) {
    if (
      item.oldPath &&
      item.oldPath !== item.path &&
      !(await readFileStat(repoRoot, item.oldPath))
    ) {
      signatures.set(item.oldPath, `${item.oldPath}\0missing`);
    }

    signatures.set(item.path, await readWorkingTreePathSignature(repoRoot, item.path));
  }
  for (const path of additionalPaths) {
    if (!signatures.has(path)) {
      signatures.set(path, await readWorkingTreePathSignature(repoRoot, path));
    }
  }

  return [...signatures.entries()].sort(([left], [right]) => left.localeCompare(right));
};

/** @param {string} repoRoot @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (repoRoot, args) => {
  try {
    return await git(repoRoot, args);
  } catch {
    return '';
  }
};

/** @param {string} launchPath */
const readGitIdentity = async (launchPath) => {
  const jujutsuRoot = getJujutsuRoot(launchPath);
  if (jujutsuRoot) {
    const { email, name } = await readJujutsuIdentity(jujutsuRoot);
    return {
      email,
      gravatarUrl: email
        ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
        : undefined,
      name,
    };
  }

  const repoRoot = await resolveRepositoryRootOrEmpty(launchPath);
  const [configuredName, configuredEmail, commitIdentity] = await Promise.all([
    gitOrEmpty(launchPath, ['config', '--get', 'user.name']),
    gitOrEmpty(launchPath, ['config', '--get', 'user.email']),
    repoRoot ? gitOrEmpty(repoRoot, ['log', '-1', '--format=%an%x00%ae', 'HEAD']) : '',
  ]);
  const [commitName = '', commitEmail = ''] = commitIdentity.trim().split('\0');
  const email = configuredEmail.trim() || commitEmail.trim();
  const name = configuredName.trim() || commitName.trim();

  return {
    email,
    gravatarUrl: email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined,
    name,
  };
};

/**
 * jj equivalent of the repository change signature. The "head" is the first
 * parent of the working-copy commit: it stays stable while files are edited
 * (so the watcher's self-write suppression keeps working) and moves on
 * commits, rebases, and `jj edit`/`jj new`. File edits are captured by the
 * filesystem path signatures of everything the snapshot reports as changed.
 *
 * @param {string} repoRoot
 * @param {Iterable<string>} [additionalPaths]
 */
const readJujutsuRepositoryChangeSignature = async (repoRoot, additionalPaths = []) => {
  const status = await readJujutsuStatus(repoRoot);
  const workingCopy = await readJujutsuWorkingCopyInfo(repoRoot);
  const head = workingCopy.parentCommitId || '';
  const signatures = new Map();

  for (const item of status) {
    if (
      item.oldPath &&
      item.oldPath !== item.path &&
      !(await readFileStat(repoRoot, item.oldPath))
    ) {
      signatures.set(item.oldPath, `${item.oldPath}\0missing`);
    }

    signatures.set(item.path, await readWorkingTreePathSignature(repoRoot, item.path));
  }
  for (const path of additionalPaths) {
    if (!signatures.has(path)) {
      signatures.set(path, await readWorkingTreePathSignature(repoRoot, path));
    }
  }

  const workingTreeSignatures = [...signatures.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const workingTree = workingTreeSignatures.map(([, signature]) => signature).join('\0');

  return {
    head,
    pathSignatures: Object.fromEntries(workingTreeSignatures),
    root: repoRoot,
    signature: getFingerprint([head, workingTree].join('\0')),
  };
};

/** @param {string} launchPath @param {Iterable<string>} [additionalPaths] */
const readRepositoryChangeSignature = async (launchPath, additionalPaths = []) => {
  const jujutsuRoot = getJujutsuRoot(launchPath);
  if (jujutsuRoot) {
    return readJujutsuRepositoryChangeSignature(jujutsuRoot, additionalPaths);
  }

  const repoRoot = await resolveRepositoryRoot(launchPath);
  const [head, workingTreeSignatures] = await Promise.all([
    gitOrEmpty(repoRoot, ['rev-parse', '--verify', 'HEAD']),
    readWorkingTreeChangeSignatures(repoRoot, additionalPaths),
  ]);
  const workingTree = workingTreeSignatures.map(([, signature]) => signature).join('\0');

  return {
    head,
    pathSignatures: Object.fromEntries(workingTreeSignatures),
    root: repoRoot,
    signature: getFingerprint([head, workingTree].join('\0')),
  };
};

module.exports = {
  getStatusItemForPath,
  listUntrackedItems,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
};
