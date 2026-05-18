import React, { useState } from 'react';

type OpStatus = 'idle' | 'busy';

export const ExportDebug: React.FC = () => {
  const [exportStatus, setExportStatus] = useState<OpStatus>('idle');
  const [exportResult, setExportResult] = useState<{ savedPath?: string; error?: string } | null>(null);

  const [importStatus, setImportStatus] = useState<OpStatus>('idle');
  const [importResult, setImportResult] = useState<{ workspaceName?: string; workspaceDir?: string; error?: string } | null>(null);

  const handleExport = async () => {
    setExportStatus('busy');
    setExportResult(null);
    try {
      const res = await window.debugAPI.exportWorkspace();
      if (res.canceled) {
        setExportResult(null);
      } else if (res.ok && res.savedPath) {
        setExportResult({ savedPath: res.savedPath });
      } else {
        setExportResult({ error: res.error ?? 'Unknown error' });
      }
    } catch (err) {
      setExportResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setExportStatus('idle');
    }
  };

  const handleImport = async () => {
    setImportStatus('busy');
    setImportResult(null);
    try {
      const res = await window.debugAPI.importWorkspace();
      if (res.canceled) {
        setImportStatus('idle');
        return;
      }
      if (!res.ok || !res.workspaceId) {
        setImportResult({ error: res.error ?? 'Unknown error' });
        setImportStatus('idle');
        return;
      }
      await window.containerAPI.relaunchApp();
    } catch (err) {
      setImportResult({ error: err instanceof Error ? err.message : String(err) });
      setImportStatus('idle');
    }
  };

  const busy = exportStatus === 'busy' || importStatus === 'busy';

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Export / Import</h3>

      <div style={{ marginBottom: 24 }}>
        <p className="debugSection__desc" style={{ marginBottom: 10 }}>
          Export all workspace data — chats, reactions, applications, and briefings — as a ZIP file.
        </p>
        <div className="debugSection__actions">
          <button
            className="debugSection__btn"
            onClick={handleExport}
            disabled={busy}
          >
            {exportStatus === 'busy' ? 'Exporting...' : 'Export Workspace Data'}
          </button>
        </div>
        {exportResult?.savedPath && (
          <div className="debugSection__progress" style={{ marginTop: 8 }}>
            Saved to: <code>{exportResult.savedPath}</code>
          </div>
        )}
        {exportResult?.error && (
          <div className="debugSection__error" style={{ marginTop: 8 }}>
            Error: {exportResult.error}
          </div>
        )}
      </div>

      <div>
        <p className="debugSection__desc" style={{ marginBottom: 10 }}>
          Import a previously exported workspace ZIP. The app will restart with the imported workspace active.
        </p>
        <div className="debugSection__actions">
          <button
            className="debugSection__btn"
            onClick={handleImport}
            disabled={busy}
          >
            {importStatus === 'busy' ? 'Importing...' : 'Import Workspace Data'}
          </button>
        </div>
        {importResult?.workspaceName && (
          <div className="debugSection__progress" style={{ marginTop: 8 }}>
            Imported as <strong>{importResult.workspaceName}</strong> at <code>{importResult.workspaceDir}</code>.
          </div>
        )}
        {importResult?.error && (
          <div className="debugSection__error" style={{ marginTop: 8 }}>
            Error: {importResult.error}
          </div>
        )}
      </div>
    </div>
  );
};
