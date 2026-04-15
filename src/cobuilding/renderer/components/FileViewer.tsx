import React, { useEffect, useState, type FC } from 'react';
import { MarkdownView } from './fileViewers/MarkdownView';
import { CsvView } from './fileViewers/CsvView';
import { PdfView } from './fileViewers/PdfView';
import { LatexView } from './fileViewers/LatexView';

type FileContent = Awaited<ReturnType<typeof window.filesAPI.readFile>>;

interface FileViewerProps {
  filePath: string;
}

export const FileViewer: FC<FileViewerProps> = ({ filePath }) => {
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setFileContent(null);

    window.filesAPI.readFile(filePath).then((result) => {
      if (stale) return;
      setFileContent(result);
      setLoading(false);
    });

    return () => {
      stale = true;
    };
  }, [filePath]);

  // PDF and CSV viewers manage their own scrolling/padding; the default body
  // adds padding and overflow which would conflict.
  const flush =
    fileContent != null &&
    !('error' in fileContent) &&
    (fileContent.type === 'pdf' || fileContent.type === 'csv');

  return (
    <div className="fileViewer">
      <div className={flush ? 'fileViewerBody fileViewerBodyFlush' : 'fileViewerBody'}>
        {loading && <p className="fileViewerMessage">Loading...</p>}
        {fileContent && <FileContentView content={fileContent} />}
      </div>
    </div>
  );
};

const FileContentView: FC<{ content: FileContent }> = ({ content }) => {
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

  if (content.type === 'latex') {
    return <LatexView content={content.content} />;
  }

  return <pre className="fileViewerPre">{content.content}</pre>;
};
