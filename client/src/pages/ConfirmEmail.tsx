import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';

export default function ConfirmEmail() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    const e = localStorage.getItem('spectatore-register-email') || '';
    setEmail(e);
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function submit() {
    if (!email || !code) return setMsg('Enter your email and code');
    localStorage.setItem('spectatore-register-email', email);
    await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ email, code }) });
    setMsg('Confirmed');
    setTimeout(() => nav('/Home'), 500);
  }

  async function resend() {
    if (!email) return setMsg('Enter your email first');
    localStorage.setItem('spectatore-register-email', email);
    await api('/api/auth/resend-confirm', { method: 'POST', body: JSON.stringify({ email }) });
    setMsg('Code resent (check your inbox)');
    setCooldown(60);
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
        <input
          className="input"
          placeholder="Email Confirmation Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />

        <div className="grid grid-cols-2 gap-3">
          <button className="btn btn-primary" onClick={submit}>
            SUBMIT
          </button>
          <button className="btn btn-secondary" onClick={() => nav('/Register')}>
            BACK
          </button>
        </div>

        <button className="btn btn-secondary w-full" disabled={cooldown > 0} onClick={resend}>
          {cooldown > 0 ? `RESEND (${cooldown}s)` : 'RESEND CODE'}
        </button>
      </div>
    </div>
  );
}
