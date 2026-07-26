'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const roots = new Map()

const MIME = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.obj': 'text/plain'
}

function registerRoot (root) {
  const resolved = path.resolve(root)
  const token = crypto.createHash('sha1').update(resolved + Date.now() + Math.random()).digest('hex').slice(0, 16)
  roots.set(token, resolved)
  return token
}

function assetUrl (token, filePath) {
  const root = roots.get(token)
  if (!root) throw new Error('Preview session expired.')
  const rel = path.relative(root, path.resolve(filePath)).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Asset is outside the preview session.')
  return `preview://${token}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

function resolveRequest (urlString) {
  const url = new URL(urlString)
  const root = roots.get(url.hostname)
  if (!root) return null
  const rel = url.pathname.split('/').filter(Boolean).map(decodeURIComponent).join(path.sep)
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null
}

// Chromium's native audio controls seek with HTTP-style byte ranges. A plain
// file response can play from the beginning but may report 0:00 initially or
// jump back when the user scrubs, so serve explicit 206 responses here.
function responseForRequest (urlString, rangeHeader = '', method = 'GET') {
  const file = resolveRequest(urlString)
  if (!file) return null
  const size = fs.statSync(file).size
  const headers = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=3600',
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
  }
  let start = 0
  let end = Math.max(0, size - 1)
  let status = 200
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)/i)
  if (match && size > 0) {
    if (match[1]) start = Number(match[1])
    if (match[2]) end = Math.min(end, Number(match[2]))
    if (!match[1] && match[2]) start = Math.max(0, size - Number(match[2]))
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
      return { body: null, status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } }
    }
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(size ? end - start + 1 : 0)
  const body = method === 'HEAD' ? null : fs.readFileSync(file).subarray(start, end + 1)
  return { body, status, headers }
}

function readAsset (urlString, maxBytes = 512 * 1024 * 1024) {
  const file = resolveRequest(urlString)
  if (!file) throw new Error('The preview asset is missing or the preview session expired.')
  const size = fs.statSync(file).size
  if (size > maxBytes) throw new Error(`This model is too large to preview (${Math.ceil(size / 1024 / 1024)} MB).`)
  return { bytes: fs.readFileSync(file), name: path.basename(file), mime: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' }
}

module.exports = { registerRoot, assetUrl, resolveRequest, responseForRequest, readAsset }
