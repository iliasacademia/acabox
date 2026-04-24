import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import log from 'electron-log';
import path from 'path';
import fs from 'fs';
import { createSession, insertMessage, getMessages } from './db/chatRepository';
import type { ChatCallbacks, AgentSession } from './agentSession';
import type { ChatStreamMessage, CalendarPlan, CalendarEvent, EventDependency, CascadeUpdate } from '../shared/types';
import * as cal from './db/calendarRepository';
import * as dep from './db/dependencyRepository';
import * as res from './db/resourceRepository';

export type CalendarMutationEvent =
  | { type: 'plan-created';       plan: CalendarPlan }
  | { type: 'plan-updated';       plan: CalendarPlan }
  | { type: 'plan-deleted';       planId: string }
  | { type: 'event-created';      event: CalendarEvent }
  | { type: 'event-updated';      event: CalendarEvent }
  | { type: 'event-deleted';      eventId: string }
  | { type: 'event-moved';        moved: CalendarEvent; cascaded: CascadeUpdate[] }
  | { type: 'dependency-created'; dependency: EventDependency }
  | { type: 'dependency-updated'; dependency: EventDependency }
  | { type: 'dependency-deleted'; dependencyId: string };

const CALENDAR_SESSION_SOURCE = 'calendar-assistant';

