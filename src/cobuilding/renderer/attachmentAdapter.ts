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
      const pngBase64 = await window.filesAPI.convertImageToPng(base64);
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

/** Text documents are inlined verbatim into the prompt, so their size is a
 *  token budget, not a transfer budget. 256 KB of dense text already costs
 *  ~70-90k tokens — a large slice of even a 200k-token context — and past that
 *  inlining buys nothing over letting the agent read the file off disk. A real
 *  data file blows the window outright: a 5 MB CSV of URLs is well over 1M
 *  tokens and the API rejects the turn with "Prompt is too long". */
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

/** PDFs earn their tokens (the model sees page layout and figures), so they get
 *  a looser ceiling — but the same context math applies past a couple of MB. */
const MAX_INLINE_PDF_BYTES = 2 * 1024 * 1024;

function inlineLimitFor(file: File): number {
  return file.type === 'application/pdf' ? MAX_INLINE_PDF_BYTES : MAX_INLINE_TEXT_BYTES;
}

/** Inlines small documents as prompt content. Anything over the inline ceiling
 *  is delegated to the file-reference adapter, which copies the file into the
 *  workspace and hands the agent a path instead — the agent then reads or
 *  processes it with a script, which is what you want for a data file anyway.
 *
 *  The delegation has to live here rather than in CompositeAttachmentAdapter:
 *  that dispatches on the FIRST adapter whose `accept` matches the file, with
 *  no way to fall through, and `text/csv` matches this one before the trailing
 *  wildcard adapter ever gets a look. */
class DocumentAttachmentAdapter implements AttachmentAdapter {
  accept = 'application/pdf,text/plain,text/html,text/markdown,text/csv';

  constructor(private oversized: FileReferenceAttachmentAdapter) {}

  async add(state: { file: File }): Promise<PendingAttachment> {
    if (state.file.size > inlineLimitFor(state.file)) {
      return this.oversized.add(state);
    }

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
    if (attachment.file.size > inlineLimitFor(attachment.file)) {
      return this.oversized.send(attachment);
    }

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

class FileReferenceAttachmentAdapter implements AttachmentAdapter {
  accept = '*';
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  async add(state: { file: File }): Promise<PendingAttachment> {
    const maxSizeMB = await window.settingsAPI.getMaxAttachmentSizeMB();
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (state.file.size > maxSizeBytes) {
      throw new Error(`File is too large (${(state.file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is ${maxSizeMB} MB.`);
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
    const nativePath = window.filesAPI.getPathForFile(attachment.file);
    let relativePath: string;

    if (nativePath.startsWith(this.workspacePath + '/')) {
      relativePath = nativePath.slice(this.workspacePath.length + 1);
    } else {
      await window.filesAPI.copyToWorkspace([nativePath], this.workspacePath);
      relativePath = attachment.name;
    }

    return {
      ...attachment,
      status: { type: 'complete' },
      content: [{ type: 'text', text: relativePath }],
    };
  }

  async remove(): Promise<void> {}
}

export function createAttachmentAdapter(workspacePath: string) {
  const fileReference = new FileReferenceAttachmentAdapter(workspacePath);
  return new CompositeAttachmentAdapter([
    new ImageAttachmentAdapter(),
    new DocumentAttachmentAdapter(fileReference),
    fileReference,
  ]);
}
