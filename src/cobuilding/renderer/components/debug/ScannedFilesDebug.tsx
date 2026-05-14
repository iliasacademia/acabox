import React, { useEffect, useState } from 'react';

type FileTagType = 'manuscript' | 'grant' | 'presentation' | 'reference';

const TAG_LABELS: Record<FileTagType, string> = {
  manuscript: 'Manuscripts',
  grant: 'Grants',
  presentation: 'Presentations',
  reference: 'References',
};

const TAG_ORDER: FileTagType[] = ['manuscript', 'grant', 'presentation', 'reference'];

interface TagCount {
  type: FileTagType;
  count: number;
  files: { file_path: string; file_name: string }[];
}

export const ScannedFilesDebug: React.FC = () => {
  const [tagCounts, setTagCounts] = useState<TagCount[]>([]);
  const [expandedTag, setExpandedTag] = useState<FileTagType | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.scannedFilesAPI.getAll().then((files) => {
      const grouped = new Map<FileTagType, { file_path: string; file_name: string }[]>();
      for (const tag of TAG_ORDER) grouped.set(tag, []);
      for (const f of files) {
        const list = grouped.get(f.file_type as FileTagType);
        if (list) list.push({ file_path: f.file_path, file_name: f.file_name });
      }
      setTagCounts(
        TAG_ORDER.map((type) => ({
          type,
          count: grouped.get(type)!.length,
          files: grouped.get(type)!,
        })),
      );
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const total = tagCounts.reduce((sum, t) => sum + t.count, 0);

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Scanned Files</h3>

      {loading ? (
        <div className="debugSection__progress">Loading...</div>
      ) : total === 0 ? (
        <div className="debugSection__progress">No scanned files found. Run a workspace scan first.</div>
      ) : (
        <>
          <div className="debugSection__infoRow" style={{ marginBottom: 12 }}>
            <span className="debugSection__infoLabel">Total tagged files:</span>
            <code className="debugSection__infoValue">{total}</code>
          </div>

          <div className="storageTree">
            {tagCounts.map(({ type, count, files }) => (
              <React.Fragment key={type}>
                <div
                  className="storageTree__row"
                  style={{ cursor: count > 0 ? 'pointer' : 'default' }}
                  onClick={() => count > 0 && setExpandedTag(expandedTag === type ? null : type)}
                >
                  <span className="storageTree__label storageTree__label--group">
                    {count > 0 && (expandedTag === type ? '▾ ' : '▸ ')}
                    {TAG_LABELS[type]}
                  </span>
                  <code className="debugSection__infoValue">{count}</code>
                </div>
                {expandedTag === type && files.map((f) => (
                  <div
                    key={f.file_path}
                    className="storageTree__row"
                    style={{ paddingLeft: 32 }}
                  >
                    <span className="storageTree__desc debugSection__mono">{f.file_path}</span>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
