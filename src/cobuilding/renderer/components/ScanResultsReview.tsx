import React, { useState, useEffect } from 'react';
import { PencilIcon, ArrowRightIcon } from 'lucide-react';
import './WorkspaceOnboarding.css';
import './ScanResultsReview.css';

interface ScanResultsReviewProps {
  reportId: string;
  onComplete: () => void;
}

const ScanResultsReview: React.FC<ScanResultsReviewProps> = ({
  reportId,
  onComplete,
}) => {
  const [loading, setLoading] = useState(true);
  const [aboutText, setAboutText] = useState('');
  const [workingOnText, setWorkingOnText] = useState('');
  const [existingReportData, setExistingReportData] = useState<Record<string, unknown>>({});
  const [editingSection, setEditingSection] = useState<'about' | 'working_on' | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    window.reportsAPI.get(reportId).then((report) => {
      if (report) {
        setAboutText(report.about_you_summary ?? '');
        setWorkingOnText(report.what_youre_working_on_summary ?? '');
        try {
          setExistingReportData(JSON.parse(report.report_data));
        } catch {
          // ignore
        }
      }
      setLoading(false);
    });
  }, [reportId]);

  const handleEdit = (section: 'about' | 'working_on') => {
    setEditingSection(section);
    setEditBuffer(section === 'about' ? aboutText : workingOnText);
  };

  const handleSave = () => {
    if (editingSection === 'about') {
      setAboutText(editBuffer);
    } else if (editingSection === 'working_on') {
      setWorkingOnText(editBuffer);
    }
    setEditingSection(null);
  };

  const handleCancel = () => {
    setEditingSection(null);
    setEditBuffer('');
  };

  const handleContinue = async () => {
    setIsSaving(true);
    try {
      await window.reportsAPI.update(reportId, JSON.stringify({
        ...existingReportData,
        about_you_summary: aboutText,
        what_youre_working_on_summary: workingOnText,
      }));
    } catch {
      // Non-critical — continue even if save fails
    }
    onComplete();
  };

  if (loading) return null;

  return (
    <div className="wsSetup">
      <div className="wsSetup__branding">
        <span className="wsSetup__brandName">Co-scientist</span>
        <span className="wsSetup__brandLabel">SETUP</span>
      </div>

      <div className="wsSetup__body wsSetup__body--tight">
        <div className="wsSetup__inner wsSetup__reviewInner">
          <p className="wsSetup__stepIndicator">STEP 3 OF 3 &middot; HERE&rsquo;S WHAT I LEARNED</p>
        <h1 className="wsSetup__title">
          Does this match how you&rsquo;d describe your work?
        </h1>
        <p className="wsSetup__subtitle">
          Click Edit on either section if anything&rsquo;s wrong or missing &mdash; this shapes
          everything I do for you.
        </p>

        {/* About You section */}
        <div className="wsReview__section">
          <div className="wsReview__sectionHeader">
            <span className="wsReview__sectionLabel">ABOUT YOU</span>
            {editingSection !== 'about' && (
              <button
                type="button"
                className="wsReview__editBtn"
                onClick={() => handleEdit('about')}
              >
                <PencilIcon size={12} /> Edit
              </button>
            )}
          </div>
          {editingSection === 'about' ? (
            <>
              <textarea
                className="wsReview__textarea"
                value={editBuffer}
                onChange={(e) => setEditBuffer(e.target.value)}
                autoFocus
              />
              <div className="wsReview__editActions">
                <button type="button" className="wsReview__cancelBtn" onClick={handleCancel}>
                  Cancel
                </button>
                <button type="button" className="wsReview__saveBtn" onClick={handleSave}>
                  Save
                </button>
              </div>
            </>
          ) : (
            <p className="wsReview__text">
              {aboutText || 'No summary available.'}
            </p>
          )}
        </div>

        {/* What You're Working On section */}
        <div className="wsReview__section">
          <div className="wsReview__sectionHeader">
            <span className="wsReview__sectionLabel">WHAT YOU&rsquo;RE WORKING ON</span>
            {editingSection !== 'working_on' && (
              <button
                type="button"
                className="wsReview__editBtn"
                onClick={() => handleEdit('working_on')}
              >
                <PencilIcon size={12} /> Edit
              </button>
            )}
          </div>
          {editingSection === 'working_on' ? (
            <>
              <textarea
                className="wsReview__textarea wsReview__textarea--tall"
                value={editBuffer}
                onChange={(e) => setEditBuffer(e.target.value)}
                autoFocus
              />
              <div className="wsReview__editActions">
                <button type="button" className="wsReview__cancelBtn" onClick={handleCancel}>
                  Cancel
                </button>
                <button type="button" className="wsReview__saveBtn" onClick={handleSave}>
                  Save
                </button>
              </div>
            </>
          ) : (
            <p className="wsReview__text">
              {workingOnText || 'No recent activity summary available.'}
            </p>
          )}
        </div>

          <button
            type="button"
            className="wsSetup__continueBtn"
            disabled={isSaving}
            onClick={handleContinue}
          >
            {isSaving ? 'Saving...' : (
              <>This looks right &mdash; continue <ArrowRightIcon className="wsSetup__arrow" /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScanResultsReview;
