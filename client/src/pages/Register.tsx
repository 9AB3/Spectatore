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
  const [siteSelect, setSiteSelect] = useState<'CSA' | 'Endeavor' | 'Peak' | 'Not in List'>('CSA');
  const [siteManual, setSiteManual] = useState('');
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

    const site = siteSelect === 'Not in List' ? siteManual.trim() : siteSelect;
    if (!site) {
      setMsg('Please select a site (or type your site name)');
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
  localStorage.setItem('spectatore-register-email', email);
  setMsg('Registered. Check your email for the confirmation code.');
  nav('/ConfirmEmail');
}



    } catch (e: any) {
      setMsg(e?.message || 'Failed to register');
    }
  }

  return (
    <div>
      <Toast />
      <Header showSync={false} />
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
        <div className="space-y-2">
          <select
            className="input"
            value={siteSelect}
            onChange={(e) => {
              const v = e.target.value as any;
              setSiteSelect(v);
              if (v !== 'Not in List') setSiteManual('');
            }}
          >
            <option>CSA</option>
            <option>Endeavor</option>
            <option>Peak</option>
            <option>Not in List</option>
          </select>

          {siteSelect === 'Not in List' && (
            <div>
              <input
                className="input"
                list="site-suggestions"
                placeholder="Type your site name"
                value={siteManual}
                onChange={(e) => setSiteManual(e.target.value)}
              />
              {/* Dropdown suggestions + allows free typing (saved as the site) */}
              <datalist id="site-suggestions">
                <option value="CSA" />
                <option value="Endeavor" />
                <option value="Peak" />
              </datalist>
              <div className="text-xs text-slate-500 mt-1">This will be saved as your site.</div>
            </div>
          )}
        </div>
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option>NSW</option>
          <option>QLD</option>
          <option>NT</option>
          <option>SA</option>
          <option>VIC</option>
          <option>WA</option>
          <option>TAS</option>
        </select>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <button className="btn btn-primary w-full" onClick={submit}>
            SUBMIT
          </button>
          <button className="btn btn-secondary w-full" onClick={() => nav('/Home')}>
            BACK
          </button>
        </div>
      </div>
    </div>
  );
}
