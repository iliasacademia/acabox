import React from "react";
import { FolderOpenIcon, DownloadIcon } from "lucide-react";

declare const window: Window & {
  filesAPI: {
    readFile(path: string): Promise<{ type: string; content: string }>;
    readDirectory(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
    downloadFile(filename: string, content: string): Promise<unknown>;
    showInFinder(path: string): Promise<unknown>;
  };
};

export interface OutputFile {
  /** File name (e.g. "DE_results.csv") */
  name: string;
  /** Short description of the file */
  description: string;
  /** Relative path from workspace root (e.g. ".applications/myApp/output/DE_results.csv") */
  path: string;
}

interface OutputFileListProps {
  /** List of output files to display */
  files: OutputFile[];
  /** Relative path to the output directory (e.g. ".applications/myApp/output") */
  outputDir: string;
}

export function OutputFileList({ files, outputDir }: OutputFileListProps) {
  if (files.length === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-md font-medium text-gray-700 uppercase tracking-wide">Output Files</h2>
        <button
          onClick={async () => {
            try { await window.filesAPI.showInFinder(outputDir); } catch {}
          }}
          title="Open output folder"
          className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <FolderOpenIcon className="w-5 h-5" />
        </button>
      </div>
      <div className="divide-y divide-gray-100">
        {files.map((file) => (
          <OutputFileRow key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}

function OutputFileRow({ file }: { file: OutputFile }) {
  const handleDownload = async () => {
    try {
      const result = await window.filesAPI.readFile(file.path);
      if (result.type === "text") {
        await window.filesAPI.downloadFile(file.name, result.content);
      }
    } catch {
      // ignore — file may not exist yet
    }
  };

  return (
    <div className="py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-mono text-gray-800">{file.name}</div>
        <div className="text-sm text-gray-500 mt-0.5">{file.description}</div>
      </div>
      <button
        onClick={handleDownload}
        title="Download"
        className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0"
      >
        <DownloadIcon className="w-5 h-5" />
      </button>
    </div>
  );
}
