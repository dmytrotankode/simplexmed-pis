// Збірка стилів веб-кабінету «Плексі» (замість cdn.tailwindcss.com): node pis/tools/tailwind/build.cjs
// Усі кольори — токени з :root у web/index.html (світла/нічна тема за системою).
// Фірмовий синій лише для дій і активного пункту; помаранчевий — лише «потребує вашої дії»; без зеленого й червоного.
const path = require('path');
const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const scale = name => Object.fromEntries(shades.map(n => [n, `rgb(var(--${name}-${n}) / <alpha-value>)`]));
const accent = scale('accent'), attention = scale('attention'), neutral = scale('neutral');

module.exports = {
  content: [path.join(__dirname, '../../web/index.html'), path.join(__dirname, '../../web/tester.js')],
  theme: {
    extend: {
      colors: {
        white: 'rgb(var(--surface) / <alpha-value>)',
        slate: neutral, gray: neutral,
        blue: accent, indigo: accent, sky: accent, emerald: accent, green: accent, teal: accent,
        rose: attention, red: attention, amber: attention, orange: attention, yellow: attention,
      },
      fontFamily: { sans: ['Manrope', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      fontSize: {
        xs: ['0.875rem', '1.3rem'],
        sm: ['0.9375rem', '1.4rem'],
        base: ['1.0625rem', '1.6rem'],
        lg: ['1.25rem', '1.75rem'],
      },
    },
  },
};
