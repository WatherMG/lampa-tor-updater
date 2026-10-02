import { readFile } from 'node:fs/promises'

const root = await readFile(new URL('../plugin.js', import.meta.url), 'utf8')
const dist = await readFile(new URL('../dist/plugin.js', import.meta.url), 'utf8')

if (root !== dist) {
  console.error('plugin.js and dist/plugin.js differ')
  process.exit(1)
}

for (const placeholder of ['__PLUGIN_VERSION__', '__PLUGIN_BUILD_DATE__']) {
  if (root.includes(placeholder)) {
    console.error(`Unresolved build placeholder: ${placeholder}`)
    process.exit(1)
  }
}

console.log(`Build OK: ${Buffer.byteLength(root)} bytes`)
