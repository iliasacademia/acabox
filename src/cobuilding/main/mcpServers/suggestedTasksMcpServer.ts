import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  createBriefing,
  getBriefingById,
  listBriefings,
  updateBriefing,
  deleteBriefing,
  reorderBriefings,
} from '../db/briefingsRepository';
import type { BriefingStatus, SuggestionType } from '../db/briefingsRepository';
import { SUGGESTED_TASKS_TOOL_DEFS } from '../../shared/suggestedTasksTools';

export interface SuggestedTasksContext {
  workspaceId: string;
  sourceReportId?: string;
  onBriefingsChanged?: () => void;
}

export function createSuggestedTasksMcpServer(
  ctx: SuggestedTasksContext,
  mode: 'create-only' | 'full' = 'create-only',
) {
  const d = SUGGESTED_TASKS_TOOL_DEFS;
  const createTool = tool('create_suggestion', d.create_suggestion.description, d.create_suggestion.schema,
    async (args) => handleCreateSuggestion(args, ctx),
  );

  if (mode === 'create-only') {
    return createSdkMcpServer({ name: 'suggested-tasks', tools: [createTool] });
  }

  return createSdkMcpServer({
    name: 'suggested-tasks',
    tools: [
      createTool,
      tool('list_suggestions', d.list_suggestions.description, d.list_suggestions.schema,
        async (args) => handleListSuggestions(args, ctx)),
      tool('update_suggestion', d.update_suggestion.description, d.update_suggestion.schema,
        async (args) => handleUpdateSuggestion(args, ctx)),
      tool('reorder_suggestions', d.reorder_suggestions.description, d.reorder_suggestions.schema,
        async (args) => handleReorderSuggestions(args, ctx)),
      tool('delete_suggestion', d.delete_suggestion.description, d.delete_suggestion.schema,
        async (args) => handleDeleteSuggestion(args, ctx)),
    ],
  });
}

export async function handleCreateSuggestion(
  args: { name: string; type: 'one_time_task' | 'mini_app'; description: string; why_im_suggesting_this?: string },
  ctx: SuggestedTasksContext,
) {
  const isMiniApp = args.type === 'mini_app';
  const briefingType = isMiniApp ? 'suggested_tool' as const : 'suggested_action' as const;
  const briefingData = isMiniApp
    ? { name: args.name, details_on_what_to_build: args.description }
    : { title: args.name, description: args.description, chat_prompt: args.description };

  const id = createBriefing({
    workspaceId: ctx.workspaceId,
    type: briefingType,
    sourceReportId: ctx.sourceReportId ?? null,
    briefingData,
    whyImSuggestingThis: args.why_im_suggesting_this ?? null,
  });
  ctx.onBriefingsChanged?.();

  return { content: [{ type: 'text' as const, text: JSON.stringify({ id, type: briefingType }) }] };
}

const SUGGESTION_TYPES: SuggestionType[] = ['suggested_action', 'suggested_tool'];

export async function handleListSuggestions(
  args: { status?: BriefingStatus[] },
  ctx: SuggestedTasksContext,
) {
  const suggestions = listBriefings(ctx.workspaceId, {
    ...(args.status ? { status: args.status } : {}),
    type: SUGGESTION_TYPES,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify({ suggestions, count: suggestions.length }) }] };
}

export async function handleUpdateSuggestion(
  args: { id: string; name?: string; type?: 'one_time_task' | 'mini_app'; description?: string; why_im_suggesting_this?: string },
  ctx: SuggestedTasksContext,
) {
  const row = getBriefingById(args.id);
  if (!row || row.workspace_id !== ctx.workspaceId || !SUGGESTION_TYPES.includes(row.type as SuggestionType)) {
    return { content: [{ type: 'text' as const, text: `Suggestion not found: ${args.id}` }], isError: true };
  }

  const existing = JSON.parse(row.briefing_data);
  let newType: SuggestionType = row.type as SuggestionType;
  if (args.type) {
    newType = args.type === 'mini_app' ? 'suggested_tool' : 'suggested_action';
  }

  let newData: Record<string, string>;
  if (newType === 'suggested_tool') {
    newData = {
      name: args.name ?? existing.name ?? existing.title ?? '',
      details_on_what_to_build: args.description ?? existing.details_on_what_to_build ?? existing.description ?? '',
    };
  } else {
    const desc = args.description ?? existing.description ?? existing.details_on_what_to_build ?? '';
    newData = {
      title: args.name ?? existing.title ?? existing.name ?? '',
      description: desc,
      chat_prompt: desc,
    };
  }

  updateBriefing(args.id, {
    briefingData: newData,
    whyImSuggestingThis: args.why_im_suggesting_this !== undefined ? args.why_im_suggesting_this : undefined,
    type: newType !== row.type ? newType : undefined,
  });
  ctx.onBriefingsChanged?.();

  return { content: [{ type: 'text' as const, text: JSON.stringify({ updated: true, id: args.id }) }] };
}

export async function handleReorderSuggestions(
  args: { ordered_ids: string[] },
  ctx: SuggestedTasksContext,
) {
  reorderBriefings(ctx.workspaceId, args.ordered_ids);
  ctx.onBriefingsChanged?.();
  return { content: [{ type: 'text' as const, text: JSON.stringify({ reordered: true, count: args.ordered_ids.length }) }] };
}

export async function handleDeleteSuggestion(
  args: { id: string },
  ctx: SuggestedTasksContext,
) {
  const deleted = deleteBriefing(args.id, ctx.workspaceId);
  if (!deleted) {
    return { content: [{ type: 'text' as const, text: `Suggestion not found or not a suggestion type: ${args.id}` }], isError: true };
  }
  ctx.onBriefingsChanged?.();
  return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, id: args.id }) }] };
}
