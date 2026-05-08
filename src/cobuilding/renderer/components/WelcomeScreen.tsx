import React from 'react';
import { ArrowRightIcon } from 'lucide-react';
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
          Your AI research assistant
        </h1>
        <p className="welcomeScreen__subtitle">
          Knows your work. Does it with you.
        </p>
        <button className="welcomeScreen__cta" onClick={onGetStarted}>
          Get started <ArrowRightIcon className="welcomeScreen__arrow" />
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
