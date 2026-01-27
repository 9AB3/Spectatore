import Header from '../components/Header';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getDB } from '../lib/idb';
import useToast from '../hooks/useToast';
import { track } from '../lib/analytics';

export default function Register() {
  const nav = useNavigate();

  useEffect(() => {
    track.signupStart('register_page');
  }, []);

  
  const { setMsg, Toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');
  const [workSiteOptions, setWorkSiteOptions] = useState<string[]>(['CSA', 'Endeavor', 'Peak']);
  const [workSiteSelect, setWorkSiteSelect] = useState<string>('CSA');
  const [workSiteManual, setWorkSiteManual] = useState('');
  const [state, setState] = useState('NSW');

  useEffect(() => {
    (async () => {
      try {
        const r: any = await api('/api/work-sites');
        const names = Array.isArray(r?.sites) ? r.sites.map((s: any) => String(s?.name || '').trim()).filter(Boolean) : [];
        if (names.length) {
          setWorkSiteOptions(names);
          if (!names.includes(workSiteSelect)) setWorkSiteSelect(names[0]);
        }
      } catch {
        // ignore
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!name || !email || !password || !confirm) {
      setMsg('Please complete all required fields');
      return;
    }
    if (password !== confirm) {
      setMsg('Passwords do not match');
      return;
    }

    const work_site_name = workSiteSelect === 'Not in List' ? workSiteManual.trim() : workSiteSelect;
    if (!work_site_name) {
      setMsg('Please select a Work Site (or type your Work Site name)');
      return;
    }
    try {
      const res: any = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name, work_site_name, state }),
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
        track.signupComplete('email');
        nav('/shift');
   } else {
  localStorage.setItem('spectatore-register-email', email);
  setMsg('Registered. Check your email for the confirmation code.');
  // Funnel semantics: do NOT fire sign_up until the user successfully logs in (after email confirmation).
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
          <div className="text-xs text-slate-500">Work Site</div>
          <select
            className="input"
            value={workSiteSelect}
            onChange={(e) => {
              const v = e.target.value as any;
              setWorkSiteSelect(v);
              if (v !== 'Not in List') setWorkSiteManual('');
            }}
          >
            {workSiteOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option>Not in List</option>
          </select>

          {workSiteSelect === 'Not in List' && (
            <div>
              <input
                className="input"
                list="site-suggestions"
                placeholder="Type your Work Site name"
                value={workSiteManual}
                onChange={(e) => setWorkSiteManual(e.target.value)}
              />
              {/* Dropdown suggestions + allows free typing (saved as the site) */}
              <datalist id="site-suggestions">
                {workSiteOptions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <div className="text-xs text-slate-500 mt-1">This will be saved as your Work Site.</div>
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