const CALENDAR_TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_plans',
    description: 'List all calendar plans (project containers) in the workspace.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_events',
    description: 'List calendar events, optionally filtered by date range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO 8601 start of range (inclusive).' },
        to: { type: 'string', description: 'ISO 8601 end of range (inclusive).' },
      },
      required: [],
    },
  },
  {
    name: 'list_dependencies',
    description: 'List all event dependencies (finish-to-start constraints) in the workspace.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_plan',
    description: 'Create a new plan (project container). Plans group related events together.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the plan.' },
        color: { type: 'string', description: 'Hex color code (e.g. "#4A90D9"). Defaults to a blue-grey if omitted.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Event name/title.' },
        start_at: { type: 'string', description: 'ISO 8601 start datetime (e.g. "2026-04-25T09:00:00.000Z").' },
        end_at: { type: 'string', description: 'ISO 8601 end datetime.' },
        plan_id: { type: 'string', description: 'ID of the plan this event belongs to. Omit for unplanned events.' },
        color: { type: 'string', description: 'Hex color override. If omitted, inherits from plan or uses a default.' },
        status: { type: 'string', enum: ['active', 'inactive', 'inactive_hidden'], description: 'Event status. "active" shows normally; "inactive" renders as a background lane. Defaults to "active".' },
        recurrence_rule: { type: 'string', description: 'iCal RRULE string for recurring events (e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO"). Omit for one-time events.' },
      },
      required: ['name', 'start_at', 'end_at'],
    },
  },
  {
    name: 'create_dependency',
    description: 'Create a finish-to-start dependency between two events. The successor will be scheduled after the predecessor ends. Returns {error: "cycle"} if this would create a circular chain.',
    input_schema: {
      type: 'object',
      properties: {
        predecessor_id: { type: 'string', description: 'ID of the event that must finish first.' },
        successor_id: { type: 'string', description: 'ID of the event that starts after.' },
        lag_min_minutes: { type: 'number', description: 'Minimum buffer between predecessor end and successor start (minutes). Default 0.' },
        lag_max_minutes: { type: 'number', description: 'Maximum allowed lag (minutes). Omit for no maximum.' },
      },
      required: ['predecessor_id', 'successor_id'],
    },
  },
  {
    name: 'update_plan',
    description: "Update a plan's name or color.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plan ID.' },
        name: { type: 'string', description: 'New name.' },
        color: { type: 'string', description: 'New hex color.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_event',
    description: 'Update properties of an event.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID.' },
        name: { type: 'string', description: 'New name.' },
        start_at: { type: 'string', description: 'New start ISO 8601 datetime.' },
        end_at: { type: 'string', description: 'New end ISO 8601 datetime.' },
        plan_id: { type: ['string', 'null'], description: 'New plan ID, or null to unplan the event.' },
        color: { type: ['string', 'null'], description: 'New hex color, or null to clear.' },
        status: { type: 'string', enum: ['active', 'inactive', 'inactive_hidden'], description: 'Event status.' },
        recurrence_rule: { type: ['string', 'null'], description: 'New iCal RRULE string, or null to remove recurrence.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_dependency',
    description: "Update a dependency's buffer timing.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dependency ID.' },
        lag_min_minutes: { type: 'number', description: 'New minimum lag (minutes).' },
        lag_max_minutes: { type: ['number', 'null'], description: 'New maximum lag (minutes), or null to remove the cap.' },
        lag_current_minutes: { type: 'number', description: 'New current lag (minutes). Must be >= min.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_plan',
    description: 'Delete a plan. By default, events in the plan become unplanned. Set delete_events=true to also delete all events in the plan.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Plan ID.' },
        delete_events: { type: 'boolean', description: 'If true, delete all events in this plan. Default false (events become unplanned).' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_event',
    description: 'Permanently delete an event.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_dependency',
    description: 'Remove a dependency constraint between two events.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dependency ID.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'move_event',
    description: 'Move an event to a new time slot and automatically cascade-reschedule all dependent successors.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Event ID to move.' },
        new_start_at: { type: 'string', description: 'New start ISO 8601 datetime.' },
        new_end_at: { type: 'string', description: 'New end ISO 8601 datetime.' },
      },
      required: ['id', 'new_start_at', 'new_end_at'],
    },
  },
  {
    name: 'list_resources',
    description: 'List files, links, notes, and folders attached to the calendar. Filter by plan_id, event_id, or get all.',
    input_schema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'Filter to resources attached to this plan.' },
        event_id: { type: 'string', description: 'Filter to resources attached to this event.' },
        standalone: { type: 'boolean', description: 'If true, return only unattached (floating) resources.' },
      },
      required: [],
    },
  },
  {
    name: 'list_workspace_files',
    description: 'List files in the user\'s workspace directory (2 levels deep). Use this to discover files you can attach to plans or events.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_resource',
    description: 'Attach a file, link, or note to a plan, event, or leave it floating.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['file', 'link', 'note'], description: 'Resource type.' },
        plan_id: { type: 'string', description: 'Plan to attach to. Omit for event-only or floating.' },
        event_id: { type: 'string', description: 'Event to attach to. Omit for plan-level or floating.' },
        parent_id: { type: 'string', description: 'Parent folder ID for nesting. Omit for top-level.' },
        file_path: { type: 'string', description: 'Absolute path to file (required for type=file).' },
        url: { type: 'string', description: 'URL (required for type=link).' },
        note_content: { type: 'string', description: 'Markdown text (required for type=note).' },
        title: { type: 'string', description: 'Display name. Defaults to filename or URL if omitted.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a folder to organize resources under a plan or event.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Folder name.' },
        plan_id: { type: 'string', description: 'Plan to nest the folder under.' },
        event_id: { type: 'string', description: 'Event to nest the folder under.' },
        parent_id: { type: 'string', description: 'Parent folder ID for nested folders.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'move_resource',
    description: 'Move a resource to a different plan, event, or folder, or reorganize its position.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Resource ID.' },
        plan_id: { type: ['string', 'null'], description: 'New plan ID, or null to unattach from plan.' },
        event_id: { type: ['string', 'null'], description: 'New event ID, or null to unattach from event.' },
        parent_id: { type: ['string', 'null'], description: 'New parent folder ID, or null for top-level.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'attach_workspace_file',
    description: 'Attach a file from the workspace directory to a plan or event. The path should be relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        relative_path: { type: 'string', description: 'File path relative to workspace root (e.g. "data/report.csv").' },
        plan_id: { type: 'string', description: 'Plan to attach to.' },
        event_id: { type: 'string', description: 'Event to attach to.' },
        title: { type: 'string', description: 'Display name. Defaults to filename.' },
      },
      required: ['relative_path'],
    },
  },
];

