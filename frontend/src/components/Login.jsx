import { useState, useEffect } from 'react';
import feel from '../feel/feel.js';
import { LogoMark } from './Logo.jsx';
import { api, setToken } from '../api/client.js';
import { Loader2 } from './icons.jsx';
import BgLogin from '../assets/welcome/login.png';
import Logo from '../assets/welcome/header-logo.svg';

export default function Login({ onLogin }) {

  const [username, setUsername] = useState('');

  const [password, setPassword] = useState('');

  const [loading, setLoading] = useState(false);

  const [error, setError] = useState('');

  // 'shake' on a wrong password, 'leaving' while the card flies out on success
  const [motion, setMotion] = useState('');
  // after the entrance has played, the card stops animating on re-render
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 1100); return () => clearTimeout(t); }, []);

  async function submit(e) {

    e.preventDefault();

    setLoading(true);

    setError('');


    try {

      const data = await api.login(
        username,
        password
      );

      setToken(data.token);

      localStorage.setItem(
        'role',
        data.role
      );

      localStorage.setItem(
        'username',
        data.username
      );

      feel.signal('success');

      setMotion('leaving');

      await new Promise(r => setTimeout(r, feel.reduceMotion() ? 0 : 280));

      onLogin(data);

    } catch (err) {

      setError(
        err.message || 'Giriş alınmadı'
      );

      feel.signal('error');

      // two class names so a second wrong try shakes again
      setReady(true);
      setMotion(m => (m === 'shake' ? 'shake-b' : 'shake'));

    } finally {

      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
<img src={BgLogin}  />
      <form
        className={`login-card ${ready ? 'ready' : ''} ${motion}`}
        onSubmit={submit}
      >

     <img src={Logo}  />

        <h1>
          ABŞERON LOGİSTİKA MƏRKƏZİ
        </h1>

        <div className="sub">
          Proses xəritələri sisteminə daxil olun
        </div>

        <div className="field">

          <label>
            İstifadəçi adı
          </label>

          <input
            type="text"
            value={username}
            onChange={e =>
              setUsername(e.target.value)
            }
          />

        </div>

        <div className="field">

          <label>
            Şifrə
          </label>

          <input
            type="password"
            value={password}
            onChange={e =>
              setPassword(e.target.value)
            }
          />

        </div>

        {error && (
          <div className="form-error">
            {error}
          </div>
        )}

        <button
          className="login-btn"
          type="submit"
          disabled={loading}
        >

          {loading && (
            <Loader2
              size={16}
              className="spin"
            />
          )}

          <span>
            {loading
              ? 'Yüklənir...'
              : 'Daxil olun'}
          </span>

        </button>

        {/* <div className="login-hint">
          admin / admin123
          <br />
          user / user123
        </div> */}

      </form>

    </div>
  );
}