import React from 'react';
import { createRoot } from 'react-dom/client';
import { QuickChatInput } from './QuickChatInput';

const root = createRoot(document.getElementById('root')!);
root.render(<QuickChatInput />);
