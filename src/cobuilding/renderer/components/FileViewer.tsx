import React, { useEffect, useState, type FC } from 'react';
import { MarkdownView } from './fileViewers/MarkdownView';
import { CsvView } from './fileViewers/CsvView';
import { PdfView } from './fileViewers/PdfView';
import { XlsxView } from './fileViewers/XlsxView';
import { CodeView } from './CodeView';
import { copyableText } from './fileViewers/CopyFileButton';

type FileContent = Awaited<ReturnType<typeof window.filesAPI.readFile>>;

interface FileViewerProps {
  filePath: string;
  /**
   * Told the file's copyable text once it has loaded, and null while loading
   * or when the file has none — so a Copy button outside the viewer can show
   * only when there is something to copy. See `copyableText`.
   */
  onCopyableText?: (text: string | null) => void;
}

export const FileViewer: FC<FileViewerProps> = ({ filePath, onCopyableText }) => {
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setFileContent(null);
    setReadError(null);
    onCopyableText?.(null);

    window.filesAPI.readFile(filePath).then((result) => {
      if (stale) return;
      setFileContent(result);
      setLoading(false);
      onCopyableText?.(copyableText(result));
    }).catch((err: Error) => {
      // A refused read (e.g. a chat link to a path outside the shared
      // folders) used to leave "Loading..." up forever.
      if (stale) return;
      setLoading(false);
      setReadError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    });

    return () => {
      stale = true;
    };
  }, [filePath]);

  // PDF, CSV, and spreadsheet viewers manage their own scrolling/padding;
  // the default body adds padding and overflow which would conflict.
  const flush =
    fileContent != null &&
    !('error' in fileContent) &&
    (fileContent.type === 'pdf' || fileContent.type === 'csv' || fileContent.type === 'spreadsheet');

  return (
    // One descriptor here covers every viewer this wrapper dispatches to —
    // markdown, code, CSV, spreadsheet, PDF text layer — so quoting a cell or
    // a line is attributed to the file it came from rather than to nothing.
    <div className="fileViewer" data-quote-source={`file:${filePath}`}>
      <div className={flush ? 'fileViewerBody fileViewerBodyFlush' : 'fileViewerBody'}>
        {loading && <p className="fileViewerMessage">Loading...</p>}
        {readError && <p className="fileViewerMessage">Couldn’t open this file. {readError}</p>}
        {fileContent && <FileContentView content={fileContent} filePath={filePath} />}
      </div>
    </div>
  );
};

const FileContentView: FC<{ content: FileContent; filePath: string }> = ({ content, filePath }) => {
  if ('error' in content) {
    const sizeMB = (content.size / 1_000_000).toFixed(1);
    return <p className="fileViewerMessage">File is too large to view ({sizeMB} MB)</p>;
  }

  if (content.type === 'image') {
    return <img src={content.fileUrl} alt="File preview" className="fileViewerImage" />;
  }

  if (content.type === 'pdf') {
    return <PdfView fileUrl={content.fileUrl} />;
  }

  if (content.type === 'markdown') {
    return <MarkdownView content={content.content} />;
  }

  if (content.type === 'csv') {
    return <CsvView content={content.content} delimiter={content.delimiter} />;
  }

  if (content.type === 'spreadsheet') {
    return <XlsxView base64={content.base64} />;
  }

  return <CodeView content={content.content} path={filePath} fallbackClassName="fileViewerPre" />;
};
