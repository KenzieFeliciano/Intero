import { useState } from 'react';
import { useSessionStore } from '../store/sessionStore.js';

const SCALE = [1, 2, 3, 4, 5];

const QUESTIONS = [
  {
    key: 'fullness',
    prompt: 'How full do you feel right now?',
    low: 'Still hungry',
    high: 'Very full',
  },
  {
    key: 'awareness',
    prompt: 'How tuned in were you to your body during this meal?',
    low: 'Not at all',
    high: 'Fully present',
  },
];

function ScaleRow({ value, onChange, low, high }) {
  return (
    <div>
      <div className="flex justify-between gap-2">
        {SCALE.map((n) => (
          <button
            key={n}
            onClick={() => onChange(n)}
            className={`flex-1 aspect-square rounded-xl text-lg font-semibold transition-colors ${
              value === n
                ? 'bg-pace-good text-slate-900'
                : 'bg-slate-800 text-slate-300 active:bg-slate-700'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-500">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

export default function CheckIn() {
  const { submitCheckIn, dismissCheckIn } = useSessionStore();
  const [answers, setAnswers] = useState({ fullness: null, awareness: null });

  const complete = answers.fullness != null && answers.awareness != null;

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-slate-950/70 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-t-3xl bg-slate-900 px-6 pb-10 pt-6 border-t border-slate-800">
        <div className="mx-auto mb-6 h-1.5 w-12 rounded-full bg-slate-700" />
        <h2 className="text-xl font-bold text-center">Post-meal check-in</h2>
        <p className="text-sm text-slate-400 text-center mt-1">Two quick questions.</p>

        <div className="mt-8 flex flex-col gap-8">
          {QUESTIONS.map((q) => (
            <div key={q.key}>
              <p className="mb-3 font-medium text-slate-100">{q.prompt}</p>
              <ScaleRow
                value={answers[q.key]}
                low={q.low}
                high={q.high}
                onChange={(n) => setAnswers((a) => ({ ...a, [q.key]: n }))}
              />
            </div>
          ))}
        </div>

        <button
          disabled={!complete}
          onClick={() => submitCheckIn(answers)}
          className="mt-10 w-full rounded-2xl bg-pace-good py-4 text-lg font-semibold text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] transition"
        >
          Save
        </button>
        <button
          onClick={dismissCheckIn}
          className="mt-3 w-full py-3 text-sm text-slate-500"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
