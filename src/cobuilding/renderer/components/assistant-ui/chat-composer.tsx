import React, { type FC } from 'react';
import { ComposerPrimitive, AuiIf } from '@assistant-ui/react';
import { MSymbol } from '../command-desk/MSymbol';
import { composerAttachmentComponents } from './composer-attachments';
import { useSetupState } from '../../setupStore';

/**
 * The narrow side-panel composer (Phase B spec): `▸` glyph + input + send/stop
 * only. The panel is a companion surface — attach & model picker stay in the
 * full view's docked GlobalComposer.
 */
export const ChatComposer: FC<{ placeholder?: string }> = ({
  placeholder = 'Reply — or ask for the next change',
}) => {
  const setup = useSetupState();

  if (setup.state === 'downloading') {
    return (
      <div className="cdPanelComposer">
        <div className="cdPanelComposer__field" style={{ alignItems: 'center', padding: '0 12px' }}>
          <span className="cdWorking__label">{setup.message || 'Setting up environment…'}</span>
        </div>
      </div>
    );
  }

  return (
    <ComposerPrimitive.Root className="cdPanelComposer">
      <ComposerPrimitive.Attachments components={composerAttachmentComponents} />
      <div className="cdPanelComposer__field">
        <span className="cdPanelComposer__glyph">▸</span>
        <ComposerPrimitive.Input
          placeholder={placeholder}
          className="cdPanelComposer__input"
          rows={1}
          aria-label="Message input"
        />
        <AuiIf condition={(s: any) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <button type="button" className="cdPanelComposer__send" aria-label="Send message">
              <MSymbol name="arrow_upward" size={16} />
            </button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s: any) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className="cdPanelComposer__send" aria-label="Stop generating" title="Stop generating">
              <MSymbol name="stop" size={16} />
            </button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
};
