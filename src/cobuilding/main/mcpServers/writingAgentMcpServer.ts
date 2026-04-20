import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  listProjects,
  listProjectFiles,
  listConversations,
  listConversationMessages,
  listSupportingFiles,
} from '../db/writingAgentRepository';

export function createWritingAgentMcpServer(workspaceId: string) {
  return createSdkMcpServer({
    name: 'writing-agent',
    tools: [
      tool(
        'list_projects',
        'List all writing projects for the current workspace. Returns project names, descriptions, file counts, and metadata.',
        {},
        async () => {
          try {
            const projects = listProjects(workspaceId);
            if (projects.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No writing projects found. The user may need to link their Writing Agent account and sync via the Writing sidebar.' }],
              };
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(projects, null, 2) }],
            };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: `Error listing projects: ${err}` }] };
          }
        },
      ),

      tool(
        'get_project_files',
        'Get the manuscripts and files within a specific writing project. Returns file names, types, sizes, and whether each is the primary manuscript.',
        {
          project_id: z.number().describe('The project ID to get files for'),
        },
        async (args) => {
          try {
            const files = listProjectFiles(args.project_id);
            if (files.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No files found for this project.' }],
              };
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(files, null, 2) }],
            };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: `Error getting project files: ${err}` }] };
          }
        },
      ),

      tool(
        'list_conversations',
        'List past writing agent conversations for a specific project. Returns conversation titles, summaries, and agent names.',
        {
          project_id: z.number().describe('The project ID to list conversations for'),
        },
        async (args) => {
          try {
            const conversations = listConversations(args.project_id);
            if (conversations.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No conversations found for this project.' }],
              };
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(conversations, null, 2) }],
            };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: `Error listing conversations: ${err}` }] };
          }
        },
      ),

      tool(
        'get_conversation_messages',
        'Get the full message history of a past writing agent conversation. Useful for understanding prior feedback, suggestions, and discussion about a manuscript.',
        {
          conversation_id: z.number().describe('The conversation ID to get messages for'),
        },
        async (args) => {
          try {
            const messages = listConversationMessages(args.conversation_id);
            if (messages.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No messages found for this conversation.' }],
              };
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
            };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: `Error getting conversation messages: ${err}` }] };
          }
        },
      ),

      tool(
        'list_supporting_files',
        'List supporting/reference files (research papers, notes, references) available in the workspace. These are user-level files shared across projects.',
        {},
        async () => {
          try {
            const files = listSupportingFiles(workspaceId);
            if (files.length === 0) {
              return {
                content: [{ type: 'text' as const, text: 'No supporting files found.' }],
              };
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(files, null, 2) }],
            };
          } catch (err) {
            return { isError: true, content: [{ type: 'text' as const, text: `Error listing supporting files: ${err}` }] };
          }
        },
      ),
    ],
  });
}
