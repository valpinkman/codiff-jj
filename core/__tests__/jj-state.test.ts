import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import type { DiffSectionContentRequest, RepositoryState, ReviewSource } from '../types.ts';

type JujutsuStatusEntry = {
  oldPath?: string;
  path: string;
  status: string;
};

type JujutsuModule = {
  parseJujutsuRenamePath: (value: string) => { oldPath: string; path: string };
  parseJujutsuSummary: (raw: string) => Array<JujutsuStatusEntry>;
  toFilesetLiteral: (path: string) => string;
};

type GitStateModule = {
  listRepositoryHistory: (
    launchPath: string,
    limit?: number,
    source?: ReviewSource,
  ) => Promise<{ entries: ReadonlyArray<{ ref: string; subject: string }>; root: string }>;
  readDiffSectionContent: (
    launchPath: string,
    request: DiffSectionContentRequest,
  ) => Promise<{
    kind?: string;
    loadState?: string;
    newFile?: { contents: string };
    patch: string;
  }>;
  readGitIdentity: (
    launchPath: string,
  ) => Promise<{ email: string; gravatarUrl?: string; name: string }>;
  readRepositoryChangeSignature: (
    launchPath: string,
  ) => Promise<{ head: string; root: string; signature: string }>;
  readRepositoryState: (
    launchPath: string,
    source?: ReviewSource,
    options?: { showWhitespace?: boolean },
  ) => Promise<RepositoryState>;
  readWalkthroughRepositoryState: (
    launchPath: string,
    source?: ReviewSource,
  ) => Promise<RepositoryState>;
  readWorkingTreeState: (
    launchPath: string,
    options?: { eagerContents?: boolean; showWhitespace?: boolean },
  ) => Promise<RepositoryState>;
};

