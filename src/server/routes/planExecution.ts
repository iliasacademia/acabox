import { FastifyInstance } from 'fastify';
import { LocalAgentService } from '../../localAgentService';
import type { EditItem } from '../../renderer/hooks/usePlanExecution';

export async function registerPlanExecutionRoutes(
  fastify: FastifyInstance,
  localAgentService: LocalAgentService,
): Promise<void> {
  // Trigger plan execution — used by WKWebView overlay (no IPC access)
  fastify.post<{ Body: { edits: EditItem[]; manuscriptFilePath?: string | null } }>(
    '/api/local-agent/execute-plan',
    {
      schema: {
        body: {
          type: 'object',
          required: ['edits'],
          properties: {
            edits: { type: 'array' },
            manuscriptFilePath: { type: 'string', nullable: true },
          },
        },
      },
    },
    async (request, reply) => {
      const { edits, manuscriptFilePath } = request.body;
      // Run non-blocking so the HTTP response returns immediately
      localAgentService.executeEditPlan(edits, manuscriptFilePath ?? null).catch(() => {});
      reply.send({ ok: true });
    },
  );

  // Poll current plan execution state — used by WKWebView overlay
  fastify.get('/api/local-agent/execution-status', async (_request, reply) => {
    reply.send(localAgentService.planExecutionState ?? { isRunning: false, currentStep: 0, totalSteps: 0 });
  });

  // Stop the running plan execution — used by WKWebView overlay
  fastify.post('/api/local-agent/stop-plan', async (_request, reply) => {
    localAgentService.stopPlanExecution();
    reply.send({ ok: true });
  });
}
