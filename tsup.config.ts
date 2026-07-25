import { defineConfig } from 'tsup'

// Dual build is a hard requirement, not a nicety: the six backend services are
// NestJS/CommonJS (`"module": "commonjs"`, target ES2021) while the dashboard is
// Nuxt/Vite/ESM. Both consume this package.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // arbundles is a peer dep — never bundle it, or a consumer ends up with two
  // copies and `instanceof Signer` checks start failing.
  //
  // We import the /web build specifically. Its node entry pulls in `axios` without
  // declaring it as a dependency (so a clean install crashes at import), and the web
  // build is the same code the dashboard runs — the exact path D6 proved produces a
  // byte-identical, node-verifiable ans104 signature. It has no fs/stream deps, so it
  // works equally well under Node.
  external: [/^@dha-team\/arbundles/],
})
