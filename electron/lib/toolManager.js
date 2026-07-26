'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { app } = require('electron')
const AdmZip = require('adm-zip')

const DEFINITIONS = {
  vgmstream: { repo: 'vgmstream/vgmstream', asset: /^vgmstream-win64\.zip$/i, exe: /^vgmstream-cli\.exe$/i, label: 'vgmstream' },
  uassettool: { repo: 'XzantGaming/UAssetToolRivals', asset: /^UAssetTool-win-x64\.zip$/i, exe: /^UAssetTool\.exe$/i, label: 'UAssetTool Rivals' }
}

let progressSink = null
function setProgressSink (fn) { progressSink = fn }
function emit (payload) { if (progressSink) progressSink(payload) }

function toolsRoot () { return path.join(app.getPath('userData'), 'tools') }
function toolDir (name) { return path.join(toolsRoot(), name) }

function walk (root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(full)); else out.push(full)
  }
  return out
}

function executable (name) {
  const def = DEFINITIONS[name]
  if (!def) return null
  return walk(toolDir(name)).find(p => def.exe.test(path.basename(p))) || null
}

function bundledFile (...parts) {
  const normal = path.join(__dirname, '..', ...parts)
  return app.isPackaged ? normal.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`) : normal
}

function meshExporterExecutable () { return bundledFile('bin', 'mesh-exporter', 'RivalsMeshExporter.exe') }
function marvelMappingsFile () { return bundledFile('data', 'MarvelRivals.usmap') }

function status () {
  const result = {}
  for (const [name, def] of Object.entries(DEFINITIONS)) {
    const exe = executable(name)
    result[name] = { installed: !!exe, path: exe, label: def.label }
  }
  return result
}

async function download (url, dest, name) {
  const res = await fetch(url, { headers: { 'User-Agent': 'RivalsModManager/2.0' }, signal: AbortSignal.timeout(120000) })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const file = fs.createWriteStream(dest)
  const reader = res.body.getReader()
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    await new Promise((resolve, reject) => file.write(Buffer.from(value), e => e ? reject(e) : resolve()))
    emit({ tool: name, status: 'downloading', received, total })
  }
  await new Promise(resolve => file.end(resolve))
}

async function installOne (name) {
  const def = DEFINITIONS[name]
  if (!def) throw new Error(`Unknown tool: ${name}`)
  emit({ tool: name, status: 'checking' })
  const release = await fetch(`https://api.github.com/repos/${def.repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RivalsModManager/2.0' },
    signal: AbortSignal.timeout(30000)
  }).then(r => { if (!r.ok) throw new Error(`GitHub release lookup failed (${r.status})`); return r.json() })
  const asset = (release.assets || []).find(a => def.asset.test(a.name))
  if (!asset || !/^https:\/\/github\.com\//i.test(asset.browser_download_url)) throw new Error(`No Windows release found for ${def.label}.`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rmm-${name}-`))
  const zipPath = path.join(tmp, asset.name)
  try {
    await download(asset.browser_download_url, zipPath, name)
    emit({ tool: name, status: 'installing' })
    const dest = toolDir(name)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    new AdmZip(zipPath).extractAllTo(dest, true)
    const exe = executable(name)
    if (!exe) throw new Error(`${def.label} downloaded, but its executable was not found.`)
    fs.writeFileSync(path.join(dest, 'install.json'), JSON.stringify({ tag: release.tag_name, installedAt: Date.now(), source: asset.browser_download_url }, null, 2))
    emit({ tool: name, status: 'done' })
    return { name, path: exe, version: release.tag_name }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function install (names) {
  const results = []
  for (const name of names) results.push(await installOne(name))
  return { results, status: status() }
}

function run (name, args, options = {}) {
  const exe = executable(name)
  if (!exe) throw new Error(`${DEFINITIONS[name]?.label || name} is not installed. Install helper tools first.`)
  return runExecutable(exe, DEFINITIONS[name]?.label || name, args, options)
}

function runExecutable (exe, label, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: options.cwd || path.dirname(exe), windowsHide: true })
    let stdout = ''; let stderr = ''; let killed = false
    const timer = setTimeout(() => { killed = true; child.kill() }, options.timeout || 10 * 60 * 1000)
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-200000) })
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-200000) })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (killed) return reject(new Error(`${label} timed out.`))
      if (code !== 0) return reject(new Error((stderr || stdout || `${label} exited with code ${code}`).trim()))
      resolve({ stdout, stderr })
    })
  })
}

async function exportMeshes (inputDir, outputDir, options = {}) {
  const exe = meshExporterExecutable()
  const mappings = marvelMappingsFile()
  if (!fs.existsSync(exe)) throw new Error('The built-in Marvel mesh converter is missing from this build.')
  if (!fs.existsSync(mappings)) throw new Error('The Marvel Rivals asset mappings are missing from this build.')
  fs.mkdirSync(outputDir, { recursive: true })
  const args = [inputDir, outputDir, mappings]
  if (options.gamePaks && fs.existsSync(options.gamePaks)) args.push(options.gamePaks, String(options.aesKey || ''))
  const { stdout } = await runExecutable(exe, 'Marvel mesh converter', args, { timeout: 12 * 60 * 1000 })
  const line = stdout.split(/\r?\n/).map(x => x.trim()).reverse().find(x => x.startsWith('{') && x.endsWith('}'))
  if (!line) throw new Error('The mesh converter did not return a usable result.')
  try { return JSON.parse(line) } catch { throw new Error('The mesh converter returned an unreadable result.') }
}

async function decodeWem (input, output) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  await run('vgmstream', ['-o', output, input], { timeout: 120000 })
  if (!fs.existsSync(output)) throw new Error('vgmstream did not create a WAV preview.')
  return output
}

async function createPak (output, inputDir) {
  fs.mkdirSync(path.dirname(output), { recursive: true })
  await run('uassettool', ['create_pak', output, inputDir, '--mount-point', '../../../', '--no-compress'])
  if (!fs.existsSync(output)) throw new Error('UAssetTool did not create the PAK file.')
  return output
}

module.exports = { toolsRoot, status, install, executable, run, decodeWem, createPak, exportMeshes, meshExporterExecutable, marvelMappingsFile, setProgressSink }
