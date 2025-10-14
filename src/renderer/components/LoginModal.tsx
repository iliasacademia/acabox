import React, { useState } from 'react';
import './LoginModal.css';

interface LoginModalProps {
  onSuccess: () => void;
}

const LoginModal: React.FC<LoginModalProps> = ({ onSuccess }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setError('');
    const result = await window.electronAPI.invoke('login', email, password);
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
    <div className="loginModal">
      <div className="loginForm">
        <h1>Login</h1>
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
  );
};

export default LoginModal;
