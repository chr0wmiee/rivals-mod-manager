'use strict'

const fs = require('fs')
const path = require('path')

function parseSections (buffer) {
  const sections = []
  let pos = 0
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    if (!/^[A-Z0-9]{4}$/.test(id) || pos + 8 + size > buffer.length) break
    sections.push({ id, offset: pos, size, data: buffer.subarray(pos + 8, pos + 8 + size) })
    pos += 8 + size
  }
  return sections
}

function sniffWem (buffer) {
  let channels = null; let sampleRate = null
  if (buffer.toString('ascii', 0, 4) === 'RIFF') {
    let pos = 12
    while (pos + 8 <= buffer.length) {
      const id = buffer.toString('ascii', pos, pos + 4)
      const size = buffer.readUInt32LE(pos + 4)
      if (id === 'fmt ' && size >= 8) {
        channels = buffer.readUInt16LE(pos + 10)
        sampleRate = buffer.readUInt32LE(pos + 12)
        break
      }
      pos += 8 + size + (size % 2)
    }
  }
  return { channels, sampleRate, bytes: buffer.length }
}

function parseBnkBuffer (buffer) {
  const sections = parseSections(buffer)
  const didx = sections.find(s => s.id === 'DIDX')
  const data = sections.find(s => s.id === 'DATA')
  if (!didx || !data) throw new Error('This BNK has no DIDX/DATA media sections.')
  const entries = []
  for (let pos = 0; pos + 12 <= didx.data.length; pos += 12) {
    const id = didx.data.readUInt32LE(pos)
    const offset = didx.data.readUInt32LE(pos + 4)
    const size = didx.data.readUInt32LE(pos + 8)
    if (offset + size > data.data.length) continue
    entries.push({ id, offset, size, ...sniffWem(data.data.subarray(offset, offset + size)) })
  }
  return { sections, entries, data }
}

function readBnk (filePath) { return parseBnkBuffer(fs.readFileSync(filePath)) }

function extractWem (bankPath, wemId, outputPath) {
  const parsed = readBnk(bankPath)
  const entry = parsed.entries.find(e => Number(e.id) === Number(wemId))
  if (!entry) throw new Error(`WEM ${wemId} was not found in ${path.basename(bankPath)}.`)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, parsed.data.data.subarray(entry.offset, entry.offset + entry.size))
  return { outputPath, ...entry }
}

function replaceWem (bankPath, wemId, replacement, outputPath) {
  const original = fs.readFileSync(bankPath)
  const parsed = parseBnkBuffer(original)
  const target = parsed.entries.find(e => Number(e.id) === Number(wemId))
  if (!target) throw new Error(`WEM ${wemId} is not embedded in this BNK.`)

  const media = new Map(parsed.entries.map(e => [e.id, Buffer.from(parsed.data.data.subarray(e.offset, e.offset + e.size))]))
  media.set(target.id, Buffer.from(replacement))
  const didx = Buffer.alloc(parsed.entries.length * 12)
  const chunks = []
  let cursor = 0
  parsed.entries.forEach((entry, index) => {
    const bytes = media.get(entry.id)
    const aligned = (cursor + 15) & ~15
    if (aligned > cursor) chunks.push(Buffer.alloc(aligned - cursor))
    cursor = aligned
    didx.writeUInt32LE(entry.id, index * 12)
    didx.writeUInt32LE(cursor, index * 12 + 4)
    didx.writeUInt32LE(bytes.length, index * 12 + 8)
    chunks.push(bytes)
    cursor += bytes.length
  })
  const data = Buffer.concat(chunks)
  const rebuilt = parsed.sections.map(section => {
    const body = section.id === 'DIDX' ? didx : section.id === 'DATA' ? data : section.data
    const header = Buffer.alloc(8)
    header.write(section.id, 0, 4, 'ascii')
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body])
  })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, Buffer.concat(rebuilt))
  return { outputPath, wemId: target.id, originalBytes: target.size, replacementBytes: replacement.length }
}

module.exports = { parseSections, parseBnkBuffer, readBnk, extractWem, replaceWem, sniffWem }
