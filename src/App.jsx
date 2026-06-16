import SessionScreen from './components/SessionScreen.jsx';
import CheckIn from './components/CheckIn.jsx';
import { useSessionStore } from './store/sessionStore.js';

export default function App() {
  const showCheckIn = useSessionStore((s) => s.showCheckIn);

  return (
    <div className="min-h-full">
      <SessionScreen />
      {showCheckIn && <CheckIn />}
    </div>
  );
}
