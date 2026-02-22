/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Primary dark navy — main background
        navy: {
          950: '#0D1B2A',
          900: '#0f2236',
          800: '#132d46',
          700: '#1a3a5c',
        },
        // Surface layers on top of navy
        surface: {
          DEFAULT: '#112233',
          raised: '#162d44',
          border: '#1e3a52',
        },
        // Semantic accent colours used throughout
        accent: {
          green: '#4ade80',
          greenDim: '#166534',
          amber: '#f59e0b',
          amberDim: '#78350f',
          red: '#f87171',
          blue: '#60a5fa',
          blueDim: '#1e3a5f',
          cyan: '#22d3ee',
        },
      },
      fontFamily: {
        sans: ['Inter', 'SF Pro Display', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      backgroundImage: {
        'grid-faint': `linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)`,
      },
      backgroundSize: {
        grid: '40px 40px',
      },
    },
  },
  plugins: [],
};
