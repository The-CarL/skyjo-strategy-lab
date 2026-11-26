import { build } from 'esbuild'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const web = (file) =>
  readFileSync(new URL('../web/' + file, import.meta.url), 'utf8')
const release = JSON.parse(web('release.json'))
const otherPaper = release.paper === 'value-upgrade' ? 'keep-3' : 'value-upgrade'
const paper = (id) => web('paper/' + id + '.html')
const js = await build({
  entryPoints: ['web/app.ts'],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2020',
  define: {
    __VALUE_UPGRADE__: String(release.paper === 'value-upgrade'),
    __MATCH_MODEL__: String(release.matchModel),
  }
})
const css = web('style.css')
const html = web('index.html')
  .replace('/*STYLE*/', () => css)
  .replace('<!--PAPER-->', () => paper(release.paper))
  .replace('/*SCRIPT*/', () =>
    js.outputFiles[0].text.replaceAll('</script', '<\\/script'),
  )
mkdirSync('dist', { recursive: true })
writeFileSync('dist/skyjo-coach.html', html)
writeFileSync('dist/skyjo-comparison-card.html',
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Skyjo comparison card</title><style>' +
  css + '</style><body class="show-card"><section id="rulecard">' + paper(otherPaper) + '</section></body></html>')
console.log('Built offline coach (' + Buffer.byteLength(html) + ' bytes)')
