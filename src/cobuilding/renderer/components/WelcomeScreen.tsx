import React from 'react';
import './WelcomeScreen.css';

interface WelcomeScreenProps {
  onGetStarted: () => void;
  onSkipSetup?: () => void;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onGetStarted, onSkipSetup }) => {
  return (
    <div className="welcomeScreen">
      <div className="welcomeScreen__branding">
        <span className="welcomeScreen__brandName">Co-scientist</span>
        <span className="welcomeScreen__brandLabel">SETUP</span>
      </div>
      <div className="welcomeScreen__content">
        <span className="welcomeScreen__eyebrow">WELCOME</span>
        <h1 className="welcomeScreen__heading">
          A research workspace that helps you do the work
        </h1>
        <p className="welcomeScreen__subtitle">
          Co-scientist reads your files, learns your projects, and does the
          research work alongside you — drafting, analyzing, finding what
          matters.
        </p>
        <button className="welcomeScreen__cta" onClick={onGetStarted}>
          Get started <span className="welcomeScreen__arrow">&rarr;</span>
        </button>
        {onSkipSetup && (
          <button className="welcomeScreen__skipBtn" onClick={onSkipSetup}>
            Skip Setup
          </button>
        )}
      </div>
    </div>
  );
};

export default WelcomeScreen;
