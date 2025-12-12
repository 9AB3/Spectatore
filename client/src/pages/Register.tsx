import Header from '../components/Header';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';

export default function Register() {
  const nav = useNavigate();
  const { setMsg, Toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [site, setSite] = useState('CSA');
  const [state, setState] = useState('NSW');

  async function submit() {
    if (!name || !email || !password || !confirm) {
      setMsg('Please complete all required fields');
      return;
    }
    if (password !== confirm) {
      setMsg('Passwords do not match');
      return;
    }
    try {
      const res: any = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, site, state }),
      });
      // In dev, server may return { ok, token, user }
      if (res?.token) {
        const db = await getDB();
        await db.put(
          'session',
          { token: res.token, email: res.user?.email, name: res.user?.name },
          'auth',
        );
        setMsg('Registered and signed in');
        nav('/shift');
      } else {
        setMsg('Registered. Check your email for the confirmation code, then sign in.');
        nav('/Home');
      }
    } catch (e: any) {
      setMsg(e?.message || 'Failed to register');
    }
  }

  return (
    <div>
      <Toast />
      <Header />
      <div className="p-6 card max-w-md mx-auto space-y-3">
        <input
          className="input"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="input"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
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
        <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
          <option>CSA</option>
          <option>Endeavor</option>
          <option>Peak</option>
          <option>Not in List</option>
        </select>
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option>NSW</option>
          <option>QLD</option>
          <option>NT</option>
          <option>SA</option>
          <option>VIC</option>
          <option>WA</option>
          <option>TAS</option>
        </select>
        <button className="btn btn-primary" onClick={submit}>
          SUBMIT
        </button>
        <button className="btn btn-secondary" onClick={() => nav('/Home')}>
          BACK
        </button>
      </div>
    </div>
  );
}
