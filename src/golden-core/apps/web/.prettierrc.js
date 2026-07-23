import base from '../../packages/config/prettier.js';

export default {
  ...base,
  plugins: ['prettier-plugin-tailwindcss'],
  // Tailwind v4 has no tailwind.config.js to autodetect — the plugin
  // requires this explicit path (resolved relative to this file) to
  // locate the design system.
  tailwindStylesheet: './src/app/global.css',
};
