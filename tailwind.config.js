/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        pace: {
          good: '#22c55e',
          warn: '#f59e0b',
          over: '#ef4444',
        },
      },
    },
  },
  plugins: [],
};
