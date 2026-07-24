/**
 * The pre-built tools that ship with the app, shown alongside the user's own
 * mini-apps on both the Tools page (with their real actions) and the Command
 * Desk home grid (as cards that navigate to the Tools page). Single source of
 * truth so the two surfaces never disagree about what tools exist.
 */
export interface AvailableStub {
  name: string;
  description: string;
  tag: 'ON-DEMAND' | 'SCHEDULED';
  preBuilt?: boolean;
  filePickerType?: 'manuscript' | 'grant' | 'presentation' | 'reference' | 'all' | 'manuscript_grant';
  chatPromptTemplate?: (filePath: string) => string;
  /**
   * If set, picking a file opens it in MS Word with the popup-v2 overlay
   * docked right (~33%) and a kickoff prompt auto-sent in the overlay's
   * chat. Picker is filtered to .docx files only — Word's find_and_replace
   * MCP is the only host we have for live tracked-changes.
   */
  useWordOverlay?: boolean;
}

export const AVAILABLE_TOOLS_STUB: AvailableStub[] = [
  {
    name: 'Peer Review',
    description: 'Review and provide structured feedback on any document in MS Word',
    tag: 'ON-DEMAND',
    preBuilt: true,
    filePickerType: 'all',
    useWordOverlay: true,
  },
  { name: 'Grant Finder', description: 'Funding opportunities matched to your research', tag: 'ON-DEMAND', preBuilt: true },
  {
    name: 'Grant Writer',
    description: 'AI-assisted grant writing, specific aims, and narrative drafting',
    tag: 'ON-DEMAND',
    preBuilt: true,
    filePickerType: 'grant',
    chatPromptTemplate: (filePath) =>
      `/academic-writing-agent\n\nPlease help me write and improve my grant proposal: ${filePath}`,
  },
  { name: 'Literature Synthesis', description: 'Build a structured review across many papers', tag: 'ON-DEMAND', preBuilt: true },
  { name: 'Paper Monitor', description: 'New papers in your topics, weekly digest', tag: 'SCHEDULED', preBuilt: true },
  { name: 'Citation Alerts', description: 'When new work cites your publications', tag: 'SCHEDULED', preBuilt: true },
  { name: 'Reactions', description: 'AI reactions to your browser and file activity, delivered periodically', tag: 'SCHEDULED', preBuilt: true },
];
