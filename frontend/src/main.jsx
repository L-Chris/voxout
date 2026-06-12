import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function App() {
  const [appConfig, setAppConfig] = useState({ apiBaseUrl: '' })
  const [providers, setProviders] = useState([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [saveStatus, setSaveStatus] = useState('')
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [testStatus, setTestStatus] = useState('')
  const [testMode, setTestMode] = useState('tts')
  const [testResult, setTestResult] = useState(null)
  const [formValues, setFormValues] = useState({})
  const [voiceOptions, setVoiceOptions] = useState([])
  const [speechForm, setSpeechForm] = useState(defaultSpeechForm())
  const [effectForm, setEffectForm] = useState(defaultEffectForm())
  const [isolationForm, setIsolationForm] = useState(defaultIsolationForm())
  const [isolationFile, setIsolationFile] = useState(null)
  const [designForm, setDesignForm] = useState(defaultDesignForm())
  const [transcriptionForm, setTranscriptionForm] = useState(defaultTranscriptionForm())
  const [transcriptionFile, setTranscriptionFile] = useState(null)

  const apiBaseUrl = normalizeApiBaseUrl(appConfig.apiBaseUrl)
  const selectedProvider = providers.find(provider => provider.id === selectedProviderId) ?? providers[0]

  useEffect(() => {
    loadConfig().then(setAppConfig).catch(() => setAppConfig({ apiBaseUrl: '' }))
  }, [])

  useEffect(() => {
    loadProviders().catch(error => {
      setProviders([])
      setTestResult({ kind: 'error', message: error.message })
    })
  }, [apiBaseUrl])

  useEffect(() => {
    if (!selectedProvider) return
    setTestMode(getDefaultTestMode(selectedProvider))
    setSpeechForm(defaultSpeechForm(selectedProvider))
    setEffectForm(defaultEffectForm())
    setIsolationForm(defaultIsolationForm())
    setIsolationFile(null)
    setDesignForm(defaultDesignForm())
    setTranscriptionForm(defaultTranscriptionForm())
    setTranscriptionFile(null)
    setIsConfigOpen(false)
    setSaveStatus('')
    setFormValues({})
    clearTestResult()
  }, [selectedProvider?.id])

  useEffect(() => {
    if (!selectedProvider?.capabilities?.tts) {
      setVoiceOptions([])
      return
    }
    let cancelled = false
    loadProviderVoices(selectedProvider.id)
      .then(options => {
        if (cancelled) return
        setVoiceOptions(options)
        setSpeechForm(current => current.voice || !options[0] ? current : { ...current, voice: options[0].value })
      })
      .catch(() => {
        if (!cancelled) setVoiceOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedProvider?.id, apiBaseUrl])

  async function loadProviders() {
    const response = await fetch(apiUrl('/api/providers', apiBaseUrl))
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || 'Failed to load providers')
    const nextProviders = payload.providers || []
    setProviders(nextProviders)
    setSelectedProviderId(current => {
      if (current && nextProviders.some(provider => provider.id === current)) return current
      return nextProviders[0]?.id ?? ''
    })
  }

  async function loadProviderVoices(providerId) {
    const response = await fetch(apiUrl(`/api/providers/${encodeURIComponent(providerId)}/voices`, apiBaseUrl))
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || 'Failed to load voices')
    return (payload.voices || []).map(formatVoiceOption)
  }

  function selectTestMode(mode) {
    if (!selectedProvider || !supportsTestMode(selectedProvider, mode)) return
    setTestMode(mode)
    clearTestResult()
  }

  function clearTestResult() {
    setTestStatus('')
    setTestResult(current => {
      if (current?.objectUrl) URL.revokeObjectURL(current.objectUrl)
      return null
    })
  }

  function openConfig() {
    if (!selectedProvider) return
    setFormValues(getProviderFormValues(selectedProvider))
    setSaveStatus('')
    setIsConfigOpen(true)
  }

  function closeConfig() {
    setIsConfigOpen(false)
    setSaveStatus('')
  }

  async function saveSelectedProvider(event) {
    event.preventDefault()
    if (!selectedProvider) return
    setSaveStatus('Saving...')

    const config = {}
    const secrets = {}
    for (const field of selectedProvider.fields || []) {
      const value = formValues[field.key]
      const target = field.secret ? secrets : config
      if (field.type === 'boolean') {
        target[field.key] = Boolean(value)
      } else if (String(value ?? '').trim()) {
        target[field.key] = field.type === 'number' ? Number(value) : String(value).trim()
      }
    }

    const response = await fetch(apiUrl(`/api/providers/${encodeURIComponent(selectedProvider.id)}/config`, apiBaseUrl), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(formValues.enabled), config, secrets }),
    })
    const payload = await response.json()
    if (!response.ok) {
      setSaveStatus(payload.error || 'Save failed')
      return
    }
    setSaveStatus('Saved')
    await loadProviders()
    setIsConfigOpen(false)
  }

  async function runTest(event) {
    event.preventDefault()
    if (!selectedProvider) return
    clearTestResult()
    setTestStatus('Running...')

    try {
      if (testMode === 'design') {
        await runDesignTest()
      } else if (testMode === 'isolation') {
        await runIsolationTest()
      } else if (testMode === 'effect') {
        await runEffectTest()
      } else if (testMode === 'asr') {
        await runTranscriptionTest()
      } else {
        await runSpeechTest()
      }
      setTestStatus('Done')
    } catch (error) {
      setTestStatus('Failed')
      setTestResult({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function runSpeechTest() {
    const response = await fetch(apiUrl('/v1/audio/speech', apiBaseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: selectedProvider.id,
        input: speechForm.input,
        voice: speechForm.voice || undefined,
        voice_id: speechForm.voiceId || undefined,
        response_format: speechForm.responseFormat,
        speed: Number(speechForm.speed) || undefined,
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'audio',
      objectUrl,
      mimeType: response.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'POST /v1/audio/speech',
    })
  }

  async function runTranscriptionTest() {
    const form = new FormData()
    form.set('model', selectedProvider.id)
    form.set('response_format', transcriptionForm.responseFormat)
    if (transcriptionForm.language.trim()) form.set('language', transcriptionForm.language.trim())
    if (transcriptionFile) {
      form.set('file', transcriptionFile)
    } else if (transcriptionForm.audioSource.trim()) {
      appendAudioSource(form, transcriptionForm.audioSource.trim())
    } else {
      throw new Error('Choose an audio file or enter an audio source.')
    }

    const response = await fetch(apiUrl('/v1/audio/transcriptions', apiBaseUrl), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error(await readError(response))
    const contentType = response.headers.get('content-type') || ''
    const body = contentType.includes('application/json')
      ? JSON.stringify(await response.json(), null, 2)
      : await response.text()
    setTestResult({
      kind: contentType.includes('application/json') ? 'json' : 'text',
      content: body,
      mimeType: contentType,
      endpoint: 'POST /v1/audio/transcriptions',
    })
  }

  async function runEffectTest() {
    const response = await fetch(apiUrl('/v1/audio/effect', apiBaseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: selectedProvider.id,
        input: effectForm.input,
        response_format: effectForm.responseFormat,
        duration_seconds: Number(effectForm.durationSeconds) || undefined,
        prompt_influence: Number(effectForm.promptInfluence) || undefined,
        loop: effectForm.loop,
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'audio',
      objectUrl,
      mimeType: response.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'POST /v1/audio/effect',
    })
  }

  async function runIsolationTest() {
    const form = new FormData()
    form.set('model', selectedProvider.id)
    form.set('file_format', isolationForm.fileFormat)
    if (isolationFile) {
      form.set('audio', isolationFile)
    } else if (isolationForm.audioSource.trim()) {
      appendAudioSource(form, isolationForm.audioSource.trim())
    } else {
      throw new Error('Choose an audio file or enter an audio source.')
    }

    const response = await fetch(apiUrl('/v1/audio/isolation', apiBaseUrl), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error(await readError(response))
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'audio',
      objectUrl,
      mimeType: response.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'POST /v1/audio/isolation',
    })
  }

  async function runDesignTest() {
    const response = await fetch(apiUrl('/v1/audio/design', apiBaseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: selectedProvider.id,
        input: designForm.voiceDescription,
        name: designForm.name || undefined,
        text: designForm.text || undefined,
        response_format: designForm.responseFormat,
        model_id: designForm.model || undefined,
        auto_generate_text: designForm.autoGenerateText,
        guidance_scale: Number(designForm.guidanceScale) || undefined,
        seed: designForm.seed ? Number(designForm.seed) : undefined,
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const payload = await response.json()
    setTestResult({
      kind: 'json',
      content: JSON.stringify(payload, null, 2),
      mimeType: 'application/json',
      endpoint: 'POST /v1/audio/design',
    })
    if (selectedProvider?.capabilities?.tts) {
      loadProviderVoices(selectedProvider.id)
        .then(options => setVoiceOptions(options))
        .catch(() => {})
    }
  }

  const capabilityText = useMemo(() => {
    if (!selectedProvider) return ''
    return Object.entries(selectedProvider.capabilities || {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key)
      .join(', ')
  }, [selectedProvider])

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto grid max-w-7xl gap-5 px-5 py-7 lg:px-8">
        <header>
          <div>
            <h1 className="text-3xl font-bold tracking-normal">voxout</h1>
            <p className="mt-1 text-slate-500">Provider configuration and audio testing</p>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <aside className="panel">
            <h2 className="mb-4 text-lg font-bold">Providers</h2>
            <div className="grid gap-2">
              {providers.map(provider => (
                <button
                  className={`provider-card ${provider.id === selectedProvider?.id ? 'provider-card-active' : ''}`}
                  key={provider.id}
                  type="button"
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <strong>{provider.name}</strong>
                    <span className="badge">{provider.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div className="text-slate-500">{provider.id}</div>
                </button>
              ))}
            </div>
          </aside>

          <section className="panel">
            {selectedProvider ? (
              <>
                <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold">{selectedProvider.name}</h2>
                    <div className="text-slate-500">{capabilityText}</div>
                  </div>
                  <button className="btn-secondary" type="button" onClick={openConfig}>Configure</button>
                </div>

                <div className="border-t border-slate-200 pt-5">
                  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h2 className="text-lg font-bold">Test API</h2>
                  </div>
                  <div className="mb-4 flex gap-2">
                    {['tts', 'asr', 'effect', 'isolation', 'design'].map(mode => (
                      <button
                        className={`tab ${testMode === mode ? 'tab-active' : ''}`}
                        disabled={!supportsTestMode(selectedProvider, mode)}
                        key={mode}
                        type="button"
                        onClick={() => selectTestMode(mode)}
                      >
                        {getTestModeLabel(mode)}
                      </button>
                    ))}
                  </div>

                  <form className="grid gap-4" onSubmit={runTest}>
                    {testMode === 'design' ? (
                      <DesignTestForm form={designForm} onFormChange={setDesignForm} />
                    ) : testMode === 'isolation' ? (
                      <IsolationTestForm
                        file={isolationFile}
                        form={isolationForm}
                        onFileChange={setIsolationFile}
                        onFormChange={setIsolationForm}
                      />
                    ) : testMode === 'effect' ? (
                      <EffectTestForm form={effectForm} onFormChange={setEffectForm} />
                    ) : testMode === 'asr' ? (
                      <TranscriptionTestForm
                        file={transcriptionFile}
                        form={transcriptionForm}
                        onFileChange={setTranscriptionFile}
                        onFormChange={setTranscriptionForm}
                      />
                    ) : (
                      <SpeechTestForm
                        form={speechForm}
                        onFormChange={setSpeechForm}
                        supportsVoiceId={supportsVoiceId(selectedProvider)}
                        voiceOptions={voiceOptions}
                      />
                    )}
                    <div className="flex items-center gap-3">
                      <button className="btn-primary" type="submit">Run test</button>
                      <span className="text-slate-500">{testStatus}</span>
                    </div>
                  </form>

                  <ResultPreview result={testResult} />
                </div>

                {isConfigOpen ? (
                  <ConfigDialog
                    formValues={formValues}
                    onClose={closeConfig}
                    onFieldChange={(key, value) => setFormValues({ ...formValues, [key]: value })}
                    onSubmit={saveSelectedProvider}
                    provider={selectedProvider}
                    saveStatus={saveStatus}
                  />
                ) : null}
              </>
            ) : (
              <div className="text-slate-500">No providers available.</div>
            )}
          </section>
        </section>
      </div>
    </main>
  )
}

function FieldInput({ field, value, onChange }) {
  const inputId = `field-${field.key}`
  return (
    <label className="grid gap-1.5 text-sm font-semibold" htmlFor={inputId}>
      {field.label}
      <input
        className="input"
        id={inputId}
        placeholder={field.placeholder || ''}
        type={field.type === 'password' ? 'password' : field.type === 'boolean' ? 'checkbox' : field.type}
        checked={field.type === 'boolean' ? Boolean(value) : undefined}
        value={field.type === 'boolean' ? undefined : value}
        onChange={event => onChange(field.type === 'boolean' ? event.target.checked : event.target.value)}
      />
      {field.description ? <small className="font-normal text-slate-500">{field.description}</small> : null}
    </label>
  )
}

function ConfigDialog({ formValues, onClose, onFieldChange, onSubmit, provider, saveStatus }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 px-4 py-6" onMouseDown={onClose}>
      <div className="modal-panel" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-xl font-bold">{provider.name}</h2>
            <div className="text-sm text-slate-500">{provider.id}</div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close configuration">×</button>
        </div>

        <form className="grid gap-4 px-5 py-4" onSubmit={onSubmit}>
          <label className="inline-flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={Boolean(formValues.enabled)}
              onChange={event => onFieldChange('enabled', event.target.checked)}
            />
            Enabled
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            {(provider.fields || []).map(field => (
              <FieldInput
                field={field}
                key={field.key}
                value={formValues[field.key] ?? ''}
                onChange={value => onFieldChange(field.key, value)}
              />
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-slate-500">{saveStatus}</span>
            <div className="flex gap-2">
              <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
              <button className="btn-primary" type="submit">Save</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}

function SpeechTestForm({ form, onFormChange, supportsVoiceId, voiceOptions }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        Input text
        <textarea
          className="textarea min-h-28"
          value={form.input}
          onChange={event => onFormChange({ ...form, input: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Voice
        {voiceOptions.length ? (
          <select
            className="input"
            value={form.voice || voiceOptions[0].value}
            onChange={event => onFormChange({ ...form, voice: event.target.value })}
          >
            {voiceOptions.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            placeholder="optional"
            value={form.voice}
            onChange={event => onFormChange({ ...form, voice: event.target.value })}
          />
        )}
      </label>
      {supportsVoiceId ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Voice ID
          <input
            className="input"
            placeholder="optional"
            value={form.voiceId}
            onChange={event => onFormChange({ ...form, voiceId: event.target.value })}
          />
        </label>
      ) : null}
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.responseFormat}
          onChange={event => onFormChange({ ...form, responseFormat: event.target.value })}
        >
          <option value="wav">wav</option>
          <option value="mp3">mp3</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Speed
        <input
          className="input"
          min="0.25"
          max="4"
          step="0.05"
          type="number"
          value={form.speed}
          onChange={event => onFormChange({ ...form, speed: event.target.value })}
        />
      </label>
    </div>
  )
}

function IsolationTestForm({ file, form, onFileChange, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <AudioSourceControl
        file={file}
        form={form}
        inputId="isolation-audio-source"
        onFileChange={onFileChange}
        onFormChange={onFormChange}
      />
      <label className="grid gap-1.5 text-sm font-semibold">
        File format
        <select
          className="input"
          value={form.fileFormat}
          onChange={event => onFormChange({ ...form, fileFormat: event.target.value })}
        >
          <option value="other">other</option>
          <option value="pcm_s16le_16">pcm_s16le_16</option>
        </select>
      </label>
    </div>
  )
}

function TranscriptionTestForm({ file, form, onFileChange, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <AudioSourceControl
        file={file}
        form={form}
        inputId="transcription-audio-source"
        onFileChange={onFileChange}
        onFormChange={onFormChange}
      />
      <label className="grid gap-1.5 text-sm font-semibold">
        Language
        <input
          className="input"
          placeholder="auto"
          value={form.language}
          onChange={event => onFormChange({ ...form, language: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.responseFormat}
          onChange={event => onFormChange({ ...form, responseFormat: event.target.value })}
        >
          <option value="json">json</option>
          <option value="text">text</option>
          <option value="verbose_json">verbose_json</option>
          <option value="srt">srt</option>
        </select>
      </label>
    </div>
  )
}

function AudioSourceControl({ file, form, inputId, onFileChange, onFormChange }) {
  const fileId = `${inputId}-file`
  return (
    <div className="grid gap-1.5 text-sm font-semibold md:col-span-2">
      <label htmlFor={inputId}>Audio source</label>
      <div className="audio-source-control">
        <textarea
          id={inputId}
          className="textarea min-h-24 font-mono text-xs"
          placeholder="https://example.com/audio.m4a, BV1..., data:audio/wav;base64,..."
          value={form.audioSource}
          onChange={event => {
            onFileChange(null)
            onFormChange({ ...form, audioSource: event.target.value })
          }}
        />
        <div className="audio-source-actions">
          <span className="truncate text-sm font-normal text-slate-500">
            {file ? file.name : 'Paste an audio source or choose a file'}
          </span>
          <label className="btn-secondary shrink-0 cursor-pointer" htmlFor={fileId}>
            Choose file
          </label>
          <input
            className="sr-only"
            id={fileId}
            type="file"
            accept="audio/*,video/mp4,video/webm"
            onChange={event => {
              const nextFile = event.target.files?.[0] ?? null
              onFileChange(nextFile)
              if (nextFile) onFormChange({ ...form, audioSource: '' })
            }}
          />
        </div>
      </div>
    </div>
  )
}

function EffectTestForm({ form, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        Prompt
        <textarea
          className="textarea min-h-28"
          value={form.input}
          onChange={event => onFormChange({ ...form, input: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Duration seconds
        <input
          className="input"
          min="0.5"
          max="30"
          step="0.1"
          type="number"
          value={form.durationSeconds}
          onChange={event => onFormChange({ ...form, durationSeconds: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Prompt influence
        <input
          className="input"
          min="0"
          max="1"
          step="0.05"
          type="number"
          value={form.promptInfluence}
          onChange={event => onFormChange({ ...form, promptInfluence: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.responseFormat}
          onChange={event => onFormChange({ ...form, responseFormat: event.target.value })}
        >
          <option value="mp3_44100_128">mp3_44100_128</option>
          <option value="mp3_44100_192">mp3_44100_192</option>
          <option value="pcm_44100">pcm_44100</option>
          <option value="ulaw_8000">ulaw_8000</option>
        </select>
      </label>
      <label className="inline-flex items-center gap-2 self-end text-sm font-semibold">
        <input
          type="checkbox"
          checked={form.loop}
          onChange={event => onFormChange({ ...form, loop: event.target.checked })}
        />
        Loop
      </label>
    </div>
  )
}

function DesignTestForm({ form, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        Voice description
        <textarea
          className="textarea min-h-28"
          value={form.voiceDescription}
          onChange={event => onFormChange({ ...form, voiceDescription: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Name
        <input
          className="input"
          value={form.name}
          onChange={event => onFormChange({ ...form, name: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Model
        <input
          className="input"
          placeholder="provider default"
          value={form.model}
          onChange={event => onFormChange({ ...form, model: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        Preview text
        <textarea
          className="textarea min-h-20"
          value={form.text}
          onChange={event => onFormChange({ ...form, text: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.responseFormat}
          onChange={event => onFormChange({ ...form, responseFormat: event.target.value })}
        >
          <option value="mp3_44100_128">mp3_44100_128</option>
          <option value="mp3_44100_192">mp3_44100_192</option>
          <option value="wav">wav</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Guidance scale
        <input
          className="input"
          min="0"
          max="100"
          step="0.5"
          type="number"
          value={form.guidanceScale}
          onChange={event => onFormChange({ ...form, guidanceScale: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Seed
        <input
          className="input"
          min="0"
          step="1"
          type="number"
          value={form.seed}
          onChange={event => onFormChange({ ...form, seed: event.target.value })}
        />
      </label>
      <label className="inline-flex items-center gap-2 self-end text-sm font-semibold">
        <input
          type="checkbox"
          checked={form.autoGenerateText}
          onChange={event => onFormChange({ ...form, autoGenerateText: event.target.checked })}
        />
        Auto text
      </label>
    </div>
  )
}

function ResultPreview({ result }) {
  if (!result) return null
  if (result.kind === 'error') {
    return <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{result.message}</div>
  }
  if (result.kind === 'audio') {
    return (
      <div className="mt-4 grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <div className="text-sm text-slate-500">{result.endpoint} · {result.mimeType} · {formatBytes(result.size)}</div>
        <audio className="w-full" controls src={result.objectUrl} />
        <div>
          <a className="link" href={result.objectUrl} rel="noreferrer" target="_blank">Open audio preview</a>
        </div>
      </div>
    )
  }
  return (
    <div className="mt-4 grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm text-slate-500">{result.endpoint} · {result.mimeType}</div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-sm text-slate-100">{result.content}</pre>
    </div>
  )
}

async function loadConfig() {
  const response = await fetch('/voxout.config.json', { cache: 'no-store' })
  if (!response.ok) return { apiBaseUrl: '' }
  return { apiBaseUrl: '', ...await response.json() }
}

async function readError(response) {
  const text = await response.text()
  try {
    return JSON.parse(text).error || text
  } catch {
    return text || `Request failed: ${response.status}`
  }
}

function getProviderFormValues(provider) {
  const values = { enabled: provider.enabled }
  for (const field of provider.fields || []) {
    values[field.key] = field.secret ? '' : provider.config?.[field.key] ?? ''
  }
  return values
}

function supportsTestMode(provider, mode) {
  if (!provider) return false
  if (mode === 'asr') return Boolean(provider.capabilities?.asr)
  if (mode === 'effect') return Boolean(provider.capabilities?.soundEffects)
  if (mode === 'isolation') return Boolean(provider.capabilities?.isolation)
  if (mode === 'design') return Boolean(provider.capabilities?.voiceDesign)
  return Boolean(provider.capabilities?.tts)
}

function getDefaultTestMode(provider) {
  if (provider?.capabilities?.tts) return 'tts'
  if (provider?.capabilities?.asr) return 'asr'
  if (provider?.capabilities?.soundEffects) return 'effect'
  if (provider?.capabilities?.isolation) return 'isolation'
  if (provider?.capabilities?.voiceDesign) return 'design'
  return 'tts'
}

function getTestModeLabel(mode) {
  if (mode === 'tts') return 'Speech'
  if (mode === 'asr') return 'Transcription'
  if (mode === 'effect') return 'Effect'
  if (mode === 'isolation') return 'Isolation'
  return 'Design'
}

function supportsVoiceId(provider) {
  return provider?.id === 'elevenlabs' || provider?.id === 'mimo'
}

function defaultSpeechForm(provider) {
  return {
    input: '你好，voxout。',
    voice: '',
    voiceId: '',
    responseFormat: provider?.id === 'mimo' ? 'wav' : 'mp3',
    speed: '1',
  }
}

function defaultEffectForm() {
  return {
    input: 'a short cinematic whoosh',
    durationSeconds: '1.5',
    promptInfluence: '0.3',
    responseFormat: 'mp3_44100_128',
    loop: false,
  }
}

function defaultIsolationForm() {
  return {
    audioSource: '',
    fileFormat: 'other',
  }
}

function defaultDesignForm() {
  return {
    voiceDescription: 'A calm narrator voice with a clean tone and warm delivery.',
    name: '',
    text: '',
    model: '',
    responseFormat: 'mp3_44100_128',
    autoGenerateText: true,
    guidanceScale: '',
    seed: '',
  }
}

function defaultTranscriptionForm() {
  return {
    audioSource: '',
    language: 'auto',
    responseFormat: 'json',
  }
}

function appendAudioSource(form, source) {
  if (/^https?:\/\//i.test(source)) {
    form.set('url', source)
  } else if (/^BV[\dA-Za-z]+$/.test(source)) {
    form.set('bvid', source)
  } else {
    form.set('audioData', source)
  }
}

function apiUrl(path, apiBaseUrl) {
  return `${apiBaseUrl}${path}`
}

function normalizeApiBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '')
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

function formatVoiceOption(voice) {
  return {
    value: voice.id,
    label: [
      voice.name || voice.id,
      voice.locale,
      voice.gender,
    ].filter(Boolean).join(' · '),
  }
}

createRoot(document.querySelector('#root')).render(<App />)
