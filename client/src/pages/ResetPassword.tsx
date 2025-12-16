import Header from '../components/Header';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
export default function ResetPassword() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  async function submit() {
    if (!code) {
      setMsg('Enter the code');
      return;
    }
    if (password.length < 8) {
      setMsg('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setMsg('Passwords do not match');
      return;
    }
    const email = localStorage.getItem('spectatore-reset-email');
    try {
      await api('/api/auth/reset', {
        method: 'POST',
        body: JSON.stringify({ email, code, password }),
      });
      setMsg('Password reset');
      // Keep toast visible for at least 2s before route change
      setTimeout(() => nav('/Home'), 2000);
    } catch (e: any) {
      try {
        const msg = JSON.parse(e.message).error;
        // Typical backend errors: invalid code, expired code, user not found
        setMsg(msg || 'Invalid code');
      } catch {
        setMsg('Invalid code');
      }
    }
  }
  return (
    <div>
      <Toast />
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
