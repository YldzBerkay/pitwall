/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  // The app is dark-only and sets the scheme itself; on web, media-based dark
  // mode makes that a runtime error, so drive it from a class instead.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        deepspace: '#0B0C0F',
        elevated: '#17181C',
        surface2: '#1F2024',
        sidebar: 'rgba(23, 24, 28, 0.92)',
        glass: '#17181C',
        'glass-strong': '#1F2024',
        accent: '#D4FF3D',
        'accent-light': '#D4FF3D',
        'accent-soft': 'rgba(212, 255, 61, 0.12)',
        'on-accent': '#14151A',
        violet: '#9B5CFF',
        cyan: '#2DD4BF',
        coral: '#FF3B5C',
        matrix: '#2DD4BF',
        amber: '#E3B341',
        purple: '#9B5CFF',
        'text-primary': '#F5F6F2',
        'text-secondary': '#9A9C9F',
        'text-tertiary': '#5C5E63',
        'border-default': 'rgba(255, 255, 255, 0.08)',
        'border-active': 'rgba(212, 255, 61, 0.5)',
        'border-top': 'rgba(255, 255, 255, 0.10)',
      },
      fontFamily: {
        display: ['BarlowCondensed_700Bold'],
        'display-extra': ['BarlowCondensed_800ExtraBold'],
        body: ['Inter_400Regular'],
        'body-medium': ['Inter_500Medium'],
        'body-semi': ['Inter_600SemiBold'],
        mono: ['JetBrainsMono_700Bold'],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
    },
  },
  plugins: [],
};
