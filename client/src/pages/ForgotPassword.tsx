import Header from '../components/Header';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
export default function ForgotPassword() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  async function submit() {
    await api('/api/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
    localStorage.setItem('spectatore-reset-email', email);
    nav('/ResetPassword');
  }
  return (
    <div>
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
