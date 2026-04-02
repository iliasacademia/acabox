import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { defaultLogger as logger } from '../../utils/logger';
import { insertParagraphInWord, positionCursorInWord, CursorPositionType, getWordFilePath, saveWordDocument, getWordText, getWordSelection, selectTextInWord, deleteSelectionInWord, applyStyleInWord, applyFormattingInWord, ApplyFormattingOptions, openWordDocument } from '../wordActions';

interface InsertParagraphBody {
  action: 'insert_paragraph';
  content: string;
  position?: CursorPositionType;
  defaultColor?: string;
}

interface PositionCursorBody {
  action: 'position_cursor';
  anchor: string;
  type?: CursorPositionType;
}

export async function registerMsWordRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: { action: 'open_document'; filePath: string } }>(
    '/api/ms-word/open-document',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'filePath'],
          properties: {
            action: { type: 'string', enum: ['open_document'] },
            filePath: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { filePath } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/open-document', { filePath });

      try {
        const result = await openWordDocument(filePath);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true, fileName: result.fileName });
      } catch (error) {
        logger.error('[MsWord API] Open document error:', error);
        reply.code(500).send({ success: false, error: 'Failed to open document' });
      }
    }
  );

  fastify.post<{ Body: InsertParagraphBody }>(
    '/api/ms-word/insert-paragraph',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'content'],
          properties: {
            action: { type: 'string', enum: ['insert_paragraph'] },
            content: { type: 'string' },
            position: { type: 'string', enum: ['before', 'after'] },
            defaultColor: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { content, position, defaultColor } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/insert-paragraph', { position: position || 'after', defaultColor });

      try {
        const result = await insertParagraphInWord(content, position, defaultColor);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        logger.error('[MsWord API] Error:', error);
        reply.code(500).send({ success: false, error: 'Failed to insert paragraph' });
      }
    }
  );

  fastify.post<{ Body: PositionCursorBody }>(
    '/api/ms-word/position-cursor',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'anchor'],
          properties: {
            action: { type: 'string', enum: ['position_cursor'] },
            anchor: { type: 'string', minLength: 1 },
            type: { type: 'string', enum: ['before', 'after'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { anchor, type } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/position-cursor', { type: type || 'after' });

      try {
        const result = await positionCursorInWord(anchor, type);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        logger.error('[MsWord API] Position cursor error:', error);
        reply.code(500).send({ success: false, error: 'Failed to position cursor' });
      }
    }
  );

  fastify.get(
    '/api/ms-word/get-file-path',
    async (request, reply) => {
      logger.info('[MsWord API] GET /api/ms-word/get-file-path');

      try {
        const result = await getWordFilePath();
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true, filePath: result.filePath, fileName: result.fileName });
      } catch (error) {
        logger.error('[MsWord API] Get file path error:', error);
        reply.code(500).send({ success: false, error: 'Failed to get file path' });
      }
    }
  );

  fastify.get<{ Querystring: { offset?: string; limit?: string } }>(
    '/api/ms-word/get-text',
    async (request, reply) => {
      const offset = parseInt(request.query.offset || '0', 10);
      const limit = parseInt(request.query.limit || '8000', 10);
      logger.info('[MsWord API] GET /api/ms-word/get-text', { offset, limit });

      try {
        const result = await getWordText(offset, limit);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send(result);
      } catch (error) {
        logger.error('[MsWord API] Get text error:', error);
        reply.code(500).send({ success: false, error: 'Failed to get Word text' });
      }
    }
  );

  fastify.get(
    '/api/ms-word/get-selection',
    async (request, reply) => {
      logger.info('[MsWord API] GET /api/ms-word/get-selection');

      try {
        const result = await getWordSelection();
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true, selectedText: result.selectedText });
      } catch (error) {
        logger.error('[MsWord API] Get selection error:', error);
        reply.code(500).send({ success: false, error: 'Failed to get selection' });
      }
    }
  );

  fastify.post<{ Body: { action: 'save_document' } }>(
    '/api/ms-word/save-document',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['save_document'] },
          },
        },
      },
    },
    async (request, reply) => {
      logger.info('[MsWord API] POST /api/ms-word/save-document');

      try {
        const result = await saveWordDocument();
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        logger.error('[MsWord API] Save document error:', error);
        reply.code(500).send({ success: false, error: 'Failed to save document' });
      }
    }
  );

  fastify.post<{ Body: { action: 'select_text'; text: string } }>(
    '/api/ms-word/select-text',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'text'],
          properties: {
            action: { type: 'string', enum: ['select_text'] },
            text: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { text } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/select-text', { textLength: text.length });

      try {
        const result = await selectTextInWord(text);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({
          success: true,
          selectedText: result.selectedText,
          iterations: result.iterations,
          exact: result.exact,
        });
      } catch (error) {
        logger.error('[MsWord API] Select text error:', error);
        reply.code(500).send({ success: false, error: 'Failed to select text' });
      }
    }
  );

  fastify.post<{ Body: { action: 'apply_style'; style: string } }>(
    '/api/ms-word/apply-style',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action', 'style'],
          properties: {
            action: { type: 'string', enum: ['apply_style'] },
            style: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { style } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/apply-style', { style });

      try {
        const result = await applyStyleInWord(style);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        logger.error('[MsWord API] Apply style error:', error);
        reply.code(500).send({ success: false, error: 'Failed to apply style' });
      }
    }
  );

  fastify.post<{ Body: { action: 'apply_formatting' } & ApplyFormattingOptions }>(
    '/api/ms-word/apply-formatting',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['apply_formatting'] },
            bold: { type: 'boolean' },
            italic: { type: 'boolean' },
            underline: { type: 'boolean' },
            strikethrough: { type: 'boolean' },
            allCaps: { type: 'boolean' },
            smallCaps: { type: 'boolean' },
            superscript: { type: 'boolean' },
            subscript: { type: 'boolean' },
            color: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { action, ...formatting } = request.body;
      logger.info('[MsWord API] POST /api/ms-word/apply-formatting', formatting);

      try {
        const result = await applyFormattingInWord(formatting);
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true });
      } catch (error) {
        logger.error('[MsWord API] Apply formatting error:', error);
        reply.code(500).send({ success: false, error: 'Failed to apply formatting' });
      }
    }
  );

  fastify.post<{ Body: { action: 'delete_selection' } }>(
    '/api/ms-word/delete-selection',
    {
      schema: {
        body: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['delete_selection'] },
          },
        },
      },
    },
    async (request, reply) => {
      logger.info('[MsWord API] POST /api/ms-word/delete-selection');

      try {
        const result = await deleteSelectionInWord();
        if (!result.success) {
          reply.code(500).send({ success: false, error: result.error });
          return;
        }
        reply.send({ success: true, deletedText: result.deletedText });
      } catch (error) {
        logger.error('[MsWord API] Delete selection error:', error);
        reply.code(500).send({ success: false, error: 'Failed to delete selection' });
      }
    }
  );
}
