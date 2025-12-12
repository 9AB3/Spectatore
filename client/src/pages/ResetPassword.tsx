import Header from '../components/Header';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
export default function ResetPassword() {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  async function submit() {
    if (password.length < 8) {
      alert('Password must be 8 characters long');
      return;
    }
    if (password !== confirm) {
      alert('Passwords do not match');
      return;
    }
    const email = localStorage.getItem('spectatore-reset-email');
    await api('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    });
    nav('/Home');
  }
  return (
    <div>
      <Header />
      <div className="p-6 card max-w-md mx-auto space-y-3">
        <input
          className="input"
          placeholder="CODE"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Confirm Password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button className="btn btn-primary" onClick={submit}>
          SUBMIT
        </button>
        <button className="btn btn-secondary" onClick={() => nav('/ForgotPassword')}>
          BACK
        </button>
      </div>
    </div>
  );
}