type WalkthroughCommitModule = {
  createWalkthroughCommit: (
    repoPath: string,
    request: { body?: string; paths: ReadonlyArray<string>; subject: string },
  ) => Promise<{ hash?: string; reason?: string; status: string }>;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { parseJujutsuRenamePath, parseJujutsuSummary, toFilesetLiteral } =
  require('../../electron/git-state/jj.cjs') as JujutsuModule;
const {
  listRepositoryHistory,
  readDiffSectionContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readRepositoryState,
  readWalkthroughRepositoryState,
  readWorkingTreeState,
} = require('../../electron/git-state.cjs') as GitStateModule;
const { createWalkthroughCommit } =
  require('../../electron/walkthrough-commit.cjs') as WalkthroughCommitModule;

const hasJujutsu = (() => {
  try {
    execFileSync('jj', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const testWithJujutsu = test.skipIf(!hasJujutsu);

const jj = async (repo: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync(
    'jj',
    ['--repository', repo, '--color', 'never', '--no-pager', '--quiet', ...args],
    { cwd: repo, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 },
  );
  return stdout;
};

const createJujutsuRepo = async ({ colocate = true }: { colocate?: boolean } = {}) => {
  const repo = await mkdtemp(join(tmpdir(), 'codiff-jj-state-'));
  await execFileAsync(
    'jj',
    colocate ? ['git', 'init', '--colocate'] : ['git', 'init', '--config', 'git.colocate=false'],
    { cwd: repo, encoding: 'utf8' },
  );
  await execFileAsync('jj', ['config', 'set', '--repo', 'user.name', 'Codiff Test'], {
    cwd: repo,
    encoding: 'utf8',
  });
  await execFileAsync('jj', ['config', 'set', '--repo', 'user.email', 'codiff@example.com'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return realpath(repo);
};

const writeRepoFile = async (repo: string, path: string, contents: string | Uint8Array) => {
  const absolutePath = join(repo, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
};

const withJujutsuRepo = async (
  run: (repo: string) => Promise<void>,
  options: { colocate?: boolean } = {},
) => {
  const repo = await createJujutsuRepo(options);
  try {
    await run(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
};

const getChangeId = async (repo: string, revset: string) =>
  (
    await jj(repo, [
      'log',
      '--ignore-working-copy',
      '--no-graph',
      '-r',
      revset,
      '-T',
      'change_id.shortest(8)',
    ])
  ).trim();

test('parseJujutsuSummary reads statuses, renames, and paths with spaces', () => {
  expect(
    parseJujutsuSummary(
      'M a.txt\nA my file.txt\nD gone.txt\nR dir/{b.txt => renamed.txt}\nC {src.txt => copy.txt}\n',
    ),
  ).toEqual([
    { path: 'a.txt', status: 'modified' },
    { path: 'my file.txt', status: 'added' },
    { path: 'gone.txt', status: 'deleted' },
    { oldPath: 'dir/b.txt', path: 'dir/renamed.txt', status: 'renamed' },
    { oldPath: 'src.txt', path: 'copy.txt', status: 'renamed' },
  ]);
});

test('parseJujutsuSummary ignores unrecognized lines', () => {
  expect(parseJujutsuSummary('Working copy changes:\n\nX weird\n')).toEqual([]);
});

test('parseJujutsuRenamePath expands compressed and plain rename notations', () => {
  expect(parseJujutsuRenamePath('dir/{old.txt => new.txt}')).toEqual({
    oldPath: 'dir/old.txt',
    path: 'dir/new.txt',
  });
  expect(parseJujutsuRenamePath('{a => b}/file.txt')).toEqual({
    oldPath: 'a/file.txt',
    path: 'b/file.txt',
  });
  expect(parseJujutsuRenamePath('old.txt => new.txt')).toEqual({
    oldPath: 'old.txt',
    path: 'new.txt',
  });
});

test('toFilesetLiteral quotes paths against fileset syntax', () => {
  expect(toFilesetLiteral('my file.txt')).toBe('root:"my file.txt"');
  expect(toFilesetLiteral(String.raw`we"ird\path.txt`)).toBe(String.raw`root:"we\"ird\\path.txt"`);
});

testWithJujutsu(
  'readWorkingTreeState reports jj working-copy changes as single sections',
  async () => {
    await withJujutsuRepo(async (repo) => {
      await writeRepoFile(repo, 'a.txt', 'one\n');
      await writeRepoFile(repo, 'dir/b.txt', 'two\n');
      await writeRepoFile(repo, 'gone.txt', 'bye\n');
      await jj(repo, ['commit', '-m', 'initial commit']);

      await writeRepoFile(repo, 'a.txt', 'one\nmore\n');
      await writeRepoFile(repo, 'fresh.txt', 'new file\n');
      await unlink(join(repo, 'gone.txt'));

      const state = await readWorkingTreeState(repo, { eagerContents: false });
      expect(state.root).toBe(repo);
      expect(state.files.map((file) => ({ path: file.path, status: file.status }))).toEqual([
        { path: 'a.txt', status: 'modified' },
        { path: 'fresh.txt', status: 'added' },
        { path: 'gone.txt', status: 'deleted' },
      ]);

      for (const file of state.files) {
        expect(file.sections).toHaveLength(1);
        expect(file.sections[0].kind).toBe('unstaged');
      }

      const modified = state.files.find((file) => file.path === 'a.txt');
      expect(modified?.sections[0].patch).toContain('+more');
      const added = state.files.find((file) => file.path === 'fresh.txt');
      expect(added?.sections[0].patch).toContain('+new file');
    });
  },
);

testWithJujutsu('readWorkingTreeState reports jj renames with their old path', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'dir/original.txt', 'contents\n');
    await jj(repo, ['commit', '-m', 'initial commit']);

    await rm(join(repo, 'dir/original.txt'));
    await writeRepoFile(repo, 'dir/moved.txt', 'contents\n');

    const state = await readWorkingTreeState(repo, { eagerContents: false });
    expect(state.files).toHaveLength(1);
    expect(state.files[0]).toMatchObject({
      oldPath: 'dir/original.txt',
      path: 'dir/moved.txt',
      status: 'renamed',
    });
  });
});

testWithJujutsu('readDiffSectionContent lazily loads jj working-copy sections', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'notes.txt', 'before\n');
    await jj(repo, ['commit', '-m', 'initial commit']);
    await writeRepoFile(repo, 'notes.txt', 'after\n');

    const section = await readDiffSectionContent(repo, {
      kind: 'unstaged',
      path: 'notes.txt',
    } as DiffSectionContentRequest);
    expect(section.loadState).toBe('ready');
    expect(section.newFile?.contents).toBe('after\n');
    expect(section.patch).toContain('-before');
    expect(section.patch).toContain('+after');
  });
});

testWithJujutsu('readRepositoryState shows bookmarks as the branch label', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'initial commit']);
    await jj(repo, ['bookmark', 'create', 'feature', '-r', '@-']);

    const state = await readRepositoryState(repo);
    expect(state.branch).toBe('feature');
  });
});

testWithJujutsu('readRepositoryState reviews commits by change ID', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'first commit']);
    const changeId = await getChangeId(repo, '@-');

    const state = await readRepositoryState(repo, { ref: changeId, type: 'commit' });
    expect(state.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(state.commitMetadata?.subject).toBe('first commit');
  });
});

testWithJujutsu('readRepositoryState compares against jj bookmarks', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'initial commit']);
    await jj(repo, ['bookmark', 'create', 'main', '-r', '@-']);
    await writeRepoFile(repo, 'b.txt', 'two\n');
    await jj(repo, ['commit', '-m', 'second commit']);
    await writeRepoFile(repo, 'c.txt', 'three\n');

    const state = await readRepositoryState(repo, { ref: 'main', type: 'branch' });
    expect(state.files.map((file) => file.path).sort()).toEqual(['b.txt', 'c.txt']);
  });
});

