import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    // `rrule` ships CJS (`main`) + ESM (`module`) but no `exports` map, so
    // Node's SSR loader resolves the CJS build and rejects named imports
    // ("Named export 'RRule' not found"), which breaks SvelteKit's postbuild
    // analyse. Inlining it lets Node load only the bundled ESM output.
    // Do not "optimize" this back to external: `bun run server:compile` needs
    // the named ESM export, i.e. the opposite of what Node's CJS path needs.
    noExternal: ['rrule']
  },
  server: {
    fs: {
      // Allow serving files from the project root and data directory
      allow: ['..']
    }
  }
});
