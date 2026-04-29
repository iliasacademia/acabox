/**
 * Zotero local-client routes for the WKWebView overlay (popup runs out-of-process
 * and can't use ipcRenderer; it talks to the main process over the localhost HTTP
 * server). The handlers delegate to the same zoteroLocalClient module the desktop
 * IPC handlers use.
 */
import { FastifyInstance } from 'fastify';
import { addDoiToZotero, checkDoiInZotero, getDoiMetadata, getZoteroLocalStatus, listAddedDois } from '../../zoteroLocalClient';

export async function registerZoteroRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/zotero/status', async (_request, reply) => {
    try {
      const status = await getZoteroLocalStatus();
      reply.send({ success: true, status });
    } catch (error: any) {
      reply.code(500).send({ success: false, error: error?.message ?? String(error), status: 'not-running' });
    }
  });

  fastify.post<{ Body: { doi: string } }>(
    '/api/zotero/add',
    {
      schema: {
        body: {
          type: 'object',
          required: ['doi'],
          properties: {
            doi: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await addDoiToZotero(request.body.doi);
      reply.send(result);
    },
  );

  fastify.get<{ Querystring: { doi: string } }>(
    '/api/zotero/doi-metadata',
    async (request, reply) => {
      const doi = request.query.doi;
      if (typeof doi !== 'string' || doi.length === 0) {
        reply.send(null);
        return;
      }
      reply.send(getDoiMetadata(doi));
    },
  );

  fastify.get('/api/zotero/added-dois', async (_request, reply) => {
    reply.send({ dois: listAddedDois() });
  });

  fastify.get<{ Querystring: { doi: string } }>(
    '/api/zotero/check-doi',
    async (request, reply) => {
      const doi = request.query.doi;
      if (typeof doi !== 'string' || doi.length === 0) {
        reply.send({ exists: null });
        return;
      }
      const exists = await checkDoiInZotero(doi);
      reply.send({ exists });
    },
  );
}
