export const REPORT_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    in_depth_report: {
      type: 'string',
      description: 'A very detailed description of everything found in the directory: the researcher\'s identity, their research areas, projects, file organization, tools and languages used, datasets, publications, and any other notable observations. Be thorough and specific.',
    },
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
  },
  required: ['in_depth_report', 'about_you_summary', 'what_youre_working_on_summary', 'what_youre_working_on'],
};
