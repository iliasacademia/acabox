import React, { useState, useEffect } from 'react';
import dockIcon from '../../../assets/icons/dock-icon.png';
import './WorkspaceOnboarding.css';

interface WorkspaceOnboardingProps {
  onComplete: () => void;
}

const WorkspaceOnboarding: React.FC<WorkspaceOnboardingProps> = ({ onComplete }) => {
  const [name, setName] = useState('My Workspace');
  const [directoryPath, setDirectoryPath] = useState('');
  const [directoryOverridden, setDirectoryOverridden] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [focusedStep, setFocusedStep] = useState<number | null>(1);

  const hasName = name.trim().length > 0;
  const hasApiKey = apiKey.trim().length > 0;
  const canSubmit = hasName && directoryPath && hasApiKey && !isCreating;

  // Auto-compute default directory path from workspace name (unless user overrode it)
  useEffect(() => {
    if (directoryOverridden) return;
    if (!hasName) {
      setDirectoryPath('');
      return;
    }
    window.workspacesAPI.getDefaultDirectory(name.trim()).then(setDirectoryPath);
  }, [name, hasName, directoryOverridden]);

  const handleChangeDirectory = async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (selected) {
      setDirectoryPath(selected);
      setDirectoryOverridden(true);
      setError(null);
    }
  };

  const stepState = (step: number, isDone: boolean, isEnabled: boolean) => {
    if (focusedStep === step) return 'gsStep--active';
    if (isDone) return 'gsStep--done';
    if (isEnabled) return 'gsStep--active';
    return 'gsStep--disabled';
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setError(null);
    setIsCreating(true);

    try {
      await window.workspacesAPI.create({
        name: name.trim(),
        directoryPath,
        apiKey: apiKey.trim(),
      });
      onComplete();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create workspace.';
      setError(message);
      setIsCreating(false);
    }
  };

  return (
    <div className="gettingStarted">
      <div className="gettingStarted__inner">
        <div className="gettingStarted__header">
          <img src={dockIcon} className="gettingStarted__logo" alt="Academia Coscientist" />
          <h1 className="gettingStarted__title">Welcome to Academia Coscientist</h1>
          <p className="gettingStarted__subtitle">Complete these steps to get started</p>
        </div>

        <div className="gettingStarted__steps">
          {/* Step 1: Workspace Name */}
          <div className={`gsStep ${stepState(1, hasName, true)}`}>
            <div className="gsStep__indicator">
              {hasName && focusedStep !== 1 ? (
                <span className="gsStep__check">✓</span>
              ) : (
                <span className="gsStep__num">1</span>
              )}
            </div>
            <div className="gsStep__body">
              <h3 className="gsStep__title">Name your workspace</h3>
              <p className="gsStep__desc">
                {hasName && focusedStep !== 1 ? `Workspace: ${name}` : 'Give your workspace a name.'}
              </p>
              <input
                type="text"
                className="gsStep__input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onFocus={() => setFocusedStep(1)}
                onBlur={() => setFocusedStep(null)}
                placeholder="My Workspace"
              />
              {hasName && directoryPath && (
                <div className="gsStep__dirInfo">
                  <p className="gsStep__hint">
                    Workspace directory: {directoryPath}
                  </p>
                  <button
                    type="button"
                    className="gsStep__btn gsStep__btn--ghost"
                    onClick={handleChangeDirectory}
                  >
                    Change
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="gettingStarted__connector" />

          {/* Step 2: API Key */}
          <div className={`gsStep ${stepState(2, hasApiKey, hasName)}`}>
            <div className="gsStep__indicator">
              {hasApiKey && focusedStep !== 2 ? (
                <span className="gsStep__check">✓</span>
              ) : (
                <span className="gsStep__num">2</span>
              )}
            </div>
            <div className="gsStep__body">
              <h3 className="gsStep__title">Enter your Anthropic API key</h3>
              <p className="gsStep__desc">
                {hasApiKey && focusedStep !== 2
                  ? 'API key provided.'
                  : 'Your API key is stored locally and used to communicate with Claude.'}
              </p>
              <input
                type="password"
                className="gsStep__input"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onFocus={() => setFocusedStep(2)}
                onBlur={() => setFocusedStep(null)}
                placeholder="sk-ant-..."
                disabled={!hasName}
              />
            </div>
          </div>

          <div className="gettingStarted__connector" />

          {/* Step 3: Create */}
          <div className={`gsStep gsStep--cta ${canSubmit ? 'gsStep--active' : 'gsStep--disabled'}`}>
            <div className="gsStep__indicator">
              <span className="gsStep__num">3</span>
            </div>
            <div className="gsStep__body">
              <h3 className="gsStep__title">Create your workspace</h3>
              {isCreating ? (
                <p className="gsStep__desc">Setting up your workspace...</p>
              ) : (
                <>
                  <p className="gsStep__desc">
                    The agent will have full read/write access to the workspace directory.
                  </p>
                  {error && <p className="gsStep__error">{error}</p>}
                  <button
                    type="button"
                    className="gsStep__btn gsStep__btn--primary gsStep__btn--large"
                    disabled={!canSubmit}
                    onClick={handleSubmit}
                  >
                    {error ? 'Try Again' : 'Create Workspace'}
                  </button>
                  {!canSubmit && !isCreating && (
                    <p className="gsStep__hint">Complete steps 1 and 2 to continue.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceOnboarding;
