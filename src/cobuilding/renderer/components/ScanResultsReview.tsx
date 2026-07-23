import React, { useState, useEffect } from 'react';
import { ArrowRightIcon } from 'lucide-react';
import { MEMORY_PATH_ABOUT_YOU, MEMORY_PATH_WORKING_ON } from '../../shared/paths';
import './WorkspaceOnboarding.css';
import './ScanResultsReview.css';

interface ScanResultsReviewProps {
  onComplete: () => void;
}

const ScanResultsReview: React.FC<ScanResultsReviewProps> = ({
  onComplete,
}) => {
  const [loading, setLoading] = useState(true);
  const [aboutText, setAboutText] = useState('');
  const [workingOnText, setWorkingOnText] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      window.academiaFileAPI.read(MEMORY_PATH_ABOUT_YOU),
      window.academiaFileAPI.read(MEMORY_PATH_WORKING_ON),
    ]).then(([about, workingOn]) => {
      setAboutText(about.content);
      setWorkingOnText(workingOn.content);
      setLoading(false);
    });
  }, []);

  const handleContinue = async () => {
    setIsSaving(true);
    try {
      await Promise.all([
        window.academiaFileAPI.write(MEMORY_PATH_ABOUT_YOU, aboutText),
        window.academiaFileAPI.write(MEMORY_PATH_WORKING_ON, workingOnText),
      ]);
    } catch {
      // Non-critical — continue even if save fails
    }
    onComplete();
  };

  if (loading) return null;

  return (
    <div className="wsSetup">
      <div className="wsSetup__branding">
        <span className="wsSetup__brandName">Acabox</span>
        <span className="wsSetup__brandLabel">SETUP</span>
      </div>

      <div className="wsSetup__body wsSetup__body--tight">
        <div className="wsSetup__inner wsSetup__reviewInner">
          <p className="wsSetup__stepIndicator">STEP 3 OF 3 &middot; HERE&rsquo;S WHAT I LEARNED</p>
        <h1 className="wsSetup__title">
          Does this match how you&rsquo;d describe your work?
        </h1>
        <p className="wsSetup__subtitle">
          Edit either section if anything&rsquo;s wrong or missing &mdash; this shapes
          everything I do for you.
        </p>

        {/* About You section */}
        <div className="wsReview__section">
          <div className="wsReview__sectionHeader">
            <span className="wsReview__sectionLabel">ABOUT YOU</span>
          </div>
          <textarea
            className="wsReview__textarea"
            value={aboutText}
            onChange={(e) => setAboutText(e.target.value)}
          />
        </div>

        {/* What You're Working On section */}
        <div className="wsReview__section">
          <div className="wsReview__sectionHeader">
            <span className="wsReview__sectionLabel">WHAT YOU&rsquo;RE WORKING ON</span>
          </div>
          <textarea
            className="wsReview__textarea wsReview__textarea--tall"
            value={workingOnText}
            onChange={(e) => setWorkingOnText(e.target.value)}
          />
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
