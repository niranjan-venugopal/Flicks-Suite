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
          blue: '#2B69F5',
          yellow: '#FFC72C',
          coral: '#FF6B6B',
          green: '#00C9A7',
          surface: 'rgba(255,255,255,0.05)',
          border: 'rgba(255,255,255,0.08)',
          text: '#FFFFFF',
          muted: 'rgba(255,255,255,0.5)',
        },
      },
      fontFamily: {
        gilroy: ['Gilroy', 'sans-serif'],
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
      backgroundImage: {
        'gradient-blue': 'linear-gradient(135deg, #2B69F5, #1a4fd4)',
        'gradient-green': 'linear-gradient(135deg, #00C9A7, #00a88c)',
        'gradient-coral': 'linear-gradient(135deg, #FF6B6B, #ff4f4f)',
        'gradient-yellow': 'linear-gradient(135deg, #FFC72C, #ffb800)',
      },
      boxShadow: {
        'glow-blue': '0 0 20px rgba(43,105,245,0.3)',
        'glow-green': '0 0 20px rgba(0,201,167,0.3)',
        'glow-coral': '0 0 20px rgba(255,107,107,0.3)',
        'glow-yellow': '0 0 20px rgba(255,199,44,0.3)',
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
