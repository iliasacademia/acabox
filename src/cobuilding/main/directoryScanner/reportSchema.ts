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
      maxItems: 3,
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
      description: 'Up to 3 files the researcher is currently working on, each with a suggested next action. Prioritize manuscripts, lab meeting presentations, and grant proposals. Fall back to code scripts or data files only if none of those are found.',
    },
    tagged_files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative path to the file from the workspace root.',
          },
          file_name: {
            type: 'string',
            description: 'The filename only (basename, including extension).',
          },
          file_type: {
            type: 'string',
            enum: ['manuscript', 'grant', 'presentation'],
            description: 'manuscript = academic paper/thesis/chapter (.tex, .docx, .md); grant = grant proposal/funding application; presentation = slides/talk (.pptx, .key).',
          },
        },
        required: ['file_path', 'file_name', 'file_type'],
      },
      description: 'All manuscript, grant, and presentation files found in the directory. Include every file that clearly belongs to one of these three categories — this list populates file pickers in writing tools.',
    },
  },
  required: ['about_you_summary', 'what_youre_working_on_summary', 'what_youre_working_on', 'tagged_files'],
};
