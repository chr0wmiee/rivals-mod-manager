let activeController = null
let listening = false

function shouldIgnoreSpace (target) {
  if (!target) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.tagName === 'BUTTON') return true
  if (target.tagName === 'INPUT') return String(target.type || '').toLowerCase() !== 'range'
  return false
}

function onKeyDown (event) {
  if (event.code !== 'Space' || event.repeat || shouldIgnoreSpace(event.target) || !activeController) return
  event.preventDefault()
  activeController.toggle()
}

function ensureListener () {
  if (listening) return
  window.addEventListener('keydown', onKeyDown)
  listening = true
}

export function registerAudioController (controller) {
  ensureListener()
  if (!activeController) activeController = controller
  return () => { if (activeController === controller) activeController = null }
}

export function activateAudioController (controller) {
  ensureListener()
  activeController = controller
}

export function claimAudioController (controller) {
  ensureListener()
  if (activeController && activeController !== controller) activeController.pause?.()
  activeController = controller
}
