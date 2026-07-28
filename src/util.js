export function formatNumber (n) {
  if (n == null) return '-'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(n)
}

export function formatSizeKb (kb) {
  if (!kb && kb !== 0) return ''
  if (kb >= 1024 * 1024) return (kb / 1024 / 1024).toFixed(2) + ' GB'
  if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB'
  return Math.round(kb) + ' KB'
}

export function formatBytes (b) {
  if (!b && b !== 0) return ''
  return formatSizeKb(b / 1024)
}

export function timeAgo (dateish) {
  if (!dateish) return ''
  const t = typeof dateish === 'number' ? dateish : Date.parse(dateish)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 90) return 'just now'
  const m = s / 60
  if (m < 90) return `${Math.round(m)} min ago`
  const h = m / 60
  if (h < 36) return `${Math.round(h)} hr ago`
  const d = h / 24
  if (d < 45) return `${Math.round(d)} days ago`
  const mo = d / 30.4
  if (mo < 18) return `${Math.round(mo)} months ago`
  return `${Math.round(mo / 12)} years ago`
}

export function formatDate (dateish) {
  if (!dateish) return '-'
  const t = typeof dateish === 'number' ? dateish : Date.parse(dateish)
  if (Number.isNaN(t)) return '-'
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const escapeHtml = s => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Authors write descriptions in the Nexus web editor, which leaves raw HTML
// (mostly <br />) mixed in with BBCode. Fold that layout markup into plain
// newlines and drop every other tag BEFORE escaping, so tags never reach the
// reader as literal text and no raw HTML survives into the output.
function stripRawHtml (s) {
  return s
    // The editor writes "line\n<br />line", so a <br> next to a real newline is
    // one break, not two. Consecutive <br><br> still survive as a real gap.
    .replace(/[ \t]*\r?\n?[ \t]*<\s*br\s*\/?\s*>[ \t]*\r?\n?/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<\s*(p|div|tr|li|h[1-6]|blockquote|hr)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
}

// Turn bare URLs into links, but only in text: never inside an existing anchor
// and never inside a tag's attributes.
function linkifyBareUrls (html) {
  let inAnchor = false
  return html.replace(/<a\b[^>]*>|<\/a\s*>|<[^>]*>|[^<]+/gi, token => {
    if (token.startsWith('<')) {
      if (/^<a\b/i.test(token)) inAnchor = true
      else if (/^<\/a/i.test(token)) inAnchor = false
      return token
    }
    if (inAnchor) return token
    return token.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, u => `<a href="${u}" data-ext="1">${u}</a>`)
  })
}

// Minimal BBCode renderer for Nexus mod descriptions. Input is escaped first,
// then a whitelist of tags is converted, so no raw HTML can pass through.
export function bbcodeToHtml (src) {
  if (!src) return ''
  let s = escapeHtml(stripRawHtml(String(src)))

  const safeUrl = u => (/^https?:\/\//i.test(u) ? u : '#')

  s = s
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>')
    .replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>')
    .replace(/\[center\]([\s\S]*?)\[\/center\]/gi, '<div style="text-align:center">$1</div>')
    .replace(/\[right\]([\s\S]*?)\[\/right\]/gi, '<div style="text-align:right">$1</div>')
    .replace(/\[heading\]([\s\S]*?)\[\/heading\]/gi, '<h3>$1</h3>')
    .replace(/\[size=\d+\]([\s\S]*?)\[\/size\]/gi, '<span>$1</span>')
    .replace(/\[color=([#a-zA-Z0-9]+)\]([\s\S]*?)\[\/color\]/gi, (_m, c, inner) =>
      /^#?[a-zA-Z0-9]{3,20}$/.test(c) ? `<span style="color:${c}">${inner}</span>` : inner)
    .replace(/\[img\]([\s\S]*?)\[\/img\]/gi, (_m, u) => `<img src="${safeUrl(u.trim())}" loading="lazy" />`)
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_m, u, t) => `<a href="${safeUrl(u.trim())}" data-ext="1">${t}</a>`)
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_m, u) => `<a href="${safeUrl(u.trim())}" data-ext="1">${u}</a>`)
    .replace(/\[youtube\]([\s\S]*?)\[\/youtube\]/gi, (_m, id) =>
      `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(id.trim())}" data-ext="1">▶ YouTube video</a>`)
    .replace(/\[quote(?:=[^\]]*)?\]([\s\S]*?)\[\/quote\]/gi, '<blockquote style="border-left:3px solid #444;padding-left:10px;margin:8px 0">$1</blockquote>')
    .replace(/\[spoiler\]([\s\S]*?)\[\/spoiler\]/gi, '<details><summary>Spoiler</summary>$1</details>')
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, '<pre>$1</pre>')
    .replace(/\[list(?:=[^\]]*)?\]([\s\S]*?)\[\/list\]/gi, (_m, inner) => {
      const items = inner.split(/\[\*\]/).map(x => x.trim()).filter(Boolean)
      return '<ul>' + items.map(x => `<li>${x}</li>`).join('') + '</ul>'
    })
    .replace(/\[\/?(font|line|mention|member|article|table|tr|td|th)[^\]]*\]/gi, '')

  s = linkifyBareUrls(s)

  // A run of dashes on its own line is a divider. Raw HTML is already gone and
  // everything else is escaped, so an <hr/> here can only be one we wrote.
  s = s.split('\n').map(line => (/^\s*[-=_*~]{4,}\s*$/.test(line) ? '<hr/>' : line)).join('\n')

  s = s.replace(/\r?\n/g, '<br/>')

  // Editors leave long stretches of blank lines behind; two is plenty.
  s = s.replace(/(?:<br\/>\s*){3,}/g, '<br/><br/>')
  s = s.replace(/(?:<br\/>)*<hr\/>(?:<br\/>)*/g, '<hr/>')

  return s.trim().replace(/^(?:<br\/>)+|(?:<br\/>)+$/g, '')
}

export const TYPE_LABELS = {
  skin: 'Skin',
  audio: 'Audio',
  voice: 'Voice',
  ui: 'UI / Visual',
  vfx: 'VFX',
  cinematic: 'Cinematic',
  map: 'Map',
  visual: 'Visual',
  gameplay: 'Gameplay'
}
