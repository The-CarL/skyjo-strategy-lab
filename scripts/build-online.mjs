import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

const out = 'online-dist/lambda'
await mkdir(out + '/public', { recursive: true })
await Promise.all([
  build({
    entryPoints: ['online/app.ts'], outfile: out + '/public/app.js',
    bundle: true, minify: true, target: 'es2020', format: 'esm', platform: 'browser',
  }),
  build({
    entryPoints: ['server/index.mjs'], outfile: out + '/index.mjs',
    bundle: true, minify: true, target: 'node22', format: 'esm', platform: 'node',
    banner: { js: "import { createRequire as __nodeRequire } from 'node:module'; const require = __nodeRequire(import.meta.url);" },
  }),
  ...['index.html', 'style.css'].map(name => copyFile('online/' + name, out + '/public/' + name)),
])
console.log('Built playable client and HTTP handler in ' + out)
