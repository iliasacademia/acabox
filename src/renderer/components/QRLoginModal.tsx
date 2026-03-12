import React, { useState, useEffect } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import './QRLoginModal.css';


interface QRLoginModalProps {
  onSuccess: () => void;
  onSwitchToEmail?: () => void;
}

type QRAuthStatus = 'initializing' | 'waiting' | 'verifying' | 'authorized' | 'timeout' | 'error';

const QRLoginModal: React.FC<QRLoginModalProps> = ({ onSuccess, onSwitchToEmail }) => {
  const [qrCodeDataURL, setQrCodeDataURL] = useState<string>('');
  const [authorizationURL, setAuthorizationURL] = useState<string>('');
  const [deviceId, setDeviceId] = useState<string>('');
  const [userInputCode, setUserInputCode] = useState<string>('');
  const [attemptCount, setAttemptCount] = useState<number>(0);
  const [status, setStatus] = useState<QRAuthStatus>('initializing');
  const [error, setError] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    startQRAuth();

    return () => {};
  }, []);

  const startQRAuth = async () => {
    try {
      setStatus('initializing');
      setError('');
      setAttemptCount(0);
      setUserInputCode('');

      // Start QR auth session
      const result = await window.electronAPI.invoke(IPC_CHANNELS.START_QR_AUTH);

      if (!result.success) {
        setStatus('error');
        const errorDetails = result.error || 'Failed to create QR code';
        console.error('[QR Auth] Start failed:', errorDetails, result);
        setError(errorDetails);
        return;
      }

      console.log('[QR Auth] Generated new QR code with device_id:', result.deviceId);
      console.log('[QR Auth] Authorization URL:', result.authorizationURL);

      setQrCodeDataURL(result.qrCodeDataURL);
      setAuthorizationURL(result.authorizationURL);
      setDeviceId(result.deviceId);
      setStatus('waiting');
    } catch (err: any) {
      console.error('[QR Auth] Failed to start:', err);
      setStatus('error');
      const errorMessage = err.message || 'Failed to initialize QR authentication';
      setError(`${errorMessage}${err.code ? ` (${err.code})` : ''}`);
    }
  };

  // Auto-verify when the app receives a writing-agent:// deep link.
  // device_id comes from the URI so there's no stale-closure risk — registered once on mount.
  useEffect(() => {
    const handleDeepLink = async (_event: any, { verificationCode, deviceId }: { verificationCode: string; deviceId: string }) => {
      if (!verificationCode || !/^\d{6}$/.test(verificationCode)) return;
      if (!deviceId) return;
      setUserInputCode(verificationCode);
      setStatus('verifying');
      setError('');
      console.log('[QR Auth] Auto-verifying from deep link, device_id:', deviceId);
      const result = await window.electronAPI.invoke(IPC_CHANNELS.VERIFY_QR_CODE, deviceId, verificationCode);
      if (result.success && result.authorized) {
        setStatus('authorized');
        setTimeout(() => onSuccess(), 500);
      } else {
        setAttemptCount(prev => prev + 1);
        setStatus('waiting');
        setError(result.error || 'Verification failed');
        console.error('[QR Auth] Deep link auto-verify failed:', result);
      }
    };

    window.electronAPI.on(IPC_CHANNELS.DEEP_LINK_CALLBACK, handleDeepLink);
    return () => {
      window.electronAPI.removeListener(IPC_CHANNELS.DEEP_LINK_CALLBACK, handleDeepLink);
    };
  }, [onSuccess]);

  const handleVerifyCode = async () => {
    // Validate input
    if (!userInputCode || userInputCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }

    // Check attempt limit
    if (attemptCount >= 5) {
      setError('Too many failed attempts. Please start over.');
      return;
    }

    try {
      setStatus('verifying');
      setError('');

      console.log('[QR Auth] Verifying code for device_id:', deviceId);

      // Call verification endpoint
      const result = await window.electronAPI.invoke(IPC_CHANNELS.VERIFY_QR_CODE, deviceId, userInputCode);

      if (!result.success) {
        setAttemptCount(prev => prev + 1);
        setStatus('waiting');
        const errorDetails = result.error || 'Verification failed';
        console.error('[QR Auth] Verification failed:', errorDetails, result);
        setError(errorDetails);
        return;
      }

      if (result.authorized) {
        setStatus('authorized');

        // Cookie is automatically set by backend via Set-Cookie header
        // Success! Notify parent
        setTimeout(() => onSuccess(), 500);
      } else {
        setAttemptCount(prev => prev + 1);
        setStatus('waiting');
        console.error('[QR Auth] Verification incomplete:', result);
        setError('Invalid verification code');
      }
    } catch (err: any) {
      setAttemptCount(prev => prev + 1);
      setStatus('waiting');
      console.error('[QR Auth] Verification exception:', err);

      const errorMsg = err.message || 'Verification failed';
      const errorCode = err.code ? ` (${err.code})` : '';
      setError(`${errorMsg}${errorCode}`);
    }
  };

  const handleCancel = () => {
    if (onSwitchToEmail) {
      onSwitchToEmail();
    }
  };

  const handleRetry = () => {
    // Clear state and start fresh
    setQrCodeDataURL('');
    setAuthorizationURL('');
    setDeviceId('');
    setUserInputCode('');
    setAttemptCount(0);
    setError('');
    startQRAuth();
  };

  const getStatusMessage = () => {
    switch (status) {
      case 'initializing':
        return 'Generating QR code...';
      case 'waiting':
        return 'Scan the QR code and enter the verification code';
      case 'verifying':
        return 'Verifying code...';
      case 'authorized':
        return 'Authorization successful!';
      case 'timeout':
        return 'Authorization timed out';
      case 'error':
        return error || 'An error occurred';
      default:
        return '';
    }
  };

  const getStatusClass = () => {
    switch (status) {
      case 'authorized':
        return 'qrStatus success';
      case 'timeout':
      case 'error':
        return 'qrStatus error';
      default:
        return 'qrStatus';
    }
  };

  return (
    <div className="loginModal">
      <div className="loginForm qrLoginForm">
        <h1>Login with QR Code</h1>

        {(status === 'waiting' || status === 'verifying') && qrCodeDataURL && (
          <>
            {authorizationURL && (
              <div className="qrFallback">
                <p className="qrFallbackTitle">Open in browser:</p>
                <div className="qrUrlContainer">
                  <input
                    type="text"
                    value={authorizationURL}
                    readOnly
                    className="qrUrlInput"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(authorizationURL);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="qrCopyButton"
                    title="Copy to clipboard"
                  >
                    {copied ? '✓ Copied!' : 'Copy'}
                  </button>
                </div>
                <a href="#" onClick={() => window.electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, authorizationURL)} className="qrLink">
                  Click to open in browser
                </a>
              </div>
            )}

            <div className="qrMainContent">
              <div className="qrLeftColumn">
                <div className="qrCodeContainer">
                  <img src={qrCodeDataURL} alt="QR Code" className="qrCode" />
                </div>

                <div className="qrInstructions">
                  <p>1. Open Academia on your phone or browser</p>
                  <p>2. Scan this QR code or visit the link above</p>
                  <p>3. Tap "Authorize" to complete authentication</p>
                  <p>4. You'll receive a 6-digit code</p>
                  <p>5. Enter that code on the right to verify</p>
                </div>
              </div>

              <div className="qrRightColumn">
                <div className="verificationCodeSection">
                  <p className="verificationPrompt">Enter the 6-digit code shown after authorization:</p>
                  <div className="codeInputContainer">
                    <input
                      type="text"
                      maxLength={6}
                      pattern="[0-9]*"
                      inputMode="numeric"
                      value={userInputCode}
                      onChange={(e) => setUserInputCode(e.target.value.replace(/\D/g, ''))}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && userInputCode.length === 6) {
                          handleVerifyCode();
                        }
                      }}
                      className="codeInput"
                      placeholder="000000"
                      disabled={status === 'verifying' || attemptCount >= 5}
                    />
                  </div>
                  <button
                    onClick={handleVerifyCode}
                    className="verifyButton"
                    disabled={userInputCode.length !== 6 || status === 'verifying' || attemptCount >= 5}
                  >
                    {status === 'verifying' ? 'Verifying...' : 'Verify'}
                  </button>
                  {attemptCount > 0 && attemptCount < 5 && (
                    <p className="attemptsRemaining">
                      {5 - attemptCount} attempt{5 - attemptCount !== 1 ? 's' : ''} remaining
                    </p>
                  )}
                  {attemptCount >= 5 && (
                    <p className="attemptsExhausted">
                      Too many failed attempts. Please click "Try Again" to start over.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {status === 'initializing' && (
          <div className="qrLoading">
            <div className="spinner"></div>
          </div>
        )}

        {status === 'authorized' && (
          <div className="qrSuccess">
            <div className="checkmark">✓</div>
          </div>
        )}

        <div className={getStatusClass()}>
          {getStatusMessage()}
        </div>

        <div className="qrActions">
          {(status === 'error' || status === 'timeout') && (
            <button onClick={handleRetry} className="retryButton">
              Try Again
            </button>
          )}

          {status === 'waiting' && onSwitchToEmail && (
            <button onClick={handleCancel} className="secondaryButton">
              Use Email/Password Instead
            </button>
          )}

          {(status === 'error' || status === 'timeout') && onSwitchToEmail && (
            <button onClick={handleCancel} className="secondaryButton">
              Use Email/Password Instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QRLoginModal;
