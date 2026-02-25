import React from 'react';
import { SearchFilesData, SearchFilesMatchedFile } from '../types/conversation';

interface SearchFilesMessageProps {
  data: SearchFilesData;
  onOpenFile?: (file: SearchFilesMatchedFile, page?: string) => void;
  /** True once a search_files_result message has arrived — hides the reading spinner */
  isSearchComplete?: boolean;
}

export function SearchFilesMessage({ data, onOpenFile, isSearchComplete }: SearchFilesMessageProps) {
  const files = data.matched_files ?? [];

  if (files.length === 0) {
    // No files found yet (or no matches) — show spinner while waiting for result
    return (
      <div className="searchFilesSearching">
        <span className="searchFilesSpinner" aria-hidden="true" />
        <span className="searchFilesSearchingText">Searching your files…</span>
      </div>
    );
  }

  // Files found, answer being synthesised (or complete)
  return (
    <div className="searchFilesWithFiles">
      {!isSearchComplete && (
        <div className="searchFilesReadingBanner">
          <span className="searchFilesSpinner" aria-hidden="true" />
          <span className="searchFilesReadingText">Reading content…</span>
        </div>
      )}
      <ul className="searchFilesList">
        {files.map((file) => (
          <li key={file.file_id} className="searchFilesItem">
            <div className="searchFilesItemHeader">
              <span className="searchFilesFileName">{file.file_name}</span>
              {(file.local_path || file.url) && onOpenFile && (
                <button
                  type="button"
                  className="searchFilesOpenButton"
                  onClick={() => onOpenFile(file)}
                  title={`Open ${file.file_name}`}
                  aria-label={`Open ${file.file_name}`}
                >
                  <OpenExternalIcon />
                  <span>Open</span>
                </button>
              )}
            </div>
            <ul className="searchFilesChunks">
              {file.chunks.map((chunk, i) => (
                <li key={i} className="searchFilesChunk">
                  <span className="searchFilesChunkMeta">
                    {onOpenFile && (file.local_path || file.url) ? (
                      <button
                        type="button"
                        className="searchFilesPageLink"
                        onClick={() => onOpenFile(file, chunk.page)}
                        title={`Open at page ${chunk.page}`}
                      >
                        p.&nbsp;{chunk.page}
                      </button>
                    ) : (
                      <>p.&nbsp;{chunk.page}</>
                    )}
                    {chunk.section && (
                      <> &middot; <span className="searchFilesChunkSection">{chunk.section}</span></>
                    )}
                  </span>
                  <blockquote className="searchFilesChunkText">{chunk.text}</blockquote>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OpenExternalIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M1.5 1.5h4v1.25H2.75v7.5h7.5V8h1.25v4H1.5v-10z" fill="currentColor" />
      <path d="M8 1.5h3.5V5H10.25V3.31L5.78 7.78 4.72 6.72 9.19 2.25H8V1.5z" fill="currentColor" />
    </svg>
  );
}
