import React, { useState, useEffect } from 'react';
import { useAssistantRuntime, useComposerRuntime } from '@assistant-ui/react';
import { ArrowUpRightIcon, SparklesIcon, XIcon } from 'lucide-react';

interface WorkingOnItem {
  file_path: string;
  description: string;
}

interface SuggestedMiniApp {
  name: string;
  why_im_suggesting_this: string;
  details_on_what_to_build: string;
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

const DIRECTORY_ORGANIZATION_PROMPT = `Please help me organize my research directory. First, inspect the workspace and understand the current file structure, research projects, documents, data, scripts, outputs, and any existing naming conventions. Then recommend an effective organization plan for the directory.

YOU MUST ALWAYS present me with a clear plan before proceeding to take any actions or make any file modifications. Do not move, rename, delete, rewrite, or create files until I explicitly approve the plan.`;

export function HomePage({
  workspacePath,
  onSelectFile,
  onSwitchToChat,
}: {
  workspacePath: string;
  onSelectFile: (filePath: string) => void;
  onSwitchToChat: () => void;
}) {
  const [workingOnItems, setWorkingOnItems] = useState<WorkingOnItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDirectoryBriefing, setShowDirectoryBriefing] = useState(true);
  const [suggestedMiniApps, setSuggestedMiniApps] = useState<SuggestedMiniApp[]>([]);
  const [dismissedApps, setDismissedApps] = useState<Set<string>>(new Set());
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  useEffect(() => {
    window.reportsAPI.getLatest('directory_scan').then((report) => {
      if (!report) {
        setLoading(false);
        return;
      }
      if (report.what_youre_working_on) {
        try {
          const parsed = JSON.parse(report.what_youre_working_on);
          if (Array.isArray(parsed)) setWorkingOnItems(parsed);
        } catch { /* ignore */ }
      }
      if (report.suggested_mini_apps) {
        try {
          const parsed = JSON.parse(report.suggested_mini_apps);
          if (Array.isArray(parsed)) setSuggestedMiniApps(parsed);
        } catch { /* ignore */ }
      }
      setLoading(false);
    });
  }, []);

  const visibleItems = workingOnItems.slice(0, MAX_VISIBLE_CARDS);

  const visibleMiniApps = suggestedMiniApps
    .filter((app) => !dismissedApps.has(app.name))
    .slice(0, 3);

  const handleStartDirectoryOrganization = () => {
    assistantRuntime.switchToNewThread();
    onSwitchToChat();
    setTimeout(() => {
      composerRuntime.setText(DIRECTORY_ORGANIZATION_PROMPT);
      composerRuntime.send();
    }, 100);
  };

  const handleStartMiniApp = (app: SuggestedMiniApp) => {
    assistantRuntime.switchToNewThread();
    onSwitchToChat();
    setTimeout(() => {
      composerRuntime.setText(
        `Please build the following mini-app for me:\n\n${app.details_on_what_to_build}`
      );
      composerRuntime.send();
    }, 100);
  };

  const handleDismissMiniApp = (appName: string) => {
    setDismissedApps((prev) => new Set(prev).add(appName));
  };

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
            {showDirectoryBriefing && (
              <div className="homeBriefingCard homeBriefingCard--action">
                <button
                  type="button"
                  className="homeBriefingCard__close"
                  aria-label="Dismiss briefing"
                  onClick={() => setShowDirectoryBriefing(false)}
                >
                  <XIcon className="homeBriefingCard__closeIcon" />
                </button>
                <div className="homeBriefingCard__eyebrow">
                  <SparklesIcon className="homeBriefingCard__eyebrowIcon" />
                  <span>I can do this for you</span>
                </div>
                <h3 className="homeBriefingCard__title">Organize your research directory</h3>
                <p className="homeBriefingCard__description">
                  I will figure out an effective way to organize the files in your workspace.
                </p>
                <div className="homeBriefingCard__actions">
                  <button
                    type="button"
                    className="homeBriefingCard__button homeBriefingCard__button--primary"
                    onClick={handleStartDirectoryOrganization}
                  >
                    Yes, do it
                    <ArrowUpRightIcon className="homeBriefingCard__buttonIcon" />
                  </button>
                  <button
                    type="button"
                    className="homeBriefingCard__button homeBriefingCard__button--secondary"
                    onClick={() => setShowDirectoryBriefing(false)}
                  >
                    Not Now
                  </button>
                </div>
              </div>
            )}

            {visibleMiniApps.map((app) => (
              <div key={app.name} className="homeBriefingCard homeBriefingCard--action">
                <button
                  type="button"
                  className="homeBriefingCard__close"
                  aria-label="Dismiss briefing"
                  onClick={() => handleDismissMiniApp(app.name)}
                >
                  <XIcon className="homeBriefingCard__closeIcon" />
                </button>
                <div className="homeBriefingCard__eyebrow">
                  <SparklesIcon className="homeBriefingCard__eyebrowIcon" />
                  <span>I can do this for you</span>
                </div>
                <h3 className="homeBriefingCard__title">{app.name}</h3>
                <p className="homeBriefingCard__description">
                  {app.why_im_suggesting_this}
                </p>
                <div className="homeBriefingCard__actions">
                  <button
                    type="button"
                    className="homeBriefingCard__button homeBriefingCard__button--primary"
                    onClick={() => handleStartMiniApp(app)}
                  >
                    Build it
                    <ArrowUpRightIcon className="homeBriefingCard__buttonIcon" />
                  </button>
                  <button
                    type="button"
                    className="homeBriefingCard__button homeBriefingCard__button--secondary"
                    onClick={() => handleDismissMiniApp(app.name)}
                  >
                    Not Now
                  </button>
                </div>
              </div>
            ))}

            {(showDirectoryBriefing ? 1 : 0) + visibleMiniApps.length < 2 && (
              <div className="homeBriefingCard homeBriefingCard--placeholder" />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
