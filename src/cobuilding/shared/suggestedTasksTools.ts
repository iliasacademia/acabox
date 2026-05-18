import { z } from 'zod';

export const SUGGESTED_TASKS_TOOL_DEFS = {
  create_suggestion: {
    description: 'Create a new task suggestion for the researcher. Call this once per suggestion.',
    schema: {
      name: z.string().describe('Short display title.'),
      type: z.enum(['one_time_task', 'mini_app']).describe('Whether this is a one-time task or an interactive mini-app to build.'),
      description: z.string().describe('Clear, actionable description of what to do. Reference specific files or patterns. 2-4 sentences.'),
      why_im_suggesting_this: z.string().optional().describe('1-2 sentences tying this suggestion to specific files or patterns found in the workspace.'),
    },
  },
  list_suggestions: {
    description: 'List current task suggestions shown to the user on their Home tab. Returns suggestions ordered by display priority.',
    schema: {
      status: z.array(z.enum(['new', 'opened', 'dismissed'])).optional()
        .describe('Filter by status. Omit to return all suggestions.'),
    },
  },
  update_suggestion: {
    description: 'Update an existing task suggestion. Only the provided fields are changed.',
    schema: {
      id: z.string().describe('The suggestion ID to update.'),
      name: z.string().optional().describe('New display title.'),
      type: z.enum(['one_time_task', 'mini_app']).optional().describe('New suggestion type.'),
      description: z.string().optional().describe('New description.'),
      why_im_suggesting_this: z.string().optional().describe('New rationale.'),
    },
  },
  reorder_suggestions: {
    description: 'Set the display order of suggestions. Pass suggestion IDs in desired order. Unlisted suggestions sort after the listed ones.',
    schema: {
      ordered_ids: z.array(z.string()).min(1).describe('Suggestion IDs in desired display order.'),
    },
  },
  delete_suggestion: {
    description: "Remove a task suggestion from the user's Home tab.",
    schema: {
      id: z.string().describe('The suggestion ID to delete.'),
    },
  },
} as const;
