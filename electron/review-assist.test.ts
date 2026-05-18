import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { buildReviewAssistantInput, normalizeReviewAssistantReply } =
  require('./review-assist.cjs') as {
    buildReviewAssistantInput: (
      state: unknown,
      request: unknown,
    ) => {
      comment: {
        body: string;
        filePath: string;
        lineNumber: number;
        side: string;
      };
      focus: {
        patchExcerpt: string;
      } | null;
      walkthroughNote: unknown;
    };
    normalizeReviewAssistantReply: (input: unknown) => {
      reply: string;
      version: 1;
    };
  };

test('builds focused inline review assistant context', () => {
  const input = buildReviewAssistantInput(
    {
      files: [
        {
          path: 'src/state.ts',
          sections: [
            {
              binary: false,
              id: 'src/state.ts:unstaged',
              kind: 'unstaged',
              patch: '+const duplicated = true;',
              summary: {
                reason: 'State handling changed.',
              },
            },
          ],
          status: 'modified',
        },
      ],
      root: '/repo',
      source: {
        type: 'working-tree',
      },
    },
    {
      comment: {
        body: 'this feels risky, why is this needed?',
        filePath: 'src/state.ts',
        lineNumber: 1,
        sectionId: 'src/state.ts:unstaged',
        side: 'additions',
      },
      walkthroughNote: {
        action: 'review',
        context: 'Check whether state stays synchronized.',
        groupReason: 'Shared state first.',
        groupTitle: 'Review carefully',
        impact: 'wide',
        reason: 'State contract affects multiple paths.',
      },
    },
  );

  expect(input.comment.body).toBe('this feels risky, why is this needed?');
  expect(input.focus?.patchExcerpt).toContain('+const duplicated = true;');
  expect(input.walkthroughNote).toMatchObject({
    context: 'Check whether state stays synchronized.',
  });
});

test('normalizes review assistant markdown without flattening it', () => {
  expect(
    normalizeReviewAssistantReply({
      reply: 'Likely reason:\n\n- Keep state local\n\nSuggested comment: **Why here?**',
      version: 1,
    }),
  ).toEqual({
    reply: 'Likely reason:\n\n- Keep state local\n\nSuggested comment: **Why here?**',
    version: 1,
  });
});
