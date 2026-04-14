import {
  CompositeAttachmentAdapter,
} from '@assistant-ui/react';
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

function isTiff(file: File): boolean {
  if (file.type === 'image/tiff' || file.type === 'image/x-tiff') return true;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext === 'tiff' || ext === 'tif';
}

class ImageAttachmentAdapter implements AttachmentAdapter {
  accept = 'image/*';

  async add(state: { file: File }): Promise<PendingAttachment> {
    let dataUrl: string;
    let contentType = state.file.type;

    if (isTiff(state.file)) {
      const base64 = await readFileAsBase64(state.file);
      const pngBase64: string = await window.electronAPI.invoke('image:convertToPng', base64);
      dataUrl = `data:image/png;base64,${pngBase64}`;
      contentType = 'image/png';
    } else {
      dataUrl = await readFileAsDataURL(state.file);
    }

    return {
      id: state.file.name,
      type: 'image',
      name: state.file.name,
      contentType,
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

class DocumentAttachmentAdapter implements AttachmentAdapter {
  accept = 'application/pdf,text/plain,text/html,text/markdown,text/csv';

  async add(state: { file: File }): Promise<PendingAttachment> {
    return {
      id: state.file.name,
      type: 'document',
      name: state.file.name,
      contentType: state.file.type,
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
          mimeType: attachment.file.type,
          filename: attachment.name,
        },
      ],
    };
  }

  async remove(): Promise<void> {
    // noop
  }
}

export const attachmentAdapter = new CompositeAttachmentAdapter([
  new ImageAttachmentAdapter(),
  new DocumentAttachmentAdapter(),
]);
