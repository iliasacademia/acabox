import { CompositeAttachmentAdapter } from '@assistant-ui/react';
import type { AttachmentAdapter } from '@assistant-ui/react';
import type { PendingAttachment, CompleteAttachment } from '@assistant-ui/core';

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return readFileAsDataURL(file).then((dataUrl) => dataUrl.split(',')[1]!);
}

class OverlayImageAttachmentAdapter implements AttachmentAdapter {
  accept = 'image/*';

  async add(state: { file: File }): Promise<PendingAttachment> {
    const dataUrl = await readFileAsDataURL(state.file);
    return {
      id: state.file.name,
      type: 'image',
      name: state.file.name,
      contentType: state.file.type || 'image/png',
      file: state.file,
      status: { type: 'requires-action', reason: 'composer-send' },
      content: [{ type: 'image', image: dataUrl }],
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    return {
      ...attachment,
      status: { type: 'complete' },
      content: attachment.content ?? [],
    };
  }

  async remove(): Promise<void> {}
}

class OverlayDocumentAttachmentAdapter implements AttachmentAdapter {
  accept = 'application/pdf,text/plain,text/html,text/markdown,text/csv';

  async add(state: { file: File }): Promise<PendingAttachment> {
    return {
      id: state.file.name,
      type: 'document',
      name: state.file.name,
      contentType: state.file.type || 'application/octet-stream',
      file: state.file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const base64 = await readFileAsBase64(attachment.file);
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          data: base64,
          mimeType: attachment.file.type || 'application/octet-stream',
          filename: attachment.name,
        },
      ],
    };
  }

  async remove(): Promise<void> {}
}

class OverlayFileAttachmentAdapter implements AttachmentAdapter {
  accept = '*';

  async add(state: { file: File }): Promise<PendingAttachment> {
    const maxSizeBytes = 50 * 1024 * 1024;
    if (state.file.size > maxSizeBytes) {
      throw new Error(`File is too large (${(state.file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 50 MB.`);
    }
    return {
      id: state.file.name,
      type: 'document',
      name: state.file.name,
      contentType: state.file.type || 'application/octet-stream',
      file: state.file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const base64 = await readFileAsBase64(attachment.file);
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          data: base64,
          mimeType: attachment.file.type || 'application/octet-stream',
          filename: attachment.name,
        },
      ],
    };
  }

  async remove(): Promise<void> {}
}

export function createOverlayAttachmentAdapter() {
  return new CompositeAttachmentAdapter([
    new OverlayImageAttachmentAdapter(),
    new OverlayDocumentAttachmentAdapter(),
    new OverlayFileAttachmentAdapter(),
  ]);
}
