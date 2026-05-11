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
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short display name for the suggestion (e.g. "Summarize review comments", "Expression Data Explorer").',
          },
          type: {
            type: 'string',
            enum: ['one_time_task', 'mini_app'],
            description: 'Whether this is a one-time task or an interactive mini-app to build.',
          },
          why_im_suggesting_this: {
            type: 'string',
            description: 'A 1-2 sentence explanation tying this suggestion to specific files or patterns found in the researcher\'s directory.',
          },
          description: {
            type: 'string',
            description: 'A clear, actionable description of what to do. Reference specific files or patterns from the scan. 2-4 sentences.',
          },
        },
        required: ['name', 'type', 'why_im_suggesting_this', 'description'],
      },
      description: 'Suggestions that would significantly expedite the researcher\'s work. Can be one-time tasks (summarizing, synthesizing, converting, analyzing) or interactive mini-apps (data explorers, dashboards, chart generators). Include as many as are genuinely useful.',
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
            description: 'manuscript = academic paper, thesis, chapter, or dissertation (.tex, .docx, .md). grant = grant proposal, funding application, NIH/NSF/R01 submission. presentation = .pptx, .key, talks, slides, lab-meeting files.',
          },
        },
        required: ['file_path', 'file_name', 'file_type'],
      },
      description: 'All manuscript, grant, and presentation files found in the directory. This list populates file pickers in writing tools.',
    },
  },
  required: ['about_you_summary', 'what_youre_working_on_summary', 'suggestions', 'tagged_files'],
};
