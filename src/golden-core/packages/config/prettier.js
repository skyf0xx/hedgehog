/**
 * Locked, shared Prettier config — extended by every app/lib.
 *
 * Deliberately does NOT include `prettier-plugin-tailwindcss`: the plugin
 * parses every file Prettier touches (not just files with Tailwind
 * classes) and throws on any file when no Tailwind config is resolvable
 * yet — true for every project from this step through `apps/web`'s own
 * setup. Add the plugin to `apps/web`'s own Prettier config (extending
 * this base) once Tailwind exists there, not here.
 */
export default {
  singleQuote: true,
};
