import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: '#01010D',
          bg2: '#0A0A18',
          blue: '#3E7BFA',
          blue2: '#5A95FF',
          yellow: '#FED800',
          coral: '#F8786B',
          green: '#27D280',
          purple: '#9B7BFA',
          surface: 'rgba(255,255,255,0.04)',
          surface2: 'rgba(255,255,255,0.06)',
          surface3: 'rgba(255,255,255,0.10)',
          border: 'rgba(255,255,255,0.08)',
          border2: 'rgba(255,255,255,0.14)',
          border3: 'rgba(255,255,255,0.22)',
          text: '#FFFFFF',
          text2: 'rgba(255,255,255,0.7)',
          muted: 'rgba(255,255,255,0.5)',
          faint: 'rgba(255,255,255,0.32)',
        },
      },
      fontFamily: {
        gilroy: ['Gilroy', 'sans-serif'],
      },
      borderRadius: {
        xs: '6px',
        sm: '10px',
        DEFAULT: '14px',
        md: '14px',
        lg: '18px',
        xl: '24px',
        pill: '999px',
      },
      backgroundImage: {
        'gradient-blue':   'linear-gradient(135deg, #3E7BFA, #5A95FF)',
        'gradient-green':  'linear-gradient(135deg, #27D280, #3FE69E)',
        'gradient-coral':  'linear-gradient(135deg, #F8786B, #FFA08D)',
        'gradient-yellow': 'linear-gradient(135deg, #FED800, #FFE94D)',
        'gradient-purple': 'linear-gradient(135deg, #9B7BFA, #B89BFF)',
      },
      boxShadow: {
        'e1': '0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 14px rgba(0,0,0,0.3)',
        'e2': '0 1px 0 rgba(255,255,255,0.06) inset, 0 12px 28px rgba(0,0,0,0.4)',
        'e3': '0 1px 0 rgba(255,255,255,0.08) inset, 0 24px 60px rgba(0,0,0,0.5)',
        'glow-blue':   '0 0 0 1px rgba(62,123,250,0.3), 0 12px 30px rgba(62,123,250,0.4)',
        'glow-green':  '0 0 20px rgba(39,210,128,0.3)',
        'glow-coral':  '0 0 20px rgba(248,120,107,0.3)',
        'glow-yellow': '0 0 20px rgba(254,216,0,0.3)',
        'glow-purple': '0 0 20px rgba(155,123,250,0.3)',
      },
      animation: {
        'float-slow': 'floatSlow 8s ease-in-out infinite',
        'float-medium': 'floatMedium 6s ease-in-out infinite',
        'pulse-glow': 'pulseGlow 3s ease-in-out infinite',
        'slide-in-left': 'slideInLeft 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        floatSlow: {
          '0%, 100%': { transform: 'translateY(0px) scale(1)' },
          '50%': { transform: 'translateY(-20px) scale(1.05)' },
        },
        floatMedium: {
          '0%, 100%': { transform: 'translateY(0px) scale(1)' },
          '50%': { transform: 'translateY(-15px) scale(1.03)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        slideInLeft: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}

export default config
