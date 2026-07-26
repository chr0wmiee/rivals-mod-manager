import { useEffect, useState } from 'react'
import api from '../api.js'
import Icon from '../components/Icon.jsx'
import { useToast, ExtLink } from '../components/ui.jsx'

const UTOC_URL = 'https://www.nexusmods.com/marvelrivals/mods/2940'
const STEPS = ['Welcome', 'Game', 'Backups', 'Nexus', 'Patch', 'Done']

export default function SetupWizard ({ settings, onDone }) {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [detecting, setDetecting] = useState(false)
  const [detectTried, setDetectTried] = useState(false)
  const [diag, setDiag] = useState(null)
  const [backupDir, setBackupDir] = useState(settings.backupDir || settings.defaultBackupDir)
  const [nexusSignedIn, setNexusSignedIn] = useState(!!settings.nexusWebAuthed)
  const [signingIn, setSigningIn] = useState(false)
  const [patchDone, setPatchDone] = useState(!!settings.utocPatchInstalled)
  const [patchBusy, setPatchBusy] = useState(false)

  useEffect(() => {
    if (step === 1 && !detectTried) { setDetectTried(true); autoDetect() }
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  const autoDetect = async () => {
    setDetecting(true)
    try {
      const found = await api.detectGame()
      setDiag(found ? { ok: true, ...found, auto: true } : { ok: false, reason: 'Not found automatically. Browse to any folder inside the install and the path is corrected for you.' })
    } catch (e) { setDiag({ ok: false, reason: e.message }) } finally { setDetecting(false) }
  }

  const browseGame = async () => {
    const dir = await api.chooseDirectory('Select your Marvel Rivals folder (any folder inside the install works)')
    if (!dir) return
    const result = await api.validateGamePath(dir)
    setDiag(result)
    if (result.ok && result.corrected) toast.ok('Fixed your selection', result.gameRoot)
  }

  const browseBackup = async () => {
    const dir = await api.chooseDirectory('Choose where mod backups should live', backupDir)
    if (dir) setBackupDir(dir)
  }

  const nexusSignIn = async () => {
    setSigningIn(true)
    try {
      const result = await api.nexusWebLogin()
      if (result.loggedIn) {
        setNexusSignedIn(true)
        toast.ok('Signed in to Nexus')
      } else if (result.cancelled) toast.warn('Sign-in cancelled')
      else if (result.alreadyOpen) toast.info('Sign-in window is already open')
      else toast.warn('Not signed in', 'Could not confirm the Nexus session.')
    } catch (e) { toast.err('Sign-in failed', e.message) } finally { setSigningIn(false) }
  }

  const installPatchFile = async () => {
    const files = await api.chooseFiles('Select the downloaded UTOC Signature Patch archive', [{ name: 'Archives', extensions: ['zip', '7z', 'rar'] }])
    if (!files?.length) return
    setPatchBusy(true)
    try {
      const result = await api.installUtocPatch(files[0])
      setPatchDone(true)
      toast.ok('Patch installed', `${result.copied} file(s) copied`)
    } catch (e) { toast.err('Install failed', e.message) } finally { setPatchBusy(false) }
  }

  const installPatchNexus = async () => {
    setPatchBusy(true)
    try {
      const result = await api.installUtocPatchFromNexus()
      if (result.ok === false) {
        toast.warn('Install unavailable', result.needsLogin ? 'Sign in to Nexus first.' : result.error)
      } else {
        setPatchDone(true)
        toast.ok('Patch installed')
      }
    } catch (e) { toast.err('Install failed', e.message) } finally { setPatchBusy(false) }
  }

  const persistStep = async next => {
    if (step === 1 && diag?.ok) await api.patchSettings({ gameRoot: diag.gameRoot })
    if (step === 2) await api.patchSettings({ backupDir })
    setStep(next)
  }

  const finish = async () => { await api.patchSettings({ setupComplete: true }); onDone() }
  const canNext = step !== 1 || !!diag?.ok

  return (
    <div className="wizard">
      <div className="wiz-body"><div className="wiz-panel">
        {step === 0 && <>
          <div className="wiz-kicker">First-time setup</div>
          <div className="wiz-title">Marvel Rivals <em>Mod Manager</em></div>
          <div className="wiz-desc">Install and organize Marvel Rivals mods with safe backups, Nexus browsing, presets, asset previews and a built-in audio studio.</div>
          <div className="wiz-card"><div style={{ display: 'flex', gap: 12, alignItems: 'center' }}><Icon name="gamepad" size={22} style={{ color: 'var(--gold)', flex: 'none' }} /><span>Four quick steps: locate the game, pick a backup folder, connect Nexus (optional), install the mod loader patch.</span></div></div>
        </>}

        {step === 1 && <>
          <div className="wiz-kicker">Step 1 · Required</div>
          <div className="wiz-title">Where is <em>Marvel Rivals</em>?</div>
          <div className="wiz-desc">Any folder inside the install works.</div>
          <div className="wiz-card">
            {detecting && <div className="path-status info"><div className="spinner inline" /> Searching Steam and Epic installs…</div>}
            {!detecting && diag?.ok && <div className="path-status ok"><Icon name="check" /><div><b>{diag.auto ? 'Game found.' : diag.corrected ? 'Selection corrected.' : 'Path verified.'}</b><br /><code>{diag.gameRoot}</code></div></div>}
            {!detecting && diag && !diag.ok && <div className="path-status bad"><Icon name="alert" /><div><b>Not found.</b><br />{diag.reason}</div></div>}
            <div className="btn-row">
              <button className="btn btn-ghost" onClick={autoDetect} disabled={detecting}><Icon name="refresh" size={14} /> Detect again</button>
              <button className="btn btn-primary" onClick={browseGame}><Icon name="folder" size={14} /> Browse…</button>
            </div>
          </div>
        </>}

        {step === 2 && <>
          <div className="wiz-kicker">Step 2 · Required</div>
          <div className="wiz-title">Choose a <em>backup vault</em></div>
          <div className="wiz-desc">Mods live here permanently and are restored automatically after game updates.</div>
          <div className="wiz-card">
            <div className="field">
              <label>Backup folder</label>
              <div className="btn-row">
                <input className="input" style={{ flex: 1 }} value={backupDir} onChange={e => setBackupDir(e.target.value)} />
                <button className="btn btn-ghost" onClick={browseBackup}><Icon name="folder" size={14} /> Browse</button>
              </div>
            </div>
          </div>
        </>}

        {step === 3 && <>
          <div className="wiz-kicker">Step 3 · Optional</div>
          <div className="wiz-title">Connect <em>Nexus Mods</em></div>
          <div className="wiz-desc">Sign in once to download files in-app. Free accounts work. No API key needed.</div>
          <div className="wiz-card">
            {nexusSignedIn
              ? <div className="path-status ok"><Icon name="check" /><div><b>Signed in.</b> Downloads and previews are enabled.</div></div>
              : <button className="btn btn-primary" onClick={nexusSignIn} disabled={signingIn}><Icon name="download" size={14} /> {signingIn ? 'Waiting…' : 'Sign in to Nexus'}</button>}
          </div>
        </>}

        {step === 4 && <>
          <div className="wiz-kicker">Step 4 · Recommended</div>
          <div className="wiz-title">Install the <em>loader patch</em></div>
          <div className="wiz-desc">Most mods need the UTOC Signature Patch. It installs next to the game exe and needs re-applying after game updates.</div>
          <div className="wiz-card">
            {patchDone
              ? <div className="path-status ok"><Icon name="check" /><div><b>Patch installed.</b></div></div>
              : <div className="btn-row">
                {nexusSignedIn && <button className="btn btn-primary" onClick={installPatchNexus} disabled={patchBusy}><Icon name="download" size={14} /> {patchBusy ? 'Installing…' : 'Install from Nexus'}</button>}
                <button className="btn btn-ghost" onClick={installPatchFile} disabled={patchBusy}><Icon name="folder" size={14} /> Install archive…</button>
                <ExtLink href={UTOC_URL} className="btn btn-ghost"><Icon name="external" size={14} /> Patch page</ExtLink>
              </div>}
          </div>
        </>}

        {step === 5 && <>
          <div className="wiz-kicker">All set</div>
          <div className="wiz-title">Assemble your <em>roster</em></div>
          <div className="wiz-desc">Anything already in ~mods gets adopted into your library automatically. Drag & drop archives anywhere to install.</div>
        </>}
      </div></div>

      <div className="wiz-foot">
        <div className="wiz-steps">{STEPS.map((name, i) => <div key={name} className={`wiz-step ${i < step ? 'done' : ''} ${i === step ? 'now' : ''}`} title={name} />)}</div>
        <span className="wiz-step-label">{STEPS[step]} · {step + 1}/{STEPS.length}</span><div className="spacer" />
        {step > 0 && <button className="btn btn-ghost" onClick={() => setStep(step - 1)}><Icon name="chevL" size={14} /> Back</button>}
        {(step === 3 || step === 4) && <button className="btn btn-ghost" onClick={() => persistStep(step + 1)}>Skip</button>}
        {step < STEPS.length - 1
          ? <button className="btn btn-primary" disabled={!canNext} onClick={() => persistStep(step + 1)}>Next <Icon name="chevR" size={14} /></button>
          : <button className="btn btn-primary btn-lg" onClick={finish}><Icon name="play" size={15} /> Enter</button>}
      </div>
    </div>
  )
}
