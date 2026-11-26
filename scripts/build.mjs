import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const web = (file) =>
  readFileSync(new URL('../web/' + file, import.meta.url), 'utf8')
const js = await build({
  entryPoints: ['web/app.ts'],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2020',
})
const html = web('index.html')
  .replace('/*STYLE*/', () => web('style.css'))
  .replace('/*SCRIPT*/', () =>
    js.outputFiles[0].text.replaceAll('</script', '<\\/script'),
  )
mkdirSync('dist', { recursive: true })
writeFileSync('dist/skyjo-coach.html', html)
console.log('Built offline coach (' + Buffer.byteLength(html) + ' bytes)')
