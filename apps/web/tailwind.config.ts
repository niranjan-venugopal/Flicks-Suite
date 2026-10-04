import type { Config } from 'tailwindcss'

// Round O: dark/light are driven by <html data-theme> (lib/theme/theme.ts), so
// every colour below resolves through the CSS tokens in app/globals.css.
// Brand colours use the SPACE-separated --x-rgb triplets so the /NN alpha
// modifiers (bg-brand-blue/10 …) keep working; alpha tokens (surface*, border*,
// text2, muted, faint) are plain var() — nothing applies a /NN to those.
const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: 'rgb(var(--bg-rgb) / <alpha-value>)',
          bg2: 'rgb(var(--bg-2-rgb) / <alpha-value>)',
          blue: 'rgb(var(--blue-rgb) / <alpha-value>)',
          blue2: 'var(--blue-2)',
          yellow: 'rgb(var(--yellow-rgb) / <alpha-value>)',
          coral: 'rgb(var(--coral-rgb) / <alpha-value>)',
          green: 'rgb(var(--green-rgb) / <alpha-value>)',
          purple: 'rgb(var(--purple-rgb) / <alpha-value>)',
          surface: 'var(--surf-1)',
          surface2: 'var(--surf-2)',
          surface3: 'var(--surf-3)',
          border: 'var(--bord)',
          border2: 'var(--bord-2)',
          border3: 'var(--bord-3)',
          text: 'rgb(var(--text-rgb) / <alpha-value>)',
          text2: 'var(--text-2)',
          muted: 'var(--text-mute)',
          faint: 'var(--text-faint)',
        },
        // Theme ink (white in dark, #101828 in light) — replaces the
        // dark-assuming *-white/NN utilities; `white` itself stays honest.
        ink: 'rgb(var(--text-rgb) / <alpha-value>)',
        // Text on a solid accent fill (blue/coral/green buttons).
        'on-accent': 'var(--on-accent)',
        // Overlay scrim (was bg-black/60).
        scrim: 'var(--scrim)',
        // Opaque popover / menu face.
        pop: 'var(--surf-pop)',
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
        'e1': 'var(--e1)',
        'e2': 'var(--e2)',
        'e3': 'var(--e3)',
        'glow-blue':   'var(--glow-blue)',
        'glow-green':  '0 0 20px rgb(var(--green-rgb) / .3)',
        'glow-coral':  '0 0 20px rgb(var(--coral-rgb) / .3)',
        'glow-yellow': '0 0 20px rgb(var(--yellow-rgb) / .3)',
        'glow-purple': '0 0 20px rgb(var(--purple-rgb) / .3)',
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
