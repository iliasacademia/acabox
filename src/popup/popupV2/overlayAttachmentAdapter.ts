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

class OverlayFileReferenceAdapter implements AttachmentAdapter {
  accept = '*';

  async add(state: { file: File }): Promise<PendingAttachment> {
    const maxSizeBytes = 50 * 1024 * 1024;
    if (state.file.size > maxSizeBytes) {
      throw new Error(`File is too large (${(state.file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 50 MB.`);
    }
    return {
      id: state.file.name,
      type: 'file_reference',
      name: state.file.name,
      contentType: state.file.type || 'application/octet-stream',
      file: state.file,
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const relativePath = (attachment.file as any).__overlayFilePath as string | undefined;
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [{ type: 'text', text: relativePath ?? attachment.name }],
    };
  }

  async remove(): Promise<void> {}
}

export function createOverlayAttachmentAdapter() {
  return new CompositeAttachmentAdapter([
    new OverlayImageAttachmentAdapter(),
    new OverlayFileReferenceAdapter(),
  ]);
}
