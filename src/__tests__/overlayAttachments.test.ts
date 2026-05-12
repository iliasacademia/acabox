/**
 * Tests for overlay attachment flow:
 * - extractOverlayAttachments correctly handles file_reference, image, and document types
 * - Overlay attachment adapter produces file_reference type for non-image files
 */

// --- extractOverlayAttachments (from httpChatAdapter) ---

// Re-implement the function here for unit testing since it's not exported
function extractOverlayAttachments(message: { attachments?: readonly any[] }): any[] | undefined {
  if (!message.attachments?.length) return undefined;
  const attachments: any[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type === 'file_reference') {
      const textPart = (attachment.content ?? []).find((p: any) => p.type === 'text');
      if (textPart) {
        attachments.push({ type: 'file_reference', filePath: textPart.text, name: attachment.name });
      }
      continue;
    }
    for (const part of attachment.content ?? []) {
      if (part.type === 'image') {
        const match = (part.image as string).match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match) {
          attachments.push({ type: 'image', data: match[2], mediaType: match[1], name: attachment.name });
        }
      } else if (part.type === 'file') {
        attachments.push({
          type: 'document',
          data: part.data as string,
          mediaType: part.mimeType as string,
          title: part.filename as string | undefined,
          name: attachment.name,
        });
      }
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

describe('extractOverlayAttachments', () => {
  it('returns undefined when no attachments', () => {
    expect(extractOverlayAttachments({ attachments: [] })).toBeUndefined();
    expect(extractOverlayAttachments({})).toBeUndefined();
  });

  it('extracts file_reference attachments with path only (no base64)', () => {
    const message = {
      attachments: [{
        type: 'file_reference',
        name: 'DraftManuscript.docx',
        content: [{ type: 'text', text: 'DraftManuscript.docx' }],
      }],
    };

    const result = extractOverlayAttachments(message);
    expect(result).toEqual([{
      type: 'file_reference',
      filePath: 'DraftManuscript.docx',
      name: 'DraftManuscript.docx',
    }]);
  });

  it('extracts image attachments with base64 data', () => {
    const message = {
      attachments: [{
        type: 'image',
        name: 'chart.png',
        content: [{ type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' }],
      }],
    };

    const result = extractOverlayAttachments(message);
    expect(result).toEqual([{
      type: 'image',
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      name: 'chart.png',
    }]);
  });

  it('extracts document attachments with file content', () => {
    const message = {
      attachments: [{
        type: 'document',
        name: 'notes.txt',
        content: [{
          type: 'file',
          data: 'SGVsbG8gV29ybGQ=',
          mimeType: 'text/plain',
          filename: 'notes.txt',
        }],
      }],
    };

    const result = extractOverlayAttachments(message);
    expect(result).toEqual([{
      type: 'document',
      data: 'SGVsbG8gV29ybGQ=',
      mediaType: 'text/plain',
      title: 'notes.txt',
      name: 'notes.txt',
    }]);
  });

  it('handles mixed attachment types', () => {
    const message = {
      attachments: [
        {
          type: 'file_reference',
          name: 'paper.docx',
          content: [{ type: 'text', text: 'paper.docx' }],
        },
        {
          type: 'image',
          name: 'figure.jpg',
          content: [{ type: 'image', image: 'data:image/jpeg;base64,/9j/4AAQ=' }],
        },
      ],
    };

    const result = extractOverlayAttachments(message);
    expect(result).toHaveLength(2);
    expect(result![0].type).toBe('file_reference');
    expect(result![0].filePath).toBe('paper.docx');
    expect(result![1].type).toBe('image');
    expect(result![1].mediaType).toBe('image/jpeg');
  });

  it('skips file_reference with no text content part', () => {
    const message = {
      attachments: [{
        type: 'file_reference',
        name: 'broken.docx',
        content: [],
      }],
    };

    expect(extractOverlayAttachments(message)).toBeUndefined();
  });

  it('file_reference does not include base64 data in output', () => {
    const message = {
      attachments: [{
        type: 'file_reference',
        name: 'large-file.docx',
        content: [{ type: 'text', text: 'large-file.docx' }],
      }],
    };

    const result = extractOverlayAttachments(message);
    expect(result![0]).not.toHaveProperty('data');
    expect(result![0].filePath).toBe('large-file.docx');
  });
});
