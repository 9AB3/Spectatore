import Header from '../components/Header';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
export default function ForgotPassword() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [email, setEmail] = useState('');
  async function submit() {
    if (!email) {
      setMsg('Enter your email');
      return;
    }
    try {
      await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
      localStorage.setItem('spectatore-reset-email', email);
      setMsg('Code sent');
      // Keep toast visible for at least 2s before route change
      setTimeout(() => nav('/ResetPassword'), 2000);
    } catch (e: any) {
      try {
        const msg = JSON.parse(e.message).error;
        setMsg(msg || 'Failed to send reset code');
      } catch {
        setMsg('Failed to send reset code');
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
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button className="btn btn-primary" onClick={submit}>
          SUBMIT
        </button>
        <button className="btn btn-secondary" onClick={() => nav('/Main')}>
          BACK
        </button>
      </div>
    </div>
  );
}