function buildSystemPrompt(): string {
  return `You are a calendar assistant for Academia, a research workspace tool. Today is ${new Date().toISOString().split('T')[0]}.

You help users manage plans, events, task dependencies, and attached resources (files, links, notes, folders) on their calendar. Plans are project containers (name + color) that group related events. Events have a name, start/end time (ISO 8601), optional plan, and status. Dependencies are finish-to-start constraints. Resources are files, URLs, markdown notes, or folders that can be attached to plans or events to help organize related materials.

Use your tools immediately when the user asks for changes. Do not describe what you are about to do — act, then summarize briefly. When moving an event cascades downstream changes, mention what shifted.

When the user says "tomorrow", "next Monday", etc., resolve relative to today's date. Use UTC timestamps unless the user specifies a timezone.

When attaching workspace files, use list_workspace_files first to discover available files, then use attach_workspace_file with the relative path.`;
}

function reconstructHistory(sessionId: string): MessageParam[] {
  const messages = getMessages(sessionId);
  const history: MessageParam[] = [];

  for (const msg of messages) {
    try {
      if (msg.type === 'user') {
        const parsed = JSON.parse(msg.content) as { text: string };
        history.push({ role: 'user', content: parsed.text });
      } else if (msg.type === 'assistant') {
        const blocks = JSON.parse(msg.content);
        history.push({ role: 'assistant', content: blocks });
      } else if (msg.type === 'tool_result') {
        const results = JSON.parse(msg.content);
        history.push({ role: 'user', content: results });
      }
      // skip 'result' and other types
    } catch {
      // skip malformed entries
    }
  }

  // Trim trailing user-role entry to avoid dangling incomplete turns
  // (can happen if the session was interrupted mid-flight)
  if (history.length > 0 && history[history.length - 1].role === 'user') {
    history.pop();
  }

  return history;
}

