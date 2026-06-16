import SessionScreen from './components/SessionScreen.jsx';
import CheckIn from './components/CheckIn.jsx';
import DebugOverlay from './components/DebugOverlay.jsx';
import { useSessionStore } from './store/sessionStore.js';

export default function App() {
  const showCheckIn = useSessionStore((s) => s.showCheckIn);
  const showDebug = useSessionStore((s) => s.showDebug);

  return (
    <div className="min-h-full">
      <SessionScreen />
      {showDebug && <DebugOverlay />}
      {showCheckIn && <CheckIn />}
    </div>
  );
}
