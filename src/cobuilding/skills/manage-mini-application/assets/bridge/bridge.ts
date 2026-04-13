// Install global error capture (uncaught exceptions, unhandled rejections,
// console.error, failed fetches, resource load failures). Imported for side
// effects — keep this first so handlers are in place before any bridge or
// app code runs.
import "./error-capture";

export {};

interface BridgeFilesAPI {
  readFile(path: string): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
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

let _workspacePath = "";
window.addEventListener("message", (event) => {
  if (event.data?.type === "init" && event.data.workspacePath) {
    _workspacePath = event.data.workspacePath;
  }
});

Object.assign(window, { filesAPI, kernel, containerAPI, getWorkspacePath: () => _workspacePath });
