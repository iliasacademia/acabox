import React, { useEffect, useState, type FC } from 'react';
import { XIcon } from 'lucide-react';

type FileContent = Awaited<ReturnType<typeof window.filesAPI.readFile>>;

interface FileViewerProps {
  filePath: string;
  onClose: () => void;
}

export const FileViewer: FC<FileViewerProps> = ({ filePath, onClose }) => {
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

  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <div className="fileViewer">
      <div className="fileViewerHeader">
        <span className="fileViewerTitle">{fileName}</span>
        <button className="btn btn--ghost btn--icon-xs" onClick={onClose}>
          <XIcon style={{ width: 16, height: 16 }} />
        </button>
      </div>
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
