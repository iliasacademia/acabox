import React, { useState } from 'react';
import { IPC_CHANNELS } from '../../shared/types';
import './LoginModal.css';
import QRLoginModal from './QRLoginModal';

interface LoginModalProps {
  onSuccess: () => void;
}

type LoginMethod = 'qr' | 'email';

const LoginModal: React.FC<LoginModalProps> = ({ onSuccess }) => {
  const [loginMethod, setLoginMethod] = useState<LoginMethod>('qr');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');
    const result = await window.electronAPI.invoke(IPC_CHANNELS.LOGIN, email, password);
    if (result.success) {
      onSuccess();
    } else {
      setError(result.data.message);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  };

  return (
    <>
      {loginMethod === 'qr' ? (
        <QRLoginModal onSuccess={onSuccess} onSwitchToEmail={() => setLoginMethod('email')} />
      ) : (
        <div className="loginModal">
          <div className="loginForm">
            <h1>Login</h1>

            <div className="loginTabs">
              <button className="loginTab" onClick={() => setLoginMethod('qr')}>
                QR Code
              </button>
              <button className="loginTab active" onClick={() => setLoginMethod('email')}>
                Email/Password
              </button>
            </div>

            <input
              type="text"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              onKeyPress={handleKeyPress}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              onKeyPress={handleKeyPress}
            />
            <button onClick={handleLogin}>Login</button>
            {error && <div className="loginError">{error}</div>}
          </div>
        </div>
      )}
    </>
  );
};

export default LoginModal;
