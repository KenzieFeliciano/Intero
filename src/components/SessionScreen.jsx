import { useSessionStore } from '../store/sessionStore.js';
import { EngineState } from '../audio/AudioEngine.js';

const ZONE_STYLES = {
  good: { ring: 'text-pace-good', label: 'On pace', glow: 'shadow-pace-good/40' },
  warn: { ring: 'text-pace-warn', label: 'Easing up', glow: 'shadow-pace-warn/40' },
  over: { ring: 'text-pace-over', label: 'Slow down', glow: 'shadow-pace-over/40' },
};

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function RateDial({ rate, zone }) {
  const style = ZONE_STYLES[zone];
  // 0–20/min mapped onto a 270° arc.
  const pct = Math.min(rate / 20, 1);
  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const arcFraction = 0.75; // 270°
  const dash = circumference * arcFraction;
  const offset = dash * (1 - pct);

  return (
    <div className="relative flex items-center justify-center">
      <svg width="240" height="240" viewBox="0 0 240 240" className="-rotate-[135deg]">
        <circle
          cx="120"
          cy="120"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          className="text-slate-700/50"
          strokeDasharray={`${dash} ${circumference}`}
        />
        <circle
          cx="120"
          cy="120"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          className={`${style.ring} transition-all duration-300`}
          strokeDasharray={`${dash} ${circumference}`}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className={`text-6xl font-bold tabular-nums ${style.ring}`}>
          {rate.toFixed(1)}
        </span>
        <span className="text-sm text-slate-400 mt-1">swallows / min</span>
        <span className={`mt-2 text-sm font-semibold ${style.ring}`}>{style.label}</span>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-2xl font-semibold tabular-nums text-slate-100">{value}</span>
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

/** Heart-rate connect button / live BPM chip. Only mounts where Web Bluetooth
 *  exists (i.e. not on iOS). */
function HeartRateChip({ connected, bpm, deviceName, error, onConnect, onDisconnect }) {
  if (!connected) {
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          onClick={onConnect}
          className="flex items-center gap-2 rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-300 active:bg-slate-800"
        >
          <span className="text-pace-over">♥</span> Connect heart rate
        </button>
        {error && <span className="text-xs text-pace-over">{error}</span>}
      </div>
    );
  }
  return (
    <button
      onClick={onDisconnect}
      className="flex items-center gap-2 rounded-full bg-slate-800 px-4 py-2 text-sm"
      title={`${deviceName || 'Sensor'} — tap to disconnect`}
    >
      <span className="text-pace-over animate-pulse text-lg leading-none">♥</span>
      <span className="font-semibold tabular-nums text-slate-100">{bpm ?? '—'}</span>
      <span className="text-slate-500">bpm</span>
    </button>
  );
}

export default function SessionScreen() {
  const {
    engineState,
    error,
    rate,
    swallowCount,
    elapsedMs,
    calibration,
    baselineRate,
    startSession,
    stopSession,
    paceZone,
    effectiveTarget,
    toggleDebug,
    hrSupported,
    hrConnected,
    heartRate,
    hrDeviceName,
    hrError,
    connectHeartRate,
    disconnectHeartRate,
  } = useSessionStore();

  const target = effectiveTarget();

  const isActive =
    engineState === EngineState.RUNNING ||
    engineState === EngineState.CALIBRATING ||
    engineState === EngineState.REQUESTING;
  const isCalibrating = engineState === EngineState.CALIBRATING;
  const zone = paceZone();

  return (
    <div className="flex min-h-full flex-col items-center justify-between px-6 py-10 max-w-md mx-auto">
      <header className="text-center relative w-full">
        <button
          onClick={toggleDebug}
          aria-label="Toggle debug overlay"
          className="absolute right-0 top-0 rounded-lg bg-slate-800/60 px-2 py-1 text-xs text-slate-500 active:text-slate-300"
        >
          debug
        </button>
        <h1 className="text-2xl font-bold tracking-tight">Intero</h1>
        <p className="text-sm text-slate-400 mt-1">
          {isCalibrating
            ? 'Listening to the room…'
            : engineState === EngineState.RUNNING
              ? 'Eat slowly. Feel each bite.'
              : 'Retrain your fullness signal'}
        </p>
      </header>

      <main className="flex flex-col items-center gap-8 w-full">
        <RateDial rate={rate} zone={zone} />

        <div className="grid grid-cols-3 gap-6 w-full">
          <Stat label="Swallows" value={swallowCount} />
          <Stat label="Time" value={formatElapsed(elapsedMs)} />
          <Stat
            label={baselineRate == null ? 'Cap' : 'Your pace'}
            value={baselineRate == null ? `≤${Math.round(target)}` : `≤${target.toFixed(1)}`}
          />
        </div>

        {hrSupported && (
          <HeartRateChip
            connected={hrConnected}
            bpm={heartRate}
            deviceName={hrDeviceName}
            error={hrError}
            onConnect={connectHeartRate}
            onDisconnect={disconnectHeartRate}
          />
        )}

        {isCalibrating && (
          <p className="text-sm text-pace-warn animate-pulse">
            Calibrating ambient noise — hold still for 3 seconds.
          </p>
        )}
        {calibration && engineState === EngineState.RUNNING && (
          <p className="text-xs text-slate-600">
            baseline {calibration.baseline.toExponential(1)} · threshold{' '}
            {calibration.threshold.toExponential(1)}
          </p>
        )}

        {error && (
          <div className="rounded-xl bg-pace-over/10 border border-pace-over/30 px-4 py-3 text-center">
            <p className="text-sm text-pace-over font-medium">{error.message}</p>
          </div>
        )}
      </main>

      <footer className="w-full">
        {!isActive ? (
          <button
            onClick={startSession}
            className="w-full rounded-2xl bg-pace-good py-5 text-lg font-semibold text-slate-900 active:scale-[0.98] transition-transform shadow-lg shadow-pace-good/30"
          >
            Start meal
          </button>
        ) : (
          <button
            onClick={stopSession}
            className="w-full rounded-2xl bg-slate-700 py-5 text-lg font-semibold text-slate-100 active:scale-[0.98] transition-transform"
          >
            {engineState === EngineState.REQUESTING ? 'Allow microphone…' : 'End meal'}
          </button>
        )}
      </footer>
    </div>
  );
}
