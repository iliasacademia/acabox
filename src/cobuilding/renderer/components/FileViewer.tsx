import React, { useEffect, useState, type FC } from 'react';

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

  return (
    <div className="fileViewer">
      <div className="fileViewerBody">
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

  return <pre className="fileViewerPre">{content.content}</pre>;
};
