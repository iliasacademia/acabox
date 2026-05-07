// Install global error capture (uncaught exceptions, unhandled rejections,
// console.error, failed fetches, resource load failures). Imported for side
// effects — keep this first so handlers are in place before any bridge or
// app code runs.
import "./error-capture";

export {};

interface BridgeFilesAPI {
  readFile(path: string): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  copyFile(sourcePath: string, destinationDir: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
  downloadFile(filename: string, content: string): Promise<unknown>;
  showInFinder(path: string): Promise<unknown>;
  selectFile(filters?: unknown[]): Promise<unknown>;
  selectDirectory(): Promise<unknown>;
  readDirectory(path: string): Promise<unknown>;
}

interface BridgeKernelAPI {
  connect(kernelName: string): Promise<unknown>;
  executeCode(code: string): Promise<unknown>;
}

interface BridgeContainerAPI {
  exec(command: string, args: string[]): Promise<unknown>;
}

interface BridgeErrorAPI {
  // Ask the host to post a fix request for this error into the active chat
  // thread. The host owns the prompt template (it knows the app's dir name).
  requestFix(error: {
    kind: string;
    message: string;
    stack?: string;
    source?: string;
    timestamp: number;
  }): Promise<unknown>;
}

export interface AnthropicMessage {
  id: string;
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'file'; path: string } | { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'file'; path: string } | { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string };

export interface AnthropicParams {
  messages: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>;
  model?: string;
  max_tokens?: number;
  system?: string;
}

interface BridgeAcademiaAPI {
  fetch(method: string, endpoint: string, data?: unknown): Promise<unknown>;
}

interface BridgeAnthropicAPI {
  complete(params: AnthropicParams): Promise<AnthropicMessage>;
  stream(params: AnthropicParams, onChunk: (text: string) => void): Promise<AnthropicMessage>;
}

let requestId = 0;
const pendingRequests = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

window.addEventListener("message", (event) => {
  if (event.data?.type === "response" && event.data.id) {
    const handler = pendingRequests.get(event.data.id);
    if (handler) {
      pendingRequests.delete(event.data.id);
      if (event.data.error) {
        handler.reject(new Error(event.data.error));
      } else {
        handler.resolve(event.data.result);
      }
    }
  }
});

function request(type: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const id = `req-${++requestId}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    window.parent.postMessage({ type, id, ...args }, "*");
  });
}

const filesAPI: BridgeFilesAPI = {
  readFile: (path: string) => request("readFile", { path }),
  writeFile: (path: string, content: string) => request("writeFile", { path, content }),
  copyFile: (sourcePath: string, destinationDir: string) =>
    request("copyFile", { sourcePath, destinationDir }),
  deleteFile: (path: string) => request("deleteFile", { path }),
  downloadFile: (filename: string, content: string) => request("downloadFile", { filename, content }),
  showInFinder: (path: string) => request("showInFinder", { path }),
  selectFile: (filters?: unknown[]) => request("selectFile", { filters }),
  selectDirectory: () => request("selectDirectory"),
  readDirectory: (path: string) => request("readDirectory", { path }),
};

const kernel: BridgeKernelAPI = {
  connect: (kernelName: string) => request("connectKernel", { kernelName }),
  executeCode: (code: string) => request("executeCode", { code }),
};

const containerAPI: BridgeContainerAPI = {
  exec: (command: string, args: string[]) => request("executeCommand", { command, args }),
};

const errorAPI: BridgeErrorAPI = {
  requestFix: (error) => request("requestFix", { error }),
};

const academiaAPI: BridgeAcademiaAPI = {
  fetch: (method: string, endpoint: string, data?: unknown) =>
    request('academia:fetch', { method, endpoint, data }),
};

const anthropicAPI: BridgeAnthropicAPI = {
  // Delegates to the standard request/response bridge. The main process
  // validates all params and returns the full message once generation finishes.
  complete(params) {
    return request('anthropic:complete', params as Record<string, unknown>) as Promise<AnthropicMessage>;
  },

  // Streaming uses a separate postMessage protocol from the standard
  // request/response pattern because multiple events (chunk, done, error) need
  // to arrive for a single request. The bridge registers its own window message
  // listener keyed by the request id and removes it on terminal events (done or
  // error) to avoid accumulating listeners over the page lifetime.
  stream(params, onChunk) {
    const id = `req-${++requestId}`;
    return new Promise<AnthropicMessage>((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        const { type: t, requestId: rid } = event.data ?? {};
        if (rid !== id) return;
        if (t === 'anthropic:chunk') {
          onChunk(event.data.text);
        } else if (t === 'anthropic:done') {
          window.removeEventListener('message', handler);
          resolve(event.data.message);
        } else if (t === 'anthropic:error') {
          window.removeEventListener('message', handler);
          reject(new Error(event.data.error));
        }
      };
      window.addEventListener('message', handler);
      window.parent.postMessage({ type: 'anthropic:stream', id, ...params }, '*');
    });
  },
};

let _workspacePath = "";
window.addEventListener("message", (event) => {
  if (event.data?.type === "init" && event.data.workspacePath) {
    _workspacePath = event.data.workspacePath;
  }
});

Object.assign(window, { filesAPI, kernel, containerAPI, errorAPI, academiaAPI, anthropicAPI, getWorkspacePath: () => _workspacePath });
