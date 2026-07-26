import { useState } from 'react'
import api from '../api.js'
import Icon from '../components/Icon.jsx'
import { useToast, ExtLink } from '../components/ui.jsx'

const UTOC_URL = 'https://www.nexusmods.com/marvelrivals/mods/2940'
const REPO_URL = 'https://github.com/chr0wmiee/rivals-mod-manager'

export default function SettingsPage ({ settings, refreshSettings, refreshLibrary, updater }) {
  const toast = useToast()
  const [aesKey, setAesKey] = useState(settings.aesKey || '')
  const [checking, setChecking] = useState(false)
  const [patchBusy, setPatchBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [clearing, setClearing] = useState(false)

  const patch = async obj => {
    await api.patchSettings(obj)
    await refreshSettings()
  }

  const nexusSignIn = async () => {
    setSigningIn(true)
    try {
      const result = await api.nexusWebLogin()
      await refreshSettings()
      if (result.loggedIn) toast.ok('Signed in to Nexus', 'In-app downloads are enabled.')
      else if (result.cancelled) toast.warn('Sign-in cancelled')
      else if (result.alreadyOpen) toast.info('Sign-in window is already open')
      else toast.warn('Not signed in', 'Could not confirm your Nexus login. Try again.')
    } catch (e) { toast.err('Sign-in failed', e.message) } finally { setSigningIn(false) }
  }

  const nexusSignOut = async () => {
    await api.nexusWebLogout()
    await refreshSettings()
    toast.ok('Signed out of Nexus')
  }

  const verifyNexus = async () => {
    setChecking(true)
    try {
      const result = await api.nexusWebVerify()
      await refreshSettings()
      if (result.loggedIn) toast.ok('Session verified', result.user ? `Signed in as ${result.user}` : 'Your account is ready.')
      else toast.warn('Session expired', 'Sign in again to download files.')
    } catch (e) { toast.err('Verification failed', e.message) } finally { setChecking(false) }
  }

  const pickGameDir = async () => {
    const dir = await api.chooseDirectory('Select your Marvel Rivals folder', settings.gameRoot || undefined)
    if (!dir) return
    const diag = await api.validateGamePath(dir)
    if (diag.ok) {
      await patch({ gameRoot: diag.gameRoot })
      toast.ok('Game folder saved', diag.gameRoot)
      refreshLibrary()
    } else {
      toast.err('Not the game folder', diag.reason)
    }
  }

  const redetect = async () => {
    const found = await api.detectGame()
    if (found) {
      await patch({ gameRoot: found.gameRoot })
      toast.ok('Game found', found.gameRoot)
      refreshLibrary()
    } else {
      toast.warn('Not found', 'Could not auto-detect Marvel Rivals. Use Browse instead.')
    }
  }

  const pickBackupDir = async () => {
    const dir = await api.chooseDirectory('Select backup folder', settings.effectiveBackupDir)
    if (!dir) return
    await patch({ backupDir: dir })
    toast.ok('Backup folder saved', dir)
    toast.warn('Note', 'Existing backups stay where they were. Move them manually if needed.')
  }

  const installPatch = async () => {
    const paths = await api.chooseFiles('Select the downloaded UTOC Signature Patch archive', [{ name: 'Archives', extensions: ['zip', '7z', 'rar'] }])
    if (!paths || paths.length === 0) return
    try {
      const r = await api.installUtocPatch(paths[0])
      await refreshSettings()
      toast.ok('UTOC patch installed', `${r.copied} file(s) copied into Binaries\\Win64`)
    } catch (e) {
      toast.err('Install failed', e.message)
    }
  }

  const installPatchNexus = async () => {
    setPatchBusy(true)
    try {
      const result = await api.installUtocPatchFromNexus()
      if (result.ok === false) {
        toast.warn('Install unavailable', result.needsLogin ? 'Sign in to Nexus and retry.' : result.error)
      } else {
        await refreshSettings()
        toast.ok('UTOC patch installed')
      }
    } catch (e) { toast.err('Install failed', e.message) } finally { setPatchBusy(false) }
  }

  const checkUpdates = async () => {
    try {
      const result = await updater.check()
      if (result.updateAvailable) {
        updater.setOpen(true)
      } else {
        toast.ok('Up to date', `You are running the latest version (${result.current}).`)
      }
    } catch (e) {
      toast.err('Update check failed', e.message)
    }
  }

  const clearCache = async () => {
    setClearing(true)
    try {
      await api.clearPreviewCache()
      toast.ok('Caches cleared', 'Previews and audio will re-extract on next use.')
    } catch (e) { toast.err('Could not clear cache', e.message) } finally { setClearing(false) }
  }

  return (
    <>
      <div className="page-title">Settings</div>

      <div className="settings-grid" style={{ marginTop: 16 }}>
        <div className="panel settings-block">
          <div className="panel-head">Game</div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Folder</dt><dd>{settings.gameRoot || <span style={{ color: 'var(--red)' }}>not set</span>}</dd>
            </dl>
            <div className="btn-row">
              <button className="btn btn-ghost btn-sm" onClick={redetect}><Icon name="search" size={13} /> Auto-detect</button>
              <button className="btn btn-ghost btn-sm" onClick={pickGameDir}><Icon name="folder" size={13} /> Browse…</button>
            </div>
          </div>
        </div>

        <div className="panel settings-block">
          <div className="panel-head">Backup vault</div>
          <div className="panel-body">
            <div className="note">Every mod is kept here.</div>
            <dl className="kv">
              <dt>Location</dt><dd>{settings.effectiveBackupDir}</dd>
            </dl>
            <div className="btn-row">
              <button className="btn btn-ghost btn-sm" onClick={pickBackupDir}><Icon name="folder" size={13} /> Change…</button>
              <button className="btn btn-ghost btn-sm" onClick={() => api.openBackupFolder()}><Icon name="external" size={13} /> Open</button>
            </div>
          </div>
        </div>

        <div className="panel settings-block">
          <div className="panel-head">Nexus account</div>
          <div className="panel-body">
            <div className={`path-status ${settings.nexusWebAuthed ? 'ok' : 'info'}`}>
              <Icon name={settings.nexusWebAuthed ? 'check' : 'info'} size={16} />
              <div style={{ flex: 1 }}>
                {settings.nexusWebAuthed
                  ? <>Signed in{settings.nexusWebUser ? <> as <b>{settings.nexusWebUser}</b></> : ''}.</>
                  : <>Not signed in. Sign in once to download files in-app.</>}
              </div>
            </div>
            <div className="btn-row">
              {settings.nexusWebAuthed
                ? <>
                  <button className="btn btn-ghost btn-sm" onClick={verifyNexus} disabled={checking}>{checking ? 'Checking…' : 'Verify session'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={nexusSignOut}>Sign out</button>
                </>
                : <button className="btn btn-primary btn-sm" onClick={nexusSignIn} disabled={signingIn}>{signingIn ? 'Waiting…' : 'Sign in to Nexus'}</button>}
            </div>
          </div>
        </div>

        <div className="panel settings-block">
          <div className="panel-head">UTOC Signature Patch</div>
          <div className="panel-body">
            <div className="note warn">Required for most mods to load.</div>
            <dl className="kv">
              <dt>Status</dt>
              <dd>{settings.utocPatchInstalled
                ? <span style={{ color: 'var(--green)' }}>✓ Installed</span>
                : <span style={{ color: 'var(--orange)' }}>Not installed</span>}
              </dd>
            </dl>
            <div className="btn-row">
              {!!settings.nexusWebAuthed && <button className="btn btn-primary btn-sm" onClick={installPatchNexus} disabled={patchBusy}><Icon name="download" size={13} /> {patchBusy ? 'Installing…' : 'Install from Nexus'}</button>}
              <button className="btn btn-ghost btn-sm" onClick={installPatch}><Icon name="folder" size={13} /> Install archive…</button>
              <ExtLink href={UTOC_URL} className="btn btn-ghost btn-sm"><Icon name="external" size={13} /> Patch page</ExtLink>
            </div>
          </div>
        </div>

        <div className="panel settings-block">
          <div className="panel-head">Updates</div>
          <div className="panel-body">
            <dl className="kv">
              <dt>Installed</dt><dd>{updater.version || '…'}</dd>
              {!!updater.info && !!updater.info.latest && (
                <>
                  <dt>Latest release</dt>
                  <dd>{updater.info.latest}{updater.info.updateAvailable ? '' : ' (up to date)'}</dd>
                </>
              )}
            </dl>
            {updater.info && updater.info.updateAvailable && (
              <div className="path-status info">
                <Icon name="download" size={16} />
                <div style={{ flex: 1 }}>Version <b>{updater.info.latest}</b> is available.</div>
              </div>
            )}
            <div className="btn-row">
              <button className="btn btn-ghost btn-sm" onClick={checkUpdates} disabled={updater.checking}>
                <Icon name="refresh" size={13} /> {updater.checking ? 'Checking…' : 'Check for updates'}
              </button>
              {updater.info && updater.info.updateAvailable && (
                <button className="btn btn-primary btn-sm" onClick={() => updater.setOpen(true)}>
                  <Icon name="download" size={13} /> View update
                </button>
              )}
              <ExtLink href={REPO_URL} className="btn btn-ghost btn-sm"><Icon name="external" size={13} /> Source on GitHub</ExtLink>
            </div>
            <div className="hint">Checked automatically each time the app starts.</div>
          </div>
        </div>

        <div className="panel settings-block" style={{ gridColumn: '1 / -1' }}>
          <div className="panel-head">Advanced</div>
          <div className="panel-body">
            <div className="field">
              <label>Marvel Rivals AES key</label>
              <div className="btn-row">
                <input className="input" style={{ flex: 1, minWidth: 320 }} value={aesKey} onChange={e => setAesKey(e.target.value)} spellCheck={false} />
                <button className="btn btn-ghost btn-sm" onClick={async () => { await patch({ aesKey: aesKey.trim() }); toast.ok('AES key saved') }}>Save</button>
              </div>
              <div className="hint">Used to read encrypted pak indexes.</div>
            </div>
            <div className="btn-row">
              <button className="btn btn-ghost btn-sm" onClick={clearCache} disabled={clearing}><Icon name="trash" size={13} /> {clearing ? 'Clearing…' : 'Clear preview & audio caches'}</button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
