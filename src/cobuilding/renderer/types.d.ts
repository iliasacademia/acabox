import type { ChatAPI, Workspace, ScheduledTask, ScheduledTaskRun, CreateTaskData, UpdateTaskData, CalendarGroup, CalendarEvent, EventFile, GroupFile, CreateGroupData, UpdateGroupData, CreateEventData, UpdateEventData, EventDependency, CreateDependencyData, UpdateDependencyData, CascadeUpdate, CalendarResource, CalendarResourceType, CreateResourceData, UpdateResourceData, MoveResourceData, ListResourcesOptions, WorkspaceFileEntry } from '../shared/types';

interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

type FileContent =
  | { type: 'text'; content: string }
  | { type: 'image'; fileUrl: string }
  | { type: 'pdf'; fileUrl: string }
  | { type: 'markdown'; content: string }
  | { type: 'csv'; content: string; delimiter: string }
  | { error: 'too-large'; size: number };

interface CopyProgress {
  copied: number;
  total: number;
  currentName: string | null;
}

interface FilesAPI {
  readDirectory(dirPath: string): Promise<DirEntry[]>;
  readFile(filePath: string): Promise<FileContent>;
  fileExists(filePath: string): Promise<boolean>;
  findByName(filename: string, hintDirs: string[]): Promise<string | null>;
  findByExtension(extensions: string[]): Promise<{ relPath: string; mtimeMs: number }[]>;
  downloadFile(filename: string, content: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
  showInFinder(filePath: string): Promise<void>;
  revealInFinder(filePath: string): Promise<void>;
  copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
  moveFile(sourcePath: string, destinationDir: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  createFile(filePath: string): Promise<void>;
  createDirectory(dirPath: string): Promise<void>;
  renameFile(filePath: string, newName: string): Promise<void>;
  convertImageToPng(base64Data: string): Promise<string>;
  getPathForFile(file: File): string;
  onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
  onWorkspaceChanged(callback: () => void): () => void;
}

interface WorkspacesAPI {
  getActive(): Promise<Workspace | null>;
  list(): Promise<Workspace[]>;
  getDefaultDirectory(name: string): Promise<string>;
  create(data: { name: string; directoryPath: string }): Promise<Workspace>;
  switch(id: string): Promise<Workspace>;
  update(data: { name: string; directoryPath: string }): Promise<Workspace>;
  selectDirectory(): Promise<string | undefined>;
  deleteAll(): Promise<void>;
}

interface SessionData {
  id: string;
  title: string;
  source: string | null;
  document_path: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageData {
  id: number;
  session_id: string;
  type: string;
  content: string;
  created_at: string;
}

interface SessionsAPI {
  list(source?: string): Promise<SessionData[]>;
  get(id: string): Promise<SessionData | undefined>;
  getRunningIds(): Promise<string[]>;
  setDocumentPath(id: string, documentPath: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  listMessages(sessionId: string): Promise<MessageData[]>;
  findForApp(dirName: string): Promise<string | null>;
  onTitleUpdated(callback: (sessionId: string, title: string) => void): () => void;
  onSessionsChanged(callback: () => void): () => void;
  onForeignTurnDone(callback: (sessionId: string) => void): () => void;
}

interface ContainerAPI {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ running: boolean }>;
  exec(command: string[]): Promise<{ stdout: string; stderr: string }>;
  getBinaryMode(): Promise<'system' | 'bundled'>;
  setBinaryMode(mode: 'system' | 'bundled'): Promise<void>;
  getImageSource(): Promise<'registry' | 'local'>;
  setImageSource(source: 'registry' | 'local'): Promise<void>;
  getBundledStatus(): Promise<{ downloaded: boolean; binDir: string }>;
  downloadBinaries(): Promise<void>;
  deleteBinaries(): Promise<void>;
  deleteImage(): Promise<void>;
  downloadImage(): Promise<void>;
  getName(): Promise<string>;
  isImageBuilt(): Promise<boolean>;
  isBaseImageDownloaded(): Promise<boolean>;
  ensureSetup(): Promise<void>;
  getEnvironmentInfo(): Promise<EnvironmentInfoPayload | null>;
  appDepsReady(dirName: string): Promise<boolean>;
  ensureAppDeps(dirName: string): Promise<{ installed: string[] }>;
  getAppInstallRequests(dirName: string): Promise<Array<{ registry: PackageRegistry; packages: string[] }>>;
  rebuildEnvironment(): Promise<void>;
  onSetupProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
  onProgress(callback: (progress: { stage: string; message: string }) => void): () => void;
  onPackageState(callback: (e: { registry: PackageRegistry; package: string; state: PackageState }) => void): () => void;
  onPackageLine(callback: (e: { registry: PackageRegistry; package: string; line: string }) => void): () => void;
  onBackgroundBuild(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
}

interface AuthAPI {
  checkLogin(): Promise<{ loggedIn: boolean }>;
  startQRAuth(): Promise<{
    success: boolean;
    deviceId?: string;
    qrCodeDataURL?: string;
    authorizationURL?: string;
    error?: string;
  }>;
  verifyQRCode(
    deviceId: string,
    code: string
  ): Promise<{ success: boolean; authorized?: boolean; userId?: number; error?: string }>;
  logout(): Promise<{ success: boolean; error?: string }>;
  getApiKey(): Promise<{ apiKey: string | null; baseURL?: string; provider?: string }>;
  refetchApiKey(): Promise<{ success: boolean; keyIdentifier?: string; error?: string }>;
  getApiProvider(): Promise<{ provider: string }>;
  setApiProvider(provider: string, customKey?: string, customBaseURL?: string): Promise<{ success: boolean; error?: string }>;
  isDev: boolean;
  setEndpoint(endpoint: string): Promise<{ success: boolean; endpoint: string }>;
  hasSessionCookie(): Promise<boolean>;
  onDeepLinkCallback(
    callback: (data: { verificationCode: string; deviceId: string }) => void
  ): () => void;
}

interface ElectronAPI {
  on(channel: string, callback: (...args: any[]) => void): void;
  removeListener(channel: string, callback: (...args: any[]) => void): void;
  invoke(channel: string, ...args: any[]): Promise<any>;
}

declare global {
  type PackageRegistry = 'pip' | 'npm' | 'R' | 'apt' | 'manual';
  type PackageState = 'queued' | 'installing' | 'installed' | 'failed';

  interface EnvironmentInfoPayload {
    imageType: 'base' | 'user';
    imageHash: string | null;
    environmentHash: string | null;
    inSync: boolean;
    backgroundBuildState: 'idle' | 'building' | 'building-pending';
    packageStates: Record<PackageRegistry, Record<string, PackageState>>;
    packageLines: Record<PackageRegistry, Record<string, string>>;
    totalPip: string[];
    totalNpm: string[];
    totalR: string[];
    totalApt: string[];
    totalSetup: string[];
    apps: Array<{
      name: string;
      pip: string[];
      npm: Record<string, string>;
      r: string[];
      apt: string[];
      setup: string[];
    }>;
  }

  interface DirEntry {
    name: string;
    path: string;
    isDirectory: boolean;
  }

  type FileContent =
    | { type: 'text'; content: string }
    | { type: 'image'; fileUrl: string }
    | { type: 'pdf'; fileUrl: string }
    | { type: 'markdown'; content: string }
    | { type: 'csv'; content: string; delimiter: string }
    | { type: 'latex'; content: string }
    | { type: 'spreadsheet'; base64: string; ext: string }
    | { error: 'too-large'; size: number };

  interface CopyProgress {
    copied: number;
    total: number;
    currentName: string | null;
  }

  interface FilesAPI {
    readDirectory(dirPath: string): Promise<DirEntry[]>;
    readFile(filePath: string): Promise<FileContent>;
    fileExists(filePath: string): Promise<boolean>;
    findByName(filename: string, hintDirs: string[]): Promise<string | null>;
  findByExtension(extensions: string[]): Promise<{ relPath: string; mtimeMs: number }[]>;
    writeFile(filePath: string, content: string): Promise<void>;
    downloadFile(filename: string, content: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
    showInFinder(filePath: string): Promise<void>;
    revealInFinder(filePath: string): Promise<void>;
    selectFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    selectDirectory(): Promise<string | null>;
    copyToWorkspace(sourcePaths: string[], destinationDir: string): Promise<{ copied: number }>;
    moveFile(sourcePath: string, destinationDir: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDirectory(dirPath: string): Promise<void>;
    renameFile(filePath: string, newName: string): Promise<void>;
    convertImageToPng(base64Data: string): Promise<string>;
    getPathForFile(file: File): string;
    onCopyProgress(callback: (progress: CopyProgress) => void): () => void;
    onWorkspaceChanged(callback: () => void): () => void;
  }

  interface WorkspacesAPI {
    getActive(): Promise<Workspace | null>;
    list(): Promise<Workspace[]>;
    getDefaultDirectory(name: string): Promise<string>;
    create(data: { name: string; directoryPath: string }): Promise<Workspace>;
    switch(id: string): Promise<Workspace>;
    update(data: { name: string; directoryPath: string }): Promise<Workspace>;
    selectDirectory(): Promise<string | undefined>;
    deleteAll(): Promise<void>;
  }

  interface SessionData {
    id: string;
    title: string;
    source: string | null;
    document_path: string | null;
    created_at: string;
    updated_at: string;
  }

  interface MessageData {
    id: number;
    session_id: string;
    type: string;
    content: string;
    created_at: string;
  }

  interface SessionsAPI {
    list(source?: string): Promise<SessionData[]>;
    get(id: string): Promise<SessionData | undefined>;
    getRunningIds(): Promise<string[]>;
    setDocumentPath(id: string, documentPath: string): Promise<void>;
    countForDocument(documentPath: string): Promise<number>;
    rename(id: string, title: string): Promise<void>;
    delete(id: string): Promise<void>;
    listMessages(sessionId: string): Promise<MessageData[]>;
    findForApp(dirName: string): Promise<string | null>;
    onTitleUpdated(callback: (sessionId: string, title: string) => void): () => void;
    onSessionsChanged(callback: () => void): () => void;
    onForeignTurnDone(callback: (sessionId: string) => void): () => void;
  }

  interface ContainerAPI {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<{ running: boolean }>;
    exec(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    syncOverlay(): Promise<{ durationMs: number }>;
    execLogged(command: string[], meta?: { source?: string; appDirName?: string | null }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
    getBinaryMode(): Promise<'system' | 'bundled'>;
    setBinaryMode(mode: 'system' | 'bundled'): Promise<void>;
    getImageSource(): Promise<'registry' | 'local'>;
    setImageSource(source: 'registry' | 'local'): Promise<void>;
    getMemoryLimit(): Promise<'2g' | '4g' | '6g' | '8g'>;
    setMemoryLimit(limit: '2g' | '4g' | '6g' | '8g'): Promise<void>;
    getBundledStatus(): Promise<{ downloaded: boolean; binDir: string }>;
    downloadBinaries(): Promise<void>;
    deleteBinaries(): Promise<void>;
    deleteImage(): Promise<void>;
    downloadImage(): Promise<void>;
    getName(): Promise<string>;
    isImageBuilt(): Promise<boolean>;
    isBaseImageDownloaded(): Promise<boolean>;
    ensureSetup(): Promise<void>;
    getEnvironmentInfo(): Promise<EnvironmentInfoPayload | null>;
    appDepsReady(dirName: string): Promise<boolean>;
    ensureAppDeps(dirName: string): Promise<{ installed: string[] }>;
    getAppInstallRequests(dirName: string): Promise<Array<{ registry: PackageRegistry; packages: string[] }>>;
    rebuildEnvironment(): Promise<void>;
    onSetupProgress(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
    onProgress(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
    onPackageState(callback: (e: { registry: PackageRegistry; package: string; state: PackageState }) => void): () => void;
    onPackageLine(callback: (e: { registry: PackageRegistry; package: string; line: string }) => void): () => void;
    onBackgroundBuild(callback: (progress: { stage: string; message: string; percent?: number }) => void): () => void;
  }

  interface CommandLogEntry {
    id: number;
    timestamp: string;
    command: string[];
    stdout: string;
    stderr: string;
    exitCode: number;
    appDirName: string | null;
    source: 'agent' | 'iframe';
  }

  interface CommandLogAPI {
    getAll(): Promise<CommandLogEntry[]>;
    getByApp(appDirName: string): Promise<CommandLogEntry[]>;
    getAppNames(): Promise<string[]>;
    onEntry(callback: (entry: CommandLogEntry) => void): () => void;
  }

  interface SystemLogEntry {
    id: number;
    timestamp: string;
    level: string;
    text: string;
  }

  interface SystemLogAPI {
    getAll(): Promise<SystemLogEntry[]>;
    onEntry(callback: (entry: SystemLogEntry) => void): () => void;
  }

  interface JupyterKernelInfo {
    id: string;
    name: string;
    execution_state: string;
    last_activity: string;
    connections: number;
  }

  interface JupyterAPI {
    startGateway(): Promise<{ url: string } | { error: string }>;
    stopGateway(): Promise<void>;
    restartGateway(): Promise<{ url: string } | { error: string }>;
    gatewayStatus(): Promise<{ running: boolean; url: string | null }>;
    listKernels(): Promise<JupyterKernelInfo[]>;
    shutdownKernel(kernelId: string): Promise<boolean>;
  }

  interface ReactionPromptAPI {
    get(): Promise<{ instructions: string | null }>;
    set(instructions: string): Promise<void>;
    reset(): Promise<void>;
  }

  interface ReactionSourcesAPI {
    get(): Promise<string[]>;
    set(sources: string[]): Promise<void>;
  }

  interface AcademiaFileAPI {
    read(relativePath: string): Promise<{ content: string }>;
    write(relativePath: string, content: string): Promise<void>;
  }

  interface ScheduledTasksAPI {
    list(): Promise<ScheduledTask[]>;
    get(id: string): Promise<ScheduledTask | null>;
    create(data: CreateTaskData): Promise<ScheduledTask>;
    update(id: string, data: UpdateTaskData): Promise<ScheduledTask | null>;
    delete(id: string): Promise<void>;
    setEnabled(id: string, enabled: boolean): Promise<void>;
    runNow(id: string): Promise<void>;
    listRuns(taskId: string): Promise<ScheduledTaskRun[]>;
  }

  interface TodayFileSession {
    id: number;
    document_url: string;
    app_name: string;
    app_bundle_id: string;
    window_title: string | null;
    session_date: string;
    first_seen: string;
    last_seen: string;
    poll_count: number;
    total_dwell: number;
    app_version: string;
    snapshot_ulid: string | null;
    last_modified: string | null;
    diff_ulid: string | null;
  }

  interface FileMonitorAPI {
    status(): Promise<{ running: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    getTodaySessions(): Promise<TodayFileSession[]>;
    openFile(fileUrl: string, bundleId?: string): Promise<string>;
    setDockRightForDocument(documentPath: string, docked: boolean): Promise<void>;
    setOverlayKickoffForDocument(documentPath: string, prompt: string): Promise<void>;
    requestNewOverlayChatForDocument(documentPath: string): Promise<void>;
    navigateOverlayToSession(sessionId: string): Promise<void>;
  }

  interface BrowserMonitorAPI {
    status(): Promise<{ serverRunning: boolean; extensionConnected: boolean }>;
    start(): Promise<void>;
    stop(): Promise<void>;
    downloadExtension(): Promise<{ success: boolean; error?: string; path?: string }>;
  }

  interface DataPathInfo {
    label: string;
    path: string;
  }

  interface DebugAPI {
    getStorageInfo(): Promise<{
      environment: string;
      userData: string;
      podmanPaths: DataPathInfo[];
    }>;
    clearSelected(ids: string[]): Promise<{ cleared: string[]; errors: string[] }>;
    exportLogs(): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }>;
    exportWorkspace(): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }>;
    importWorkspace(): Promise<{ ok: boolean; workspaceName?: string; workspaceDir?: string; workspaceId?: string; canceled?: boolean; error?: string }>;
    hardResetWorkspace(): Promise<{ ok: boolean; error?: string }>;
    syncOverlay(): Promise<{ durationMs: number }>;
    isOverlayEnabled(): Promise<boolean>;
    /** Pipes a renderer-side log line into electron-log on the main process. */
    log(msg: string): Promise<void>;
  }

  interface SettingsAPI {
    getMaxAttachmentSizeMB(): Promise<number>;
    setMaxAttachmentSizeMB(sizeMB: number): Promise<void>;
    getReactionsEnabled(): Promise<boolean>;
    setReactionsEnabled(enabled: boolean): Promise<void>;
  }

  interface MiniAppEntry {
    dirName: string;
    name: string;
    description: string | null;
    icon: string | null;
    lastOpened: string | null;
    preBuilt: boolean;
    hasManifest: boolean;
  }

  interface MiniAppsAPI {
    exportApp(dirName: string): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean; error?: string }>;
    importApp(): Promise<{ ok: boolean; dirName?: string; canceled?: boolean; error?: string }>;
    list(): Promise<MiniAppEntry[]>;
    touch(dirName: string): Promise<{ ok: boolean; error?: string }>;
  }

  interface WritingAgentProject {
    id: number;
    workspace_id: string;
    name: string;
    description: string;
    file_count: number;
    primary_manuscript_id: number | null;
    server_created_at: string;
    server_updated_at: string;
    synced_at: string;
  }

  interface WritingAgentFile {
    id: number;
    project_id: number;
    file_name: string;
    file_type: string;
    rel_path: string | null;
    is_primary_manuscript: number;
    size: number;
    tag: string | null;
    server_created_at: string;
    server_updated_at: string;
  }

  interface WritingAgentSupportingFile {
    id: number;
    workspace_id: string;
    file_name: string;
    file_type: string;
    rel_path: string | null;
    size: number;
    tag: string | null;
    summary: string | null;
    server_created_at: string;
    server_updated_at: string;
  }

  interface WritingAgentConversation {
    id: number;
    project_id: number;
    agent_name: string;
    title: string | null;
    summary: string | null;
    server_created_at: string;
    server_updated_at: string;
  }

  interface WritingAgentAPI {
    isLinked(): Promise<boolean>;
    link(): Promise<{ success: boolean; error?: string }>;
    unlink(): Promise<{ success: boolean }>;
    refresh(): Promise<{ success: boolean; projectCount?: number; error?: string }>;
    listProjects(): Promise<WritingAgentProject[]>;
    getProjectFiles(projectId: number): Promise<WritingAgentFile[]>;
    listConversations(projectId: number): Promise<WritingAgentConversation[]>;
    getConversationDetail(conversationId: number, projectId: number): Promise<any>;
    continueConversation(conversationId: number, projectId: number): Promise<string>;
    listSupportingFiles(): Promise<WritingAgentSupportingFile[]>;
  }

  type CalendarMutationEvent =
    | { type: 'group-created';      group: CalendarGroup }
    | { type: 'group-updated';      group: CalendarGroup }
    | { type: 'group-deleted';      groupId: string }
    | { type: 'event-created';      event: CalendarEvent }
    | { type: 'event-updated';      event: CalendarEvent }
    | { type: 'event-deleted';      eventId: string }
    | { type: 'event-moved';        moved: CalendarEvent; cascaded: CascadeUpdate[] }
    | { type: 'dependency-created'; dependency: EventDependency }
    | { type: 'dependency-updated'; dependency: EventDependency }
    | { type: 'dependency-deleted'; dependencyId: string };

  interface CalendarAPI {
    listGroups(): Promise<CalendarGroup[]>;
    createGroup(data: CreateGroupData): Promise<CalendarGroup>;
    updateGroup(id: string, data: UpdateGroupData): Promise<CalendarGroup | null>;
    deleteGroup(id: string): Promise<void>;
    getGroupTimeRange(id: string): Promise<{ start_at: string; end_at: string } | null>;

    listEvents(opts?: { from?: string; to?: string; groupId?: string }): Promise<CalendarEvent[]>;
    createEvent(data: CreateEventData): Promise<CalendarEvent>;
    updateEvent(id: string, data: UpdateEventData): Promise<CalendarEvent | null>;
    deleteEvent(id: string): Promise<void>;

    addEventFile(eventId: string, filePath: string): Promise<EventFile>;
    listEventFiles(eventId: string): Promise<EventFile[]>;
    removeEventFile(id: number): Promise<void>;
    addGroupFile(groupId: string, filePath: string): Promise<GroupFile>;
    listGroupFiles(groupId: string, includeFromEvents?: boolean): Promise<GroupFile[]>;
    removeGroupFile(id: number): Promise<void>;

    listResources(opts?: ListResourcesOptions): Promise<CalendarResource[]>;
    createResource(data: CreateResourceData): Promise<CalendarResource>;
    updateResource(id: string, data: UpdateResourceData): Promise<CalendarResource | null>;
    deleteResource(id: string): Promise<void>;
    openResourceFile(filePath: string): Promise<string>;
    openResourceUrl(url: string): Promise<void>;
    revealResourceFile(filePath: string): Promise<void>;
    pickResourceFile(): Promise<string[] | null>;
    moveResource(id: string, data: MoveResourceData): Promise<CalendarResource | null>;
    listWorkspaceFiles(): Promise<WorkspaceFileEntry[]>;

    listDependencies(): Promise<EventDependency[]>;
    createDependency(data: CreateDependencyData): Promise<EventDependency | { error: 'cycle' }>;
    updateDependency(id: string, data: UpdateDependencyData): Promise<EventDependency | null>;
    deleteDependency(id: string): Promise<void>;
    moveEventWithCascade(id: string, newStartAt: string, newEndAt: string): Promise<{ moved: CalendarEvent; cascaded: CascadeUpdate[] } | null>;
    adjustBuffer(depId: string, newLagCurrentMs: number): Promise<{ dependency: EventDependency; cascaded: CascadeUpdate[] }>;
    onCalendarMutation(callback: (mutation: CalendarMutationEvent) => void): () => void;

  }

  interface OfficeAddinAPI {
    status(): Promise<{ word: boolean; powerpoint: boolean; excel: boolean; certTrusted: boolean; certExists: boolean; serverRunning: boolean }>;
    startServer(): Promise<{ success: boolean; error?: string }>;
    stopServer(): Promise<{ success: boolean; error?: string }>;
    sideload(): Promise<{ success: boolean; error?: string }>;
    remove(): Promise<{ success: boolean; error?: string }>;
    trustCert(): Promise<{ success: boolean; error?: string }>;
    removeCert(): Promise<{ success: boolean; error?: string }>;
    deleteCert(): Promise<{ success: boolean; error?: string }>;
  }

  interface WorkspaceReport {
    id: string;
    workspace_id: string;
    report_type: string;
    report_data: string;
    in_depth_report: string | null;
    what_youre_working_on: string | null;
    suggested_mini_apps: string | null;
    status: 'pending' | 'running' | 'completed' | 'failed';
    error: string | null;
    created_at: string;
    completed_at: string | null;
  }

  interface ReportsAPI {
    getLatest(reportType: string): Promise<WorkspaceReport | null>;
    get(reportId: string): Promise<WorkspaceReport | null>;
    update(reportId: string, reportData: string): Promise<void>;
  }

  type ScannerEvent =
    | { type: 'progress'; text: string }
    | { type: 'file_activity'; path: string; tool: string }
    | { type: 'complete'; reportId: string; reportData: string }
    | { type: 'error'; error: string };

  interface ScannerAPI {
    start(): Promise<void>;
    onEvent(callback: (event: ScannerEvent) => void): () => void;
  }

  type PaperSource = 'arxiv' | 'pubmed' | 'openalex' | 'biorxiv';

  interface FetchedPaper {
    id: string;
    source: PaperSource;
    externalId: string;
    doi: string | null;
    title: string;
    abstract: string;
    authors: string[];
    authorsLine: string;
    venue: string;
    publishedAt: string;
    url: string;
    pdfUrl: string | null;
    matchedTopic: string;
    sources: PaperSource[];
  }

  interface PapersFetchResult {
    papers: FetchedPaper[];
    fetchedAt: string;
    errors: { source: PaperSource; topic: string; message: string }[];
  }

  interface PapersAPI {
    fetch(input: {
      topics: string[];
      maxPerTopic?: number;
      maxTotal?: number;
      sources?: PaperSource[];
    }): Promise<PapersFetchResult>;
  }

  type BriefingType =
    | 'suggested_action'
    | 'suggested_tool'
    | 'paper'
    | 'citation'
    | 'grant'
    | 'writing_agent';

  type BriefingStatus = 'new' | 'opened' | 'dismissed';

  interface Briefing {
    id: string;
    workspace_id: string;
    type: BriefingType;
    /** JSON string; shape depends on `type` (see BriefingData* interfaces). */
    briefing_data: string;
    why_im_suggesting_this: string | null;
    status: BriefingStatus;
    source_report_id: string | null;
    created_at: string;
    updated_at: string;
  }

  interface BriefingDataSuggestedTool {
    name: string;
    details_on_what_to_build: string;
  }

  interface BriefingDataSuggestedAction {
    title: string;
    description: string;
    chat_prompt: string;
  }

  interface BriefingDataPaper {
    title: string;
    authors?: string[];
    url?: string;
    abstract?: string;
  }

  interface BriefingDataCitation {
    paper_title: string;
    citing_work: string;
    url?: string;
  }

  interface BriefingDataGrant {
    title: string;
    agency: string;
    deadline?: string;
    url?: string;
  }

  interface BriefingDataWritingAgent {
    /** Relative path (within workspace) to the DOCX manuscript. */
    file_path: string;
    /** LLM-generated card title contextual to the manuscript. */
    title?: string;
    /** What the user might pick up next on this manuscript. */
    description: string;
    /**
     * Pre-filled user message produced by analyzing the manuscript during
     * onboarding. Auto-sent to the chat when the user opens the briefing.
     */
    chat_prompt: string;
  }

  interface BriefingsAPI {
    list(filter?: {
      status?: BriefingStatus[];
      limit?: number;
    }): Promise<Briefing[]>;
    setStatus(id: string, status: BriefingStatus): Promise<void>;
    /** Subscribe to create/update/status changes. Returns unsubscribe. */
    onChanged(callback: () => void): () => void;
  }

  interface ScannedFile {
    id: string;
    workspace_id: string;
    report_id: string | null;
    file_path: string;
    file_name: string;
    file_type: 'manuscript' | 'grant' | 'presentation';
    created_at: string;
  }

  interface ScannedFilesAPI {
    getByType(fileType: 'manuscript' | 'grant' | 'presentation'): Promise<ScannedFile[]>;
    getAll(): Promise<ScannedFile[]>;
  }

  interface Window {
    chatAPI: ChatAPI;
    calendarAPI: CalendarAPI;
    filesAPI: FilesAPI;
    workspacesAPI: WorkspacesAPI;
    sessionsAPI: SessionsAPI;
    containerAPI: ContainerAPI;
    settingsAPI: SettingsAPI;
    commandLogAPI: CommandLogAPI;
    systemLogAPI: SystemLogAPI;
    jupyterAPI: JupyterAPI;
    authAPI: AuthAPI;
    electronAPI: ElectronAPI;
    reactionPromptAPI: ReactionPromptAPI;
    reactionSourcesAPI: ReactionSourcesAPI;
    academiaFileAPI: AcademiaFileAPI;
    scheduledTasksAPI: ScheduledTasksAPI;
    fileMonitorAPI: FileMonitorAPI;
    browserMonitorAPI: BrowserMonitorAPI;
    debugAPI: DebugAPI;
    writingAgentAPI: WritingAgentAPI;
    miniAppsAPI: MiniAppsAPI;
    officeAddinAPI: OfficeAddinAPI;
    reportsAPI: ReportsAPI;
    scannerAPI: ScannerAPI;
    papersAPI: PapersAPI;
    briefingsAPI: BriefingsAPI;
    scannedFilesAPI: ScannedFilesAPI;
    nativeToolsAPI: { getUrl(toolId: string): Promise<string | null> };
    academiaAPI: {
      fetch(method: string, endpoint: string, data?: unknown): Promise<unknown>;
    };
  }
}
