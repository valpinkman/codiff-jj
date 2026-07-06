// @ts-check

// Jujutsu (jj) support. Codiff prefers jj in repositories that have a `.jj`
// workspace and falls back to plain Git everywhere else. jj has no staging
// area: the working copy is itself a commit (`@`), so "working tree changes"
// are the diff between `@` and its first parent. Byte-level object reads keep
// going through Git plumbing — in colocated repositories the regular `.git`
// directory works as-is, and in internal-store repositories the helpers in
// `common.cjs` point Git at jj's backing store via `--git-dir`.

const { execFile, execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * @typedef {import('../../core/types.ts').GitFileStatus} GitFileStatus
 * @typedef {{oldPath?: string; path: string; status: GitFileStatus}} JujutsuStatusItem
 */

const MAX_BUFFER = 1024 * 1024 * 64;

// Global flags for every jj invocation: machine-readable output, no pager, and
// no "Working copy now at" chatter on stderr.
const JJ_GLOBAL_ARGS = ['--color', 'never', '--no-pager', '--quiet'];

/** @type {boolean | null} */
let jujutsuBinaryAvailable = null;

const isJujutsuBinaryAvailable = () => {
  if (jujutsuBinaryAvailable == null) {
    try {
      execFileSync('jj', ['--version'], { stdio: 'ignore' });
      jujutsuBinaryAvailable = true;
    } catch {
      jujutsuBinaryAvailable = false;
    }
  }

  return jujutsuBinaryAvailable;
};

/**
 * Walk up from `startPath` looking for a `.jj` workspace directory. Pure
 * filesystem check so it also works when the jj binary is unavailable.
 *
 * @param {string} startPath
 * @returns {string | null}
 */
const findJujutsuRoot = (startPath) => {
  let current = resolve(startPath);

  while (true) {
    if (existsSync(join(current, '.jj'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
};

/**
 * jj is used when the repository has a `.jj` workspace and the jj binary is
 * installed; otherwise Codiff falls back to Git.
 *
 * @param {string} path
 * @returns {string | null} The jj workspace root, or null when Git should be used.
 */
const getJujutsuRoot = (path) => {
  const root = findJujutsuRoot(path);
  return root && isJujutsuBinaryAvailable() ? root : null;
};

/**
 * The `--git-dir` Git needs to read objects in a jj repository whose backing
 * Git store is internal (no `.git` at the workspace root). Colocated
 * repositories return null because plain Git already works there.
 *
 * @param {string} path
 * @returns {string | null}
 */
const getGitDirOverride = (path) => {
  const root = findJujutsuRoot(path);
  if (!root || existsSync(join(root, '.git'))) {
    return null;
  }

  const store = join(root, '.jj', 'repo', 'store');
  try {
    return resolve(store, readFileSync(join(store, 'git_target'), 'utf8').trim());
  } catch {
    return join(store, 'git');
  }
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{encoding?: BufferEncoding}} [options]
 * @returns {Promise<string>}
 */
const jj = async (repoPath, args, options = {}) => {
  const { stdout } = await execFileAsync(
    'jj',
    ['--repository', repoPath, ...JJ_GLOBAL_ARGS, ...args],
    {
      // jj prints and parses paths relative to the process working directory,
      // so run from the workspace root to keep everything repo-relative.
      cwd: repoPath,
      encoding: options.encoding || 'utf8',
      maxBuffer: MAX_BUFFER,
    },
  );
  return stdout;
};

/**
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @returns {string}
 */
const jjSync = (repoPath, args) =>
  execFileSync('jj', ['--repository', repoPath, ...JJ_GLOBAL_ARGS, ...args], {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });

/** @param {string} repoPath @param {ReadonlyArray<string>} args */
const jjOrEmpty = async (repoPath, args) => {
  try {
    return await jj(repoPath, args);
  } catch {
    return '';
  }
};

/**
 * Quote a repository-relative path as a jj fileset literal so paths containing
 * fileset operators or whitespace are matched verbatim. `root:` anchors the
 * pattern to the workspace root regardless of the process working directory.
 *
 * @param {string} path
 */
const toFilesetLiteral = (path) => `root:"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** @param {ReadonlyArray<string>} args */
const createRevisionQueryArgs = (args) => ['log', '--ignore-working-copy', '--no-graph', ...args];

// Revision resolution must observe the current working copy: resolving `@` or
// the mapped `HEAD` against a stale snapshot would miss edits made since the
// last jj command. Snapshotting is a cheap no-op when nothing changed.
/** @param {ReadonlyArray<string>} args */
const createSnapshotRevisionQueryArgs = (args) => ['log', '--no-graph', ...args];

/**
 * Resolve a jj revset (change ID, bookmark, `@`, operators, …) to a single
 * commit hash. Throws when the revset does not resolve or matches more than
 * one revision.
 *
 * @param {string} repoPath
 * @param {string} revset
 * @returns {Promise<string>}
 */
const resolveJujutsuRevision = async (repoPath, revset) => {
  const raw = await jj(
    repoPath,
    createSnapshotRevisionQueryArgs(['-r', revset, '-n', '2', '-T', 'commit_id ++ "\\n"']),
  );
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(
      lines.length === 0
        ? `Revision "${revset}" does not exist in this repository.`
        : `Revision "${revset}" resolves to more than one commit.`,
    );
  }

  return lines[0];
};

/** @param {string} repoPath @param {string} revset */
const resolveJujutsuRevisionSync = (repoPath, revset) => {
  const lines = jjSync(
    repoPath,
    createSnapshotRevisionQueryArgs(['-r', revset, '-n', '2', '-T', 'commit_id ++ "\\n"']),
  )
    .split('\n')
    .filter(Boolean);
  return lines.length === 1 ? lines[0] : null;
};

const workingCopyInfoTemplate =
  'commit_id ++ "\\x1f" ++ change_id.shortest(8) ++ "\\x1f" ++ if(empty, "1", "0") ++ "\\x1f" ++ if(description, "1", "0") ++ "\\x1f" ++ parents.map(|commit| commit.commit_id()).join(" ")';

/** @param {string} raw */
const parseWorkingCopyInfo = (raw) => {
  const [commitId, changeId, empty, described, parents] = raw.trim().split('\x1f');
  return {
    changeId,
    commitId,
    described: described === '1',
    empty: empty === '1',
    parentCommitId: parents?.split(' ').filter(Boolean)[0] || null,
  };
};

/**
 * Working-copy metadata used by the working-tree readers: the snapshot commit,
 * its first parent (the diff base), and whether `@` is empty.
 *
 * @param {string} repoPath
 * @returns {Promise<{changeId: string; commitId: string; described: boolean; empty: boolean; parentCommitId: string | null}>}
 */
const readJujutsuWorkingCopyInfo = async (repoPath) =>
  parseWorkingCopyInfo(
    await jj(repoPath, createSnapshotRevisionQueryArgs(['-r', '@', '-T', workingCopyInfoTemplate])),
  );

/**
 * Map Git's `HEAD` onto jj: the working-copy commit when it carries changes or
 * a description, otherwise its (first) parent — mirroring how colocated jj
 * repositories point Git's `HEAD` at `@`'s parent while work is in progress.
 *
 * @param {ReturnType<typeof parseWorkingCopyInfo>} info
 */
const selectHeadCommit = (info) =>
  !info.empty || info.described ? info.commitId : info.parentCommitId;

/**
 * Resolve a ref the way Git callers expect: `HEAD` maps onto the working-copy
 * commit or its parent, everything else is a jj revset.
 *
 * @param {string} repoPath
 * @param {string} ref
 * @returns {Promise<string>}
 */
const resolveJujutsuRef = async (repoPath, ref) => {
  if (ref !== 'HEAD') {
    return resolveJujutsuRevision(repoPath, ref);
  }

  const head = selectHeadCommit(await readJujutsuWorkingCopyInfo(repoPath));
  if (!head) {
    throw new Error('The repository does not have any commits yet.');
  }
  return head;
};

/** @param {string} repoPath @param {string} ref @returns {string | null} */
const resolveJujutsuRefSync = (repoPath, ref) => {
  try {
    if (ref !== 'HEAD') {
      return resolveJujutsuRevisionSync(repoPath, ref);
    }

    return selectHeadCommit(
      parseWorkingCopyInfo(
        jjSync(
          repoPath,
          createSnapshotRevisionQueryArgs(['-r', '@', '-T', workingCopyInfoTemplate]),
        ),
      ),
    );
  } catch {
    return null;
  }
};

/**
 * The label Codiff shows where Git would show the current branch: bookmarks on
 * `@`, then bookmarks on its parents, then the short change ID of `@`.
 *
 * @param {string} repoPath
 * @returns {Promise<string | null>}
 */
const readJujutsuBranchLabel = async (repoPath) => {
  const raw = await jjOrEmpty(
    repoPath,
    createRevisionQueryArgs([
      '-r',
      '@',
      '-T',
      'local_bookmarks.join(", ") ++ "\\x1f" ++ parents.map(|commit| commit.local_bookmarks().join(", ")).join(", ") ++ "\\x1f" ++ change_id.shortest(8)',
    ]),
  );
  if (!raw) {
    return null;
  }

  const [current, parent, changeId] = raw.trim().split('\x1f');
  return current || parent || changeId || null;
};

/** @param {string} repoPath @returns {Promise<Array<string>>} */
const listJujutsuBookmarks = async (repoPath) => {
  const raw = await jjOrEmpty(repoPath, [
    'bookmark',
    'list',
    '--ignore-working-copy',
    '-T',
    'if(remote, name ++ "@" ++ remote, name) ++ "\\n"',
  ]);
  return [...new Set(raw.split('\n').filter(Boolean))];
};

/** @param {string} repoPath @param {string} ref */
const isJujutsuBookmarkSync = (repoPath, ref) => {
  try {
    return jjSync(repoPath, [
      'bookmark',
      'list',
      '--all-remotes',
      '--ignore-working-copy',
      '-T',
      'if(remote, name ++ "@" ++ remote, name) ++ "\\n"',
    ])
      .split('\n')
      .filter(Boolean)
      .includes(ref);
  } catch {
    return false;
  }
};

const summaryStatusCodes = new Map([
  ['A', 'added'],
  ['C', 'renamed'],
  ['D', 'deleted'],
  ['M', 'modified'],
  ['R', 'renamed'],
]);

/**
 * Expand jj's compressed rename notation — `prefix{old => new}suffix`, or
 * `old => new` without braces — into concrete old and new paths.
 *
 * @param {string} value
 * @returns {{oldPath: string; path: string}}
 */
const parseJujutsuRenamePath = (value) => {
  const open = value.indexOf('{');
  const close = value.lastIndexOf('}');
  if (open !== -1 && close > open) {
    const prefix = value.slice(0, open);
    const suffix = value.slice(close + 1);
    const [oldPart = '', newPart = ''] = value.slice(open + 1, close).split(' => ');
    return {
      oldPath: `${prefix}${oldPart}${suffix}`,
      path: `${prefix}${newPart}${suffix}`,
    };
  }

  const [oldPath = value, path = value] = value.split(' => ');
  return { oldPath, path };
};

/**
 * Parse `jj diff --summary` output into status items. jj has no index, so
 * every entry describes the working copy relative to `@`'s parent.
 *
 * @param {string} raw
 * @returns {Array<JujutsuStatusItem>}
 */
const parseJujutsuSummary = (raw) => {
  /** @type {Array<JujutsuStatusItem>} */
  const items = [];

  for (const line of raw.split('\n')) {
    const status = summaryStatusCodes.get(line[0]);
    if (!status || line[1] !== ' ') {
      continue;
    }

    const value = line.slice(2);
    if (status === 'renamed') {
      const { oldPath, path } = parseJujutsuRenamePath(value);
      items.push({ oldPath, path, status });
    } else {
      items.push({ path: value, status });
    }
  }

  return items;
};

/**
 * Snapshot the working copy and list its changes in one call. Any jj command
 * without `--ignore-working-copy` snapshots first, so this doubles as the
 * "refresh" step before follow-up `--ignore-working-copy` reads.
 *
 * @param {string} repoPath
 * @returns {Promise<Array<JujutsuStatusItem>>}
 */
const readJujutsuStatus = async (repoPath) =>
  parseJujutsuSummary(await jj(repoPath, ['diff', '--summary']));

/**
 * @param {string} repoPath
 * @param {{paths?: ReadonlyArray<string>; showWhitespace?: boolean}} [options]
 * @returns {Promise<string>}
 */
const readJujutsuDiffPatch = (repoPath, options = {}) =>
  jj(repoPath, [
    'diff',
    '--git',
    '--ignore-working-copy',
    ...(options.showWhitespace === false ? ['--ignore-all-space'] : []),
    ...(options.paths?.length ? ['--', ...options.paths.map(toFilesetLiteral)] : []),
  ]);

/**
 * Create a commit from the working copy, restricted to `paths`. jj commits
 * straight from the working-copy commit — no staging step — and leaves the
 * remaining changes in the new `@`.
 *
 * @param {string} repoPath
 * @param {string} message
 * @param {ReadonlyArray<string>} paths
 * @returns {Promise<string>} The new commit hash.
 */
const createJujutsuCommit = async (repoPath, message, paths) => {
  await jj(repoPath, ['commit', '-m', message, '--', ...paths.map(toFilesetLiteral)]);
  return resolveJujutsuRevision(repoPath, '@-');
};

/**
 * The user's identity: jj configuration first, then the author of the
 * working-copy commit (jj stamps it with the configured identity at snapshot
 * time, so it covers repositories configured through other means).
 *
 * @param {string} repoPath
 * @returns {Promise<{email: string; name: string}>}
 */
const readJujutsuIdentity = async (repoPath) => {
  const [name, email, workingCopyAuthor] = await Promise.all([
    jjOrEmpty(repoPath, ['config', 'get', 'user.name']),
    jjOrEmpty(repoPath, ['config', 'get', 'user.email']),
    jjOrEmpty(
      repoPath,
      createRevisionQueryArgs(['-r', '@', '-T', 'author.name() ++ "\\x1f" ++ author.email()']),
    ),
  ]);
  const [authorName = '', authorEmail = ''] = workingCopyAuthor.trim().split('\x1f');
  return {
    email: email.trim() || authorEmail.trim(),
    name: name.trim() || authorName.trim(),
  };
};

module.exports = {
  createJujutsuCommit,
  findJujutsuRoot,
  getGitDirOverride,
  getJujutsuRoot,
  isJujutsuBinaryAvailable,
  isJujutsuBookmarkSync,
  jj,
  jjOrEmpty,
  jjSync,
  listJujutsuBookmarks,
  parseJujutsuRenamePath,
  parseJujutsuSummary,
  readJujutsuBranchLabel,
  readJujutsuDiffPatch,
  readJujutsuIdentity,
  readJujutsuStatus,
  readJujutsuWorkingCopyInfo,
  resolveJujutsuRef,
  resolveJujutsuRefSync,
  resolveJujutsuRevision,
  resolveJujutsuRevisionSync,
  toFilesetLiteral,
};
