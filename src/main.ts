
const useWritingAgent = process.env.ENTRY_POINT !== 'cobuilding';

if (useWritingAgent) {
  import('./writingAgentMain');
} else {
  import('./cobuilding/main');
}
