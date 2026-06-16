import { useSessionStore } from '../store/sessionStore.js';

// Live-tunable detection params: [key, label, min, max, step].
const SLIDERS = [
  ['thresholdMultiplier', 'Threshold ×base', 1.5, 8, 0.1],
  ['minSnr', 'Min SNR', 1, 6, 0.1],
  ['minDuration', 'Min dur (ms)', 50, 500, 10],
  ['maxDuration', 'Max dur (ms)', 400, 1500, 10],
  ['minInterval', 'Min gap (ms)', 500, 4000, 100],
  ['emaAlpha', 'Smoothing α', 0.2, 1, 0.05],
];

function ParamSlider({ keyName, label, min, max, step, value, onChange }) {
  return (
    <label className="block">
      <div className="flex justify-between text-[10px] text-slate-400">
        <span>{label}</span>
        <span className="tabular-nums text-slate-200">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(keyName, parseFloat(e.target.value))}
        className="h-1 w-full accent-sky-400"
      />
    </label>
  );
}

/** A live RMS meter with the calibrated baseline + threshold marked, so you can
 *  see how each swallow's energy compares to the firing threshold. */
function LevelMeter({ level, peak, baseline, threshold }) {
  // Scale to a bit above whichever is largest so bars stay on-screen.
  const ceiling = Math.max(peak, threshold ?? 0, level) * 1.15 || 1e-3;
  const pct = (v) => `${Math.min((v / ceiling) * 100, 100)}%`;

  return (
    <div>
      <div className="relative h-6 w-full overflow-hidden rounded bg-slate-800">
        {/* current level */}
        <div
          className="absolute inset-y-0 left-0 bg-sky-400/70 transition-[width] duration-75"
          style={{ width: pct(level) }}
        />
        {/* threshold marker */}
        {threshold != null && (
          <div
            className="absolute inset-y-0 w-0.5 bg-pace-over"
            style={{ left: pct(threshold) }}
            title="threshold"
          />
        )}
        {/* baseline marker */}
        {baseline != null && (
          <div
            className="absolute inset-y-0 w-0.5 bg-pace-good"
            style={{ left: pct(baseline) }}
            title="baseline"
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span className="text-sky-400">level {level.toExponential(1)}</span>
        <span className="text-pace-good">base {baseline?.toExponential(1) ?? '—'}</span>
        <span className="text-pace-over">thr {threshold?.toExponential(1) ?? '—'}</span>
      </div>
    </div>
  );
}

export default function DebugOverlay() {
  const {
    level,
    peakLevel,
    calibration,
    debugEvents,
    swallowCount,
    rate,
    baselineRate,
    effectiveTarget,
    detectionParams,
    setDetectionParam,
    recalibrate,
    toggleDebug,
    isRecording,
    recording,
    replayResult,
    startRecording,
    stopRecording,
    downloadRecording,
    replayRecording,
  } = useSessionStore();

  const recSeconds = recording
    ? Math.round(recording.samples.length / recording.sampleRate)
    : 0;

  return (
    <div className="fixed bottom-24 left-3 right-3 z-10 mx-auto max-w-md rounded-xl border border-slate-700 bg-slate-900/95 p-3 text-xs font-mono shadow-xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-slate-300">Debug · tuning</span>
        <div className="flex gap-2">
          <button
            onClick={recalibrate}
            className="rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 active:bg-slate-600"
          >
            Recalibrate
          </button>
          <button
            onClick={toggleDebug}
            className="rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 active:bg-slate-600"
          >
            Hide
          </button>
        </div>
      </div>

      <LevelMeter
        level={level}
        peak={peakLevel}
        baseline={calibration?.baseline}
        threshold={calibration?.threshold}
      />

      <div className="mt-2 flex justify-between text-slate-400">
        <span>count {swallowCount}</span>
        <span>rate {rate.toFixed(1)}/min</span>
        <span>
          base {baselineRate == null ? '—' : baselineRate.toFixed(1)} → tgt{' '}
          {effectiveTarget().toFixed(1)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
        {SLIDERS.map(([key, label, min, max, step]) => (
          <ParamSlider
            key={key}
            keyName={key}
            label={label}
            min={min}
            max={max}
            step={step}
            value={detectionParams[key]}
            onChange={setDetectionParam}
          />
        ))}
      </div>

      {/* Record / replay tuning loop */}
      <div className="mt-3 border-t border-slate-800 pt-2">
        <div className="flex items-center gap-2">
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`rounded px-2 py-1 text-[11px] ${
              isRecording ? 'bg-pace-over text-slate-900' : 'bg-slate-700 text-slate-200'
            }`}
          >
            {isRecording ? '■ Stop rec' : '● Record'}
          </button>
          <button
            onClick={replayRecording}
            disabled={!recording || isRecording}
            className="rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-40"
          >
            Replay
          </button>
          <button
            onClick={downloadRecording}
            disabled={!recording || isRecording}
            className="rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-40"
          >
            ⤓ WAV
          </button>
          <span className="ml-auto text-[10px] text-slate-500">
            {isRecording ? 'recording…' : recording ? `${recSeconds}s clip` : 'no clip'}
          </span>
        </div>
        {replayResult && (
          <p className="mt-1 text-[11px] text-sky-300">
            replay → {replayResult.swallows} swallows, {replayResult.rejected} rejected
            <span className="text-slate-500"> (current params)</span>
          </p>
        )}
      </div>

      <div className="mt-2 max-h-32 overflow-y-auto">
        {debugEvents.length === 0 ? (
          <p className="text-slate-600">No candidates yet…</p>
        ) : (
          debugEvents.map((e, i) => (
            <div
              key={i}
              className={`flex justify-between border-b border-slate-800/60 py-0.5 ${
                e.kind === 'swallow' ? 'text-pace-good' : 'text-slate-500'
              }`}
            >
              <span>{e.kind === 'swallow' ? '✓ swallow' : `✗ ${e.reason}`}</span>
              <span>{Math.round(e.duration)}ms</span>
              <span>{e.kind === 'swallow' ? `SNR ${e.snr.toFixed(1)}` : ''}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
