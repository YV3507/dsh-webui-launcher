// Build the dsh-webui-launcher plugin with esbuild: host half to lib/index.js
// (ESM, official packages external), browser half to lib/client.js in the
// __ModuleLoader__ factory contract the DSH web client loader expects (react
// and the official client packages resolve at runtime; the plugin's own code
// is inlined). Mirrors dsh-git-panel/build.mjs without CSS modules — the
// settings card uses inline styles.
import { build } from 'esbuild'
import { join } from 'node:path'

/** Script directory — entry/output paths resolve against it, not the cwd. */
const root = import.meta.dirname

/** Shared esbuild options for both halves. */
const common = {
  bundle: true,
  sourcemap: true,
  legalComments: 'none',
}

/** Host half: ESM, official packages resolve at runtime through peer deps;
 * jimp (lazy-imported for icon conversion) is a declared runtime dependency. */
await build({
  ...common,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'lib/index.js'),
  format: 'esm',
  platform: 'node',
  target: 'node18',
  external: ['@deepseek-ai/*', 'jimp'],
})

/** Browser half: the __ModuleLoader__ factory contract; react + official
 * client packages resolve at runtime from the profile's node_modules. */
await build({
  ...common,
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'lib/client.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  external: ['react', 'react/jsx-runtime', 'clsx', '@deepseek-ai/*'],
  banner: {
    js: 'window.__ModuleLoader__.load({\n\tid: "dsh-webui-launcher",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  },
  footer: {
    js: '\n\t\treturn module.exports;\n\t},\n});',
  },
})

console.log('built lib/index.js and lib/client.js')
