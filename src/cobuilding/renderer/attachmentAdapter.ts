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

/** The only image formats the Messages API accepts. Everything else has to be
 *  re-encoded before it can be inlined — sent as-is it is rejected outright. */
const API_NATIVE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** True for anything the API cannot read directly: TIFF, HEIC (every photo off
 *  an iPhone), BMP, AVIF, SVG…
 *
 *  Deliberately keyed on MIME alone. The MIME is what gets sent as the block's
 *  `media_type`, so it is exactly the thing that has to be one of the four —
 *  and Chromium derives it from the extension anyway, so a second extension
 *  check adds no information while breaking files whose name carries no usable
 *  extension (a pasted screenshot), which would be re-encoded for nothing.
 *
 *  Note this never sees an empty `file.type`: `accept: 'image/*'` does not
 *  match one, so the composite routes those to the wildcard adapter and the
 *  agent gets a workspace path instead. */
function needsConversion(file: File): boolean {
  return !API_NATIVE_IMAGE_TYPES.has(file.type);
}

/** The API rejects any single image over 10 MB *base64-encoded*. Unlike a text
 *  document, an image cannot blow the context window — it is downscaled to at
 *  most 4784 visual tokens before the model sees it — so this ceiling is a hard
 *  transport limit, not a token budget, and the failure it prevents is an
 *  outright request rejection rather than a degraded answer. */
const MAX_INLINE_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;

/** Base64 inflates by 4/3, so a source file past ~7.5 MB cannot fit the encoded
 *  ceiling above. 7 MB leaves room for the data-URL prefix, JSON escaping, and
 *  the rest of the turn. */
const MAX_INLINE_IMAGE_BYTES = 7 * 1024 * 1024;

/** Inlines images small enough for the API to accept, and delegates the rest to
 *  the file-reference adapter so the agent gets a workspace path it can read or
 *  downscale itself. The delegation has to live here for the same reason it
 *  does in the document adapter: CompositeAttachmentAdapter dispatches on the
 *  FIRST adapter whose `accept` matches, and `image/*` matches this one before
 *  the trailing wildcard adapter is ever consulted — including on `send`, which
 *  re-dispatches by file rather than remembering what `add` decided. */
class ImageAttachmentAdapter implements AttachmentAdapter {
  accept = 'image/*';

  constructor(private oversized: FileReferenceAttachmentAdapter) {}

  async add(state: { file: File }): Promise<PendingAttachment> {
    if (state.file.size > MAX_INLINE_IMAGE_BYTES) {
      return this.oversized.add(state);
    }

    let dataUrl: string;
    let contentType = state.file.type;

    if (needsConversion(state.file)) {
      const base64 = await readFileAsBase64(state.file);
      let pngBase64: string;
      try {
        pngBase64 = await window.filesAPI.convertImageToPng(base64);
      } catch {
        // The converter is macOS `sips`, which sniffs content rather than
        // trusting the extension and handles every raster format that turns up
        // here — TIFF, HEIC, BMP, AVIF all verified. What it cannot do is
        // rasterize vector art, so SVG lands here. A workspace path is the
        // better answer for those anyway: an SVG is text the agent can read
        // directly, which a flattened PNG would have thrown away.
        return this.oversized.add(state);
      }
      // Re-encoding means the source size does not bound the result: a
      // compressed scan or HEIC photo can expand several-fold as PNG. Measure
      // what would actually be sent, not what was dropped in.
      if (pngBase64.length > MAX_INLINE_IMAGE_BASE64_BYTES) {
        return this.oversized.add(state);
      }
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
    // `type` carries the decision `add` already made — load-bearing for a TIFF,
    // whose source size alone does not say whether the converted PNG fit.
    if (attachment.type === 'file_reference' || attachment.file.size > MAX_INLINE_IMAGE_BYTES) {
      return this.oversized.send(attachment);
    }
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
    new ImageAttachmentAdapter(fileReference),
    new DocumentAttachmentAdapter(fileReference),
    fileReference,
  ]);
}
