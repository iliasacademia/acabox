export const REPORT_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    about_you_summary: {
      type: 'string',
      description: 'A concise summary of the researcher (2-4 paragraphs). Covers who they are, what field(s) they work in, their key research interests, and what characterizes their work. Written in second person ("You are...") so it reads naturally when shown to the researcher.',
    },
    what_youre_working_on_summary: {
      type: 'string',
      description: 'A summary of what the researcher is currently working on (2-4 paragraphs). Describes their active projects, recent focus areas, and what they seem to be in the middle of. Written in second person ("You have been...") so it reads naturally when shown to the researcher.',
    },
    what_youre_working_on: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative path to a file the researcher has been actively working on recently.',
          },
          description: {
            type: 'string',
            description: 'A short description of what the user might want to do next with this file (e.g. "Continue drafting the methods section", "Review referee comments and revise", "Debug the data processing pipeline").',
          },
        },
        required: ['file_path', 'description'],
      },
      description: 'A list of files the researcher is currently working on (based on recent modification times), each with a suggested next action. Focus on the most recently modified and most important files.',
    },
    suggested_mini_apps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short display name for the suggested mini-app (e.g. "Expression Data Explorer", "Paper Summarizer", "Correlation Dashboard").',
          },
          why_im_suggesting_this: {
            type: 'string',
            description: 'A 1-2 sentence explanation tying this suggestion to specific files or patterns found in the researcher\'s directory.',
          },
          details_on_what_to_build: {
            type: 'string',
            description: 'Actionable build instruction sent directly to the app builder. Reference specific files or patterns from the scan, describe what the app loads and displays, and mention chart types or interactions. 2-4 sentences.',
          },
        },
        required: ['name', 'why_im_suggesting_this', 'details_on_what_to_build'],
      },
      description: 'A list of 2-5 suggested mini-apps tailored to the researcher\'s files. Prioritize React-only apps (data explorers, chart generators, AI text analyzers, data transformers, statistical dashboards) that build fast and need no backend kernel.',
    },
  },
  required: ['about_you_summary', 'what_youre_working_on_summary', 'what_youre_working_on', 'suggested_mini_apps'],
};
