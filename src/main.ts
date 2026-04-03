
const useWritingAgent = true

if (useWritingAgent) {
  import('./writingAgentMain');
} else {
  import('./cobuilding/main');
}
