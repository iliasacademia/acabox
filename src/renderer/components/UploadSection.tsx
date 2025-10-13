import React, { useState, useEffect } from 'react';

interface UploadedFile {
  title: string;
  file_file_name: string;
  status: number;
}

const UploadSection: React.FC = () => {
  const [selectedPath, setSelectedPath] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);

  useEffect(() => {
    window.electronAPI.on('file-uploaded', (_event: any, result: any) => {
      console.log(result);
      setUploadedFiles((prev) => [
        ...prev,
        {
          title: result.paper.title,
          file_file_name: result.paper.file_file_name,
          status: result.status,
        },
      ]);
    });
  }, []);

  const handleSelectFolder = async () => {
    const folderPath = await window.electronAPI.invoke('select-folder');
    if (folderPath) {
      setSelectedPath(folderPath);
      setUploadedFiles([]); // Clear previous uploads
      await window.electronAPI.invoke('upload-files', folderPath);
    }
  };

  const getStatusEmoji = (status: number) => {
    if (status >= 200 && status < 300) return '✅';
    if (status >= 300 && status < 400) return '⚠️';
    if (status >= 400 && status < 500) return '❌';
    return '🔥';
  };

  return (
    <div>
      <button onClick={handleSelectFolder}>Choose Folder</button>
      {selectedPath && <div>Selected folder: {selectedPath}</div>}
      {uploadedFiles.length > 0 && (
        <div>
          <h1>Uploaded Files</h1>
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>File</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {uploadedFiles.map((file, index) => (
                <tr key={index}>
                  <td>{file.title}</td>
                  <td>{file.file_file_name}</td>
                  <td style={{ textAlign: 'right' }}>{getStatusEmoji(file.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default UploadSection;
