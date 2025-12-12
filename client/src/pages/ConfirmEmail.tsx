import Header from '../components/Header';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import useToast from '../hooks/useToast';
export default function ConfirmEmail() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [code, setCode] = useState('');
  async function submit() {
    const email = localStorage.getItem('spectatore-register-email');
    await api('/api/auth/confirm', { method: 'POST', body: JSON.stringify({ email, code }) });
    setMsg('Confirmed');
    setTimeout(() => nav('/Home'), 500);
  }
  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 card max-w-md mx-auto space-y-3">
        <input
          className="input"
          placeholder="Email Confirmation Code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button className="btn btn-primary" onClick={submit}>
          SUBMIT
        </button>
        <button className="btn btn-secondary" onClick={() => nav('/Register')}>
          BACK
        </button>
      </div>
    </div>
  );
}
