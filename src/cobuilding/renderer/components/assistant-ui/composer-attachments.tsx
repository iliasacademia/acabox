import React from 'react';
import { AttachmentPrimitive, useAuiState } from '@assistant-ui/react';
import { XIcon } from 'lucide-react';
import { TooltipIconButton } from './tooltip-icon-button';
import type { FC } from 'react';

export const ComposerImageAttachment: FC = () => {
  const attachment = useAuiState((s: any) => s.attachment);
  const imageSrc = attachment?.content?.find((p: any) => p.type === 'image')?.image
    ?? (attachment?.file ? URL.createObjectURL(attachment.file) : undefined);
  return (
    <AttachmentPrimitive.Root className="composerImageAttachment">
      {imageSrc && <img src={imageSrc} alt={attachment?.name} className="composerImagePreview" />}
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton
          tooltip="Remove"
          variant="ghost"
          size="icon"
          className="composerImageRemove"
        >
          <XIcon />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

export const ComposerDocumentAttachment: FC = () => {
  return (
    <AttachmentPrimitive.Root className="composerAttachmentItem">
      <AttachmentPrimitive.unstable_Thumb className="composerAttachmentThumb" />
      <span className="composerAttachmentName"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton
          tooltip="Remove"
          variant="ghost"
          size="icon"
          className="composerAttachmentRemove"
        >
          <XIcon />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

export const composerAttachmentComponents = {
  Image: ComposerImageAttachment,
  Document: ComposerDocumentAttachment,
  File: ComposerDocumentAttachment,
  Attachment: ComposerDocumentAttachment,
};