async function executeCalendarTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceId: string,
  workspaceDir: string,
  onMutation: (m: CalendarMutationEvent) => void,
): Promise<{ content: unknown; isError: boolean }> {
  try {
    switch (toolName) {
      case 'list_plans':
        return { content: cal.listPlans(workspaceId), isError: false };

      case 'list_events': {
        const from = toolInput.from as string | undefined;
        const to = toolInput.to as string | undefined;
        return { content: cal.listEvents(workspaceId, { from, to }), isError: false };
      }

      case 'list_dependencies':
        return { content: dep.listDependenciesByWorkspace(workspaceId), isError: false };

      case 'create_plan': {
        const plan = cal.createPlan(workspaceId, {
          name: toolInput.name as string,
          color: (toolInput.color as string | undefined) ?? '#4A90D9',
        });
        onMutation({ type: 'plan-created', plan });
        return { content: plan, isError: false };
      }

      case 'create_event': {
        const planId = (toolInput.plan_id as string | undefined) ?? null;
        const explicitColor = (toolInput.color as string | undefined) ?? null;
        const planColor = planId && !explicitColor ? (cal.getPlan(planId)?.color ?? null) : null;
        const event = cal.createEvent(workspaceId, {
          name: toolInput.name as string,
          start_at: toolInput.start_at as string,
          end_at: toolInput.end_at as string,
          plan_id: planId,
          color: explicitColor ?? planColor,
          status: (toolInput.status as 'active' | 'inactive' | 'inactive_hidden' | undefined) ?? 'active',
          recurrence_rule: (toolInput.recurrence_rule as string | undefined) ?? null,
        });
        onMutation({ type: 'event-created', event });
        return { content: event, isError: false };
      }

      case 'create_dependency': {
        const predecessorId = toolInput.predecessor_id as string;
        const successorId = toolInput.successor_id as string;
        if (dep.hasCycle(predecessorId, successorId)) {
          return { content: { error: 'cycle' }, isError: false };
        }
        const lagMinMs = ((toolInput.lag_min_minutes as number | undefined) ?? 0) * 60000;
        const lagMaxMs = toolInput.lag_max_minutes != null
          ? (toolInput.lag_max_minutes as number) * 60000
          : null;
        const dependency = dep.createDependency({
          predecessor_id: predecessorId,
          successor_id: successorId,
          lag_min_ms: lagMinMs,
          ...(lagMaxMs != null ? { lag_max_ms: lagMaxMs } : {}),
        });
        onMutation({ type: 'dependency-created', dependency });
        return { content: dependency, isError: false };
      }

      case 'update_plan': {
        const updated = cal.updatePlan(toolInput.id as string, {
          ...(toolInput.name !== undefined ? { name: toolInput.name as string } : {}),
          ...(toolInput.color !== undefined ? { color: toolInput.color as string } : {}),
        });
        if (updated) onMutation({ type: 'plan-updated', plan: updated });
        return { content: updated, isError: false };
      }

      case 'update_event': {
        const updateData: Record<string, unknown> = {};
        if (toolInput.name !== undefined) updateData.name = toolInput.name;
        if (toolInput.start_at !== undefined) updateData.start_at = toolInput.start_at;
        if (toolInput.end_at !== undefined) updateData.end_at = toolInput.end_at;
        if ('plan_id' in toolInput) {
          updateData.plan_id = toolInput.plan_id ?? null;
          // Inherit plan color unless caller explicitly provided a color
          if (toolInput.plan_id && !('color' in toolInput)) {
            const plan = cal.getPlan(toolInput.plan_id as string);
            if (plan) updateData.color = plan.color;
          }
        }
        if ('color' in toolInput) updateData.color = toolInput.color ?? null;
        if (toolInput.status !== undefined) updateData.status = toolInput.status;
        if ('recurrence_rule' in toolInput) updateData.recurrence_rule = toolInput.recurrence_rule ?? null;
        const updated = cal.updateEvent(toolInput.id as string, updateData as Parameters<typeof cal.updateEvent>[1]);
        if (updated) onMutation({ type: 'event-updated', event: updated });
        return { content: updated, isError: false };
      }

      case 'update_dependency': {
        const data: Record<string, unknown> = {};
        if (toolInput.lag_min_minutes !== undefined)
          data.lag_min_ms = (toolInput.lag_min_minutes as number) * 60000;
        if ('lag_max_minutes' in toolInput)
          data.lag_max_ms = toolInput.lag_max_minutes != null
            ? (toolInput.lag_max_minutes as number) * 60000
            : null;
        if (toolInput.lag_current_minutes !== undefined)
          data.lag_current_ms = (toolInput.lag_current_minutes as number) * 60000;
        const updated = dep.updateDependency(toolInput.id as string, data as Parameters<typeof dep.updateDependency>[1]);
        if (updated) onMutation({ type: 'dependency-updated', dependency: updated });
        return { content: updated, isError: false };
      }

      case 'delete_plan': {
        const planId = toolInput.id as string;
        const deleteEvents = (toolInput.delete_events as boolean | undefined) ?? false;
        if (deleteEvents) {
          const events = cal.listEvents(workspaceId, { planId });
          for (const event of events) {
            cal.deleteEvent(event.id);
            onMutation({ type: 'event-deleted', eventId: event.id });
          }
        }
        // ON DELETE SET NULL handles plan_id FK automatically when not deleteEvents
        cal.deletePlan(planId);
        onMutation({ type: 'plan-deleted', planId });
        return { content: { success: true }, isError: false };
      }

      case 'delete_event': {
        const eventId = toolInput.id as string;
        cal.deleteEvent(eventId);
        onMutation({ type: 'event-deleted', eventId });
        return { content: { success: true }, isError: false };
      }

      case 'delete_dependency': {
        const dependencyId = toolInput.id as string;
        dep.deleteDependency(dependencyId);
        onMutation({ type: 'dependency-deleted', dependencyId });
        return { content: { success: true }, isError: false };
      }

      case 'move_event': {
        const eventId = toolInput.id as string;
        const newStartAt = toolInput.new_start_at as string;
        const newEndAt = toolInput.new_end_at as string;
        cal.updateEvent(eventId, { start_at: newStartAt, end_at: newEndAt });
        const cascaded = dep.applyCascade(eventId);
        const moved = cal.getEvent(eventId)!;
        onMutation({ type: 'event-moved', moved, cascaded });
        return { content: { moved, cascaded }, isError: false };
      }

      case 'list_resources': {
        const opts: Record<string, unknown> = {};
        if (toolInput.plan_id) opts.plan_id = toolInput.plan_id;
        if (toolInput.event_id) opts.event_id = toolInput.event_id;
        if (toolInput.standalone) opts.standalone = true;
        return { content: res.listResources(workspaceId, opts as Parameters<typeof res.listResources>[1]), isError: false };
      }

      case 'list_workspace_files': {
        function walkDir(dir: string, depth: number): Array<{ name: string; path: string; isDir: boolean }> {
          const results: Array<{ name: string; path: string; isDir: boolean }> = [];
          const excluded = new Set(['.git', 'node_modules', '.DS_Store', '.applications', '.academia']);
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
          catch { return results; }
          for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.') continue;
            if (excluded.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            const isDir = entry.isDirectory();
            results.push({ name: entry.name, path: fullPath, isDir });
            if (isDir && depth < 2) results.push(...walkDir(fullPath, depth + 1));
          }
          return results;
        }
        return { content: walkDir(workspaceDir, 1), isError: false };
      }

      case 'create_resource': {
        const type = toolInput.type as 'file' | 'link' | 'note';
        const created = res.createResource(workspaceId, {
          type,
          plan_id: (toolInput.plan_id as string | undefined) ?? null,
          event_id: (toolInput.event_id as string | undefined) ?? null,
          parent_id: (toolInput.parent_id as string | undefined) ?? null,
          file_path: (toolInput.file_path as string | undefined) ?? null,
          url: (toolInput.url as string | undefined) ?? null,
          note_content: (toolInput.note_content as string | undefined) ?? null,
          title: (toolInput.title as string | undefined) ?? '',
          ai_generated: true,
        });
        return { content: created, isError: false };
      }

      case 'create_folder': {
        const created = res.createResource(workspaceId, {
          type: 'folder',
          plan_id: (toolInput.plan_id as string | undefined) ?? null,
          event_id: (toolInput.event_id as string | undefined) ?? null,
          parent_id: (toolInput.parent_id as string | undefined) ?? null,
          title: toolInput.title as string,
          ai_generated: true,
        });
        return { content: created, isError: false };
      }

      case 'move_resource': {
        const data: Record<string, unknown> = {};
        if ('plan_id' in toolInput) data.plan_id = toolInput.plan_id ?? null;
        if ('event_id' in toolInput) data.event_id = toolInput.event_id ?? null;
        if ('parent_id' in toolInput) data.parent_id = toolInput.parent_id ?? null;
        const updated = res.moveResource(toolInput.id as string, data as Parameters<typeof res.moveResource>[1]);
        return { content: updated ?? null, isError: false };
      }

      case 'attach_workspace_file': {
        const relativePath = toolInput.relative_path as string;
        const absolutePath = path.join(workspaceDir, relativePath);
        if (!fs.existsSync(absolutePath)) {
          return { content: `File not found: ${relativePath}`, isError: true };
        }
        const filename = path.basename(absolutePath);
        const created = res.createResource(workspaceId, {
          type: 'file',
          plan_id: (toolInput.plan_id as string | undefined) ?? null,
          event_id: (toolInput.event_id as string | undefined) ?? null,
          file_path: absolutePath,
          title: (toolInput.title as string | undefined) ?? filename,
          ai_generated: true,
        });
        return { content: created, isError: false };
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[CalendarAgent] Tool error', toolName, message);
    return { content: message, isError: true };
  }
}

export function createCalendarAgentSession(
  sessionId: string,
  workspaceId: string,
  apiKey: string,
  workspaceDir: string,
  callbacks: ChatCallbacks,
  onMutation: (mutation: CalendarMutationEvent) => void,
): AgentSession {
  const listeners = new Set<Partial<ChatCallbacks>>();
  listeners.add(callbacks);
  let running = false;
  let stopped = false;
  let abortController = new AbortController();
  let historyInitialized = false;
  let history: MessageParam[] = [];

  const HEARTBEAT_INTERVAL_MS = 15_000;
  const heartbeatTimer = setInterval(() => {
    if (running) emitEvent({ type: 'heartbeat' });
  }, HEARTBEAT_INTERVAL_MS);

  function emitEvent(msg: ChatStreamMessage) {
    if (msg.type !== 'heartbeat') running = true;
    for (const l of listeners) l.onEvent?.(msg);
  }

  function emitDone() {
    running = false;
    for (const l of [...listeners]) l.onDone?.();
  }

  function emitError(error: string) {
    running = false;
    clearInterval(heartbeatTimer);
    for (const l of [...listeners]) l.onError?.(error);
  }

  createSession(sessionId, workspaceId, CALENDAR_SESSION_SOURCE);

  async function runAgentLoop(userText: string) {
    running = true;

    if (!historyInitialized) {
      historyInitialized = true;
      history = reconstructHistory(sessionId);
    }

    history.push({ role: 'user', content: userText });

    const client = new Anthropic({ apiKey });
    const systemPrompt = buildSystemPrompt();

    try {
      while (true) {
        if (stopped) { emitDone(); return; }

        const stream = client.messages.stream(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            system: systemPrompt,
            tools: CALENDAR_TOOLS,
            messages: history,
          },
          { signal: abortController.signal },
        );

        let currentToolCallId: string | null = null;

        for await (const event of stream) {
          if (stopped) break;

          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              currentToolCallId = event.content_block.id;
              emitEvent({
                type: 'tool-call-start',
                toolCallId: event.content_block.id,
                toolName: event.content_block.name,
              });
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              emitEvent({ type: 'text-delta', text: event.delta.text });
            } else if (event.delta.type === 'input_json_delta' && currentToolCallId) {
              emitEvent({
                type: 'tool-call-args-delta',
                toolCallId: currentToolCallId,
                argsText: event.delta.partial_json,
              });
            }
          } else if (event.type === 'content_block_stop') {
            if (currentToolCallId) {
              emitEvent({ type: 'tool-call-end', toolCallId: currentToolCallId });
              currentToolCallId = null;
            }
          }
        }

        if (stopped) { emitDone(); return; }

        const finalMessage = await stream.finalMessage();

        insertMessage(sessionId, 'assistant', JSON.stringify(finalMessage.content));
        history.push({ role: 'assistant', content: finalMessage.content as MessageParam['content'] });

        // Emit completed tool-call events for the UI
        for (const block of finalMessage.content) {
          if (block.type === 'tool_use') {
            emitEvent({
              type: 'tool-call',
              toolCallId: block.id,
              toolName: block.name,
              args: block.input as Record<string, unknown>,
              argsText: JSON.stringify(block.input),
            });
          }
        }

        if (finalMessage.stop_reason !== 'tool_use') break;

        // Execute all tool_use blocks
        const toolResults: Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];

        for (const block of finalMessage.content) {
          if (block.type !== 'tool_use') continue;
          const result = await executeCalendarTool(
            block.name,
            block.input as Record<string, unknown>,
            workspaceId,
            workspaceDir,
            onMutation,
          );
          const contentStr = typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: contentStr,
            ...(result.isError ? { is_error: true } : {}),
          });
          emitEvent({
            type: 'tool-result',
            toolCallId: block.id,
            result: result.content,
            isError: result.isError,
          });
        }

        insertMessage(sessionId, 'tool_result', JSON.stringify(toolResults));
        history.push({ role: 'user', content: toolResults });
      }
    } catch (err: unknown) {
      if (stopped) {
        emitDone();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Ignore abort errors — they are intentional
      if (message.toLowerCase().includes('aborted') || message.toLowerCase().includes('abort')) {
        emitDone();
        return;
      }
      log.error('[CalendarAgent] Loop error', message);
      emitError(message);
      return;
    }

    emitDone();
  }

  return {
    sendMessage(userMessage: string) {
      insertMessage(sessionId, 'user', JSON.stringify({ text: userMessage }));
      void runAgentLoop(userMessage);
    },

    destroy() {
      stopped = true;
      clearInterval(heartbeatTimer);
      abortController.abort();
      abortController = new AbortController();
    },

    addListener(cb: Partial<ChatCallbacks>): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    get isRunning() {
      return running;
    },
  };
}
