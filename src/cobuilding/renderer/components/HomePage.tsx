import React, { useState, useEffect } from 'react';
import { ArrowUpRightIcon } from 'lucide-react';

interface WorkingOnItem {
  file_path: string;
  description: string;
}

function basename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function parentDir(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}

/** Derive a short tag from the file extension. */
function fileTag(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'docx': case 'doc': case 'gdoc': return 'DOCUMENT';
    case 'tex': case 'latex': return 'MANUSCRIPT';
    case 'md': case 'txt': case 'rtf': return 'DOCUMENT';
    case 'pdf': return 'PDF';
    case 'py': case 'r': case 'jl': case 'ipynb': return 'SCRIPT';
    case 'csv': case 'tsv': case 'xlsx': case 'xls': return 'DATA';
    case 'bib': return 'BIBLIOGRAPHY';
    case 'pptx': case 'ppt': return 'PRESENTATION';
    default: return 'FILE';
  }
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

const MAX_VISIBLE_CARDS = 3;

export function HomePage({
  workspacePath,
  onSelectFile,
}: {
  workspacePath: string;
  onSelectFile: (filePath: string) => void;
}) {
  const [workingOnItems, setWorkingOnItems] = useState<WorkingOnItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.reportsAPI.getLatest('directory_scan').then((report) => {
      if (!report?.what_youre_working_on) {
        setLoading(false);
        return;
      }
      try {
        const parsed = JSON.parse(report.what_youre_working_on);
        if (Array.isArray(parsed)) setWorkingOnItems(parsed);
      } catch {
        // ignore malformed JSON
      }
      setLoading(false);
    });
  }, []);

  const visibleItems = workingOnItems.slice(0, MAX_VISIBLE_CARDS);

  return (
    <div className="pageShell">
      <div className="pageShell__inner">
        {/* Page header / Working On section */}
        <div className="pageShell__headerBlock">
          <div className="pageShell__stats">WORKSPACE &middot; {formatDate()}</div>
          <h1 className="pageShell__title">
            Working on
            {workingOnItems.length > 0 && (
              <span className="homeTitle__count"> &middot; {workingOnItems.length} active</span>
            )}
          </h1>
          <p className="pageShell__subtitle">
            Click a file to open it with the agent alongside
          </p>
        </div>

        {loading ? (
          <div className="homeSection__empty">Loading&hellip;</div>
        ) : workingOnItems.length === 0 ? (
          <div className="homeSection__empty">
            No active files detected yet.
          </div>
        ) : (
          <div className="homeCardGrid">
            {visibleItems.map((item) => (
              <button
                key={item.file_path}
                className="homeCard"
                onClick={() => onSelectFile(`${workspacePath}/${item.file_path}`)}
              >
                <div className="homeCard__top">
                  <span className="homeCard__tag">{fileTag(item.file_path)}</span>
                  <ArrowUpRightIcon className="homeCard__arrow" style={{ width: 14, height: 14 }} />
                </div>
                <div className="homeCard__title">
                  {basename(item.file_path)}
                </div>
                <div className="homeCard__path">
                  {parentDir(item.file_path) || item.file_path}
                </div>
                <div className="homeCard__description">
                  {item.description}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Briefing section */}
        <section className="homeSection homeSection--briefing">
          <div className="homeSection__headerRow">
            <h2 className="homeSection__heading">Briefing</h2>
          </div>
          <p className="homeSection__subtitle">
            What's worth your attention from your routines and from me
          </p>
          <div className="homeBriefingGrid">
            <div className="homeBriefingCard homeBriefingCard--placeholder" />
            <div className="homeBriefingCard homeBriefingCard--placeholder" />
          </div>
          <div className="homeBriefingGrid homeBriefingGrid--full">
            <div className="homeBriefingCard homeBriefingCard--placeholder" />
          </div>
        </section>
      </div>
    </div>
  );
}
