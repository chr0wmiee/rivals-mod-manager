'use strict'

// Port-free development runner: Vite writes to dist in watch mode and Electron
// loads those files directly. No localhost server or network listener is used.
const { build } = require('vite')
const { spawn } = require('child_process')
const electron = require('electron')

let child = null
let closing = false

async function main () {
  const watcher = await build({
    build: { watch: { clearScreen: false } }
  })
  watcher.on('event', event => {
    if (event.code === 'ERROR') console.error(event.error)
    if (event.code === 'BUNDLE_END' && !child) {
      child = spawn(electron, ['.'], {
        stdio: 'inherit',
        env: { ...process.env, RIVALS_DEV_WATCH: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
      })
      child.on('exit', code => {
        child = null
        if (!closing) process.exitCode = code || 0
      })
    }
  })
  const stop = async () => {
    if (closing) return
    closing = true
    if (child) child.kill()
    await watcher.close()
    process.exit()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch(error => { console.error(error); process.exit(1) })
