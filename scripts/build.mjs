import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const read = name => readFile(new URL('../web/' + name, import.meta.url), 'utf8')

export async function buildCoach(directory, { hosted = false } = {}) {
  const release = JSON.parse(await read('release.json'))
  const otherPaper = release.paper === 'value-upgrade' ? 'keep-3' : 'value-upgrade'
  const [source, css, paper, bundle] = await Promise.all([
    read('index.html'),
    read('style.css'),
    read('paper/' + release.paper + '.html'),
    build({
      entryPoints: ['web/app.ts'],
      bundle: true,
      write: false,
      minify: true,
      format: 'iife',
      target: 'es2020',
      define: {
        __VALUE_UPGRADE__: String(release.paper === 'value-upgrade'),
        __MATCH_MODEL__: String(release.matchModel),
      },
    }),
  ])
  const js = bundle.outputFiles[0].text
  const style = hosted ? '<link rel="stylesheet" href="/coach/style.css">' : '<style>' + css + '</style>'
  const script = hosted
    ? '<script src="/coach/app.js" defer></script>'
    : '<script>' + js.replace(/<\/script/gi, '<\\/script') + '</script>'
  const html = source
    .replace('<!--COACH_STYLE-->', () => style)
    .replace('<!--COACH_SCRIPT-->', () => script)
    .replace('<!--PAPER-->', () => paper)
    .replace('<!--ONLINE_NAV-->', hosted ? '<a id="online-nav" href="/">Back to game</a>' : '')

  await mkdir(directory, { recursive: true })
  if (hosted) {
    await Promise.all([
      writeFile(join(directory, 'index.html'), html),
      writeFile(join(directory, 'app.js'), js),
      writeFile(join(directory, 'style.css'), css),
    ])
  } else {
    const comparison = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Skyjo comparison card</title><style>' +
      css + '</style><body class="show-card"><section id="rulecard">' +
      await read('paper/' + otherPaper + '.html') + '</section></body></html>'
    await Promise.all([
      writeFile(join(directory, 'skyjo-coach.html'), html),
      writeFile(join(directory, 'skyjo-comparison-card.html'), comparison),
    ])
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildCoach('dist')
  console.log('Built offline coach and comparison card in dist')
}
