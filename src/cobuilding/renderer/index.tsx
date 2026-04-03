import React from 'react';
import { createRoot } from 'react-dom/client';
import { useLocalRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { electronChatAdapter } from './chatAdapter';
import './App.css';

function App() {
  const runtime = useLocalRuntime(electronChatAdapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Thread />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
