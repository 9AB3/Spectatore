import Header from '../components/Header';
import { useNavigate } from 'react-router-dom';
export default function Connections() {
  const nav = useNavigate();
  return (
    <div>
      <Header />
      <div className="p-6 grid gap-3 max-w-xl mx-auto">
        <button className="btn btn-primary" onClick={() => nav('/AddConnection')}>
          ADD CREW MEMBER
        </button>
        <button className="btn btn-primary" onClick={() => nav('/ViewConnections')}>
          VIEW CREW MEMBERS
        </button>
        <button className="btn btn-secondary" onClick={() => nav('/Main')}>
          BACK
        </button>
      </div>
    </div>
  );
}
