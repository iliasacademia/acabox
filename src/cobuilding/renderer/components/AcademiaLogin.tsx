import React, { useState, useEffect, useRef } from 'react';
import './AcademiaLogin.css';

interface AcademiaLoginProps {
  onSuccess: () => void;
  onBack?: () => void;
}

type QRAuthStatus = 'initializing' | 'waiting' | 'verifying' | 'authorized' | 'error';

const AcademiaLogin: React.FC<AcademiaLoginProps> = ({ onSuccess, onBack }) => {
  const [qrCodeDataURL, setQrCodeDataURL] = useState<string>('');
  const [authorizationURL, setAuthorizationURL] = useState<string>('');
  const [deviceId, setDeviceId] = useState<string>('');
  const [userInputCode, setUserInputCode] = useState<string>('');
  const [attemptCount, setAttemptCount] = useState<number>(0);
  const [status, setStatus] = useState<QRAuthStatus>('initializing');
  const [error, setError] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const isVerifyingRef = useRef(false);
  const [endpoint, setEndpoint] = useState<string>('production');

  useEffect(() => {
    (async () => {
      await window.authAPI.setEndpoint('production');
      startQRAuth();
    })();
  }, []);

  const handleEndpointChange = async (newEndpoint: string) => {
    setEndpoint(newEndpoint);
    await window.authAPI.setEndpoint(newEndpoint);
    handleRetry();
  };

  // Auto-verify when the app receives a cobuilding-agent:// deep link.
  useEffect(() => {
    const cleanup = window.authAPI.onDeepLinkCallback(async ({ verificationCode, deviceId: linkDeviceId }) => {
      if (!verificationCode || !/^\d{6}$/.test(verificationCode)) return;
      if (!linkDeviceId) return;
      if (isVerifyingRef.current) return;
      isVerifyingRef.current = true;
      setUserInputCode(verificationCode);
      setStatus('verifying');
      setError('');
      try {
        const result = await window.authAPI.verifyQRCode(linkDeviceId, verificationCode);
        if (result.success && result.authorized) {
          setStatus('authorized');
          setTimeout(() => onSuccess(), 500);
        } else {
          setAttemptCount((prev) => prev + 1);
          setStatus('waiting');
          setError(result.error || 'Verification failed');
        }
      } finally {
        isVerifyingRef.current = false;
      }
    });
    return cleanup;
  }, [onSuccess]);

  const startQRAuth = async () => {
    setStatus('initializing');
    setError('');
    setAttemptCount(0);
    setUserInputCode('');

    const result = await window.authAPI.startQRAuth();
    if (!result.success || !result.qrCodeDataURL) {
      setStatus('error');
      setError(result.error || 'Failed to create QR code');
      return;
    }

    setQrCodeDataURL(result.qrCodeDataURL);
    setAuthorizationURL(result.authorizationURL || '');
    setDeviceId(result.deviceId || '');
    setStatus('waiting');
  };

  const handleVerifyCode = async () => {
    if (!userInputCode || userInputCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    if (attemptCount >= 5) {
      setError('Too many failed attempts. Please start over.');
      return;
    }

    setStatus('verifying');
    setError('');

    const result = await window.authAPI.verifyQRCode(deviceId, userInputCode);

    if (!result.success) {
      setAttemptCount((prev) => prev + 1);
      setStatus('waiting');
      setError(result.error || 'Verification failed');
      return;
    }

    if (result.authorized) {
      setStatus('authorized');
      setTimeout(() => onSuccess(), 500);
    } else {
      setAttemptCount((prev) => prev + 1);
      setStatus('waiting');
      setError('Invalid verification code');
    }
  };

  const handleRetry = () => {
    setQrCodeDataURL('');
    setAuthorizationURL('');
    setDeviceId('');
    setUserInputCode('');
    setAttemptCount(0);
    setError('');
    startQRAuth();
  };

  return (
    <div className="academiaLogin">
      <div className="academiaLogin__branding">
        {onBack && (
          <button className="academiaLogin__backBtn" onClick={onBack}>
            &larr;
          </button>
        )}
        <span className="academiaLogin__brandName">Co-scientist</span>
        <span className="academiaLogin__brandLabel">SETUP</span>
      </div>
      <div className="academiaLogin__inner">
        <div className="academiaLogin__header">
          <h1 className="academiaLogin__title">Connect your Academia account</h1>
          <p className="academiaLogin__subtitle">
            Sign in to link this app to your Academia.edu account
          </p>
        </div>

        <div className="academiaLogin__card">
          {status === 'initializing' && (
            <div className="academiaLogin__loading">
              <div className="academiaLogin__spinner" />
            </div>
          )}

          {status === 'authorized' && (
            <div className="academiaLogin__success">
              <div className="academiaLogin__checkmark">✓</div>
              <p className="academiaLogin__successText">Connected successfully!</p>
            </div>
          )}

          {status === 'error' && !qrCodeDataURL && (
            <div className="academiaLogin__errorState">
              <p className="academiaLogin__errorText">{error || 'Failed to initialize'}</p>
              <button className="academiaLogin__retryBtn" onClick={handleRetry}>
                Try Again
              </button>
            </div>
          )}

          {(status === 'waiting' || status === 'verifying') && qrCodeDataURL && (
            <div className="academiaLogin__qrLayout">
              <div className="academiaLogin__qrLeft">
                <div className="academiaLogin__qrImageWrap">
                  <img src={qrCodeDataURL} alt="QR Code" className="academiaLogin__qrImage" />
                </div>
                <ol className="academiaLogin__instructions">
                  <li>1. Open Academia on your phone or browser</li>
                  <li>2. Scan the QR code or open the link</li>
                  <li>3. Tap &ldquo;Authorize&rdquo; to continue</li>
                  <li>4. Enter the 6-digit code you receive</li>
                </ol>
              </div>

              <div className="academiaLogin__qrRight">
                {authorizationURL && (
                  <div className="academiaLogin__urlBox">
                    <p className="academiaLogin__urlLabel">Or open this link in your browser:</p>
                    <div className="academiaLogin__urlRow">
                      <input
                        type="text"
                        value={authorizationURL}
                        readOnly
                        className="academiaLogin__urlInput"
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        className="academiaLogin__copyBtn"
                        onClick={() => {
                          navigator.clipboard.writeText(authorizationURL);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 2000);
                        }}
                      >
                        {copied ? '✓' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                <div className="academiaLogin__codeSection">
                  <p className="academiaLogin__codeLabel">Enter the 6-digit verification code:</p>
                  <input
                    type="text"
                    maxLength={6}
                    pattern="[0-9]*"
                    inputMode="numeric"
                    value={userInputCode}
                    onChange={(e) => setUserInputCode(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && userInputCode.length === 6) {
                        handleVerifyCode();
                      }
                    }}
                    className="academiaLogin__codeInput"
                    placeholder="000000"
                    disabled={status === 'verifying' || attemptCount >= 5}
                    autoFocus
                  />
                  <button
                    className="academiaLogin__verifyBtn"
                    onClick={handleVerifyCode}
                    disabled={userInputCode.length !== 6 || status === 'verifying' || attemptCount >= 5}
                  >
                    {status === 'verifying' ? 'Verifying...' : 'Verify'}
                  </button>

                  {attemptCount > 0 && attemptCount < 5 && (
                    <p className="academiaLogin__attemptsWarn">
                      {5 - attemptCount} attempt{5 - attemptCount !== 1 ? 's' : ''} remaining
                    </p>
                  )}
                  {attemptCount >= 5 && (
                    <p className="academiaLogin__attemptsExhausted">
                      Too many attempts. Click &ldquo;Try Again&rdquo; to start over.
                    </p>
                  )}
                </div>

                {error && status !== 'verifying' && (
                  <div className="academiaLogin__status academiaLogin__status--error">{error}</div>
                )}
              </div>
            </div>
          )}

          {(status === 'error' || attemptCount >= 5) && qrCodeDataURL && (
            <div className="academiaLogin__actions">
              <button className="academiaLogin__retryBtn" onClick={handleRetry}>
                Try Again
              </button>
            </div>
          )}
        </div>

        {window.authAPI.isDev && (
          <div className="academiaLogin__endpointSelector">
            <label className="academiaLogin__endpointLabel">API Endpoint:</label>
            <select
              className="academiaLogin__endpointSelect"
              value={endpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
            >
              <option value="production">Production (academia.edu)</option>
              <option value="devdemia">Development (devdemia.com)</option>
            </select>
          </div>
        )}
      </div>
    </div>
  );
};

export default AcademiaLogin;