testWithJujutsu('listRepositoryHistory walks jj commits and labels the working copy', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'first commit']);
    await writeRepoFile(repo, 'a.txt', 'one\ntwo\n');

    const history = await listRepositoryHistory(repo, 10);
    expect(history.entries.map((entry) => entry.subject)).toEqual([
      '(no description set)',
      'first commit',
    ]);
  });
});

testWithJujutsu('readWalkthroughRepositoryState falls back to the latest commit', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'first commit']);

    const state = await readWalkthroughRepositoryState(repo);
    expect(state.source.type).toBe('commit');
    expect(state.files.map((file) => file.path)).toEqual(['a.txt']);
  });
});

testWithJujutsu('readRepositoryChangeSignature tracks jj working-copy changes', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'initial commit']);

    const clean = await readRepositoryChangeSignature(repo);
    expect(clean.root).toBe(repo);
    expect(await readRepositoryChangeSignature(repo)).toEqual(clean);

    await writeRepoFile(repo, 'a.txt', 'one\ntwo\n');
    const edited = await readRepositoryChangeSignature(repo);
    expect(edited.signature).not.toBe(clean.signature);

    await jj(repo, ['commit', '-m', 'second commit']);
    const committed = await readRepositoryChangeSignature(repo);
    expect(committed.signature).not.toBe(edited.signature);
    expect(committed.head).not.toBe(edited.head);
  });
});

testWithJujutsu('createWalkthroughCommit commits selected paths with jj', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'initial commit']);
    await writeRepoFile(repo, 'a.txt', 'one\nmore\n');
    await writeRepoFile(repo, 'keep.txt', 'stays uncommitted\n');

    const result = await createWalkthroughCommit(repo, {
      body: 'Commit body.',
      paths: ['a.txt'],
      subject: 'Update a.txt',
    });
    expect(result.status).toBe('committed');
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);

    const committed = await readRepositoryState(repo, { ref: '@-', type: 'commit' });
    expect(committed.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(committed.commitMetadata?.subject).toBe('Update a.txt');

    const remaining = await readWorkingTreeState(repo, { eagerContents: false });
    expect(remaining.files.map((file) => file.path)).toEqual(['keep.txt']);
  });
});

testWithJujutsu('readGitIdentity reads the configured jj identity', async () => {
  await withJujutsuRepo(async (repo) => {
    const identity = await readGitIdentity(repo);
    expect(identity).toMatchObject({
      email: 'codiff@example.com',
      name: 'Codiff Test',
    });
    expect(identity.gravatarUrl).toContain('gravatar.com');
  });
});

testWithJujutsu('jj repositories without a colocated .git directory work end to end', async () => {
  await withJujutsuRepo(
    async (repo) => {
      expect(existsSync(join(repo, '.git'))).toBe(false);

      await writeRepoFile(repo, 'a.txt', 'one\n');
      await jj(repo, ['commit', '-m', 'first commit']);
      await writeRepoFile(repo, 'a.txt', 'one\ntwo\n');

      const state = await readWorkingTreeState(repo, { eagerContents: false });
      expect(state.root).toBe(repo);
      expect(state.files.map((file) => file.path)).toEqual(['a.txt']);
      expect(state.files[0].sections[0].patch).toContain('+two');

      const commitState = await readRepositoryState(repo, { ref: '@-', type: 'commit' });
      expect(commitState.files.map((file) => file.path)).toEqual(['a.txt']);
      expect(commitState.commitMetadata?.subject).toBe('first commit');

      const result = await createWalkthroughCommit(repo, {
        paths: ['a.txt'],
        subject: 'Second commit',
      });
      expect(result.status).toBe('committed');

      const history = await listRepositoryHistory(repo, 10);
      expect(history.entries.map((entry) => entry.subject)).toEqual([
        'Second commit',
        'first commit',
      ]);
    },
    { colocate: false },
  );
});

testWithJujutsu('readRepositoryState reviews jj ranges', async () => {
  await withJujutsuRepo(async (repo) => {
    await writeRepoFile(repo, 'a.txt', 'one\n');
    await jj(repo, ['commit', '-m', 'initial commit']);
    await jj(repo, ['bookmark', 'create', 'main', '-r', '@-']);
    await writeRepoFile(repo, 'b.txt', 'two\n');
    await jj(repo, ['commit', '-m', 'second commit']);

    const state = await readRepositoryState(repo, {
      base: 'main',
      head: '@-',
      symmetric: false,
      type: 'range',
    });
    expect(state.files.map((file) => file.path)).toEqual(['b.txt']);
  });
});
