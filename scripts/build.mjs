import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const names = (await readdir(new URL('src/', root))).filter((name) => name.endsWith('.js')).sort()
const source = (await Promise.all(names.map((name) => readFile(new URL(`src/${name}`, root), 'utf8')))).join('\n')
const builtAt = new Date().toISOString()

const banner = `/* Lampa Tor Updater v${pkg.version} | built ${builtAt} | https://github.com/WatherMG/lampa-tor-updater */\n`
const output = banner + source
  .replaceAll('__PLUGIN_VERSION__', pkg.version)
  .replaceAll('__PLUGIN_BUILD_DATE__', builtAt)

await mkdir(new URL('dist/', root), { recursive: true })
await writeFile(new URL('dist/plugin.js', root), output)
await writeFile(new URL('plugin.js', root), output)
