import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

function App() {
  const [appConfig, setAppConfig] = useState({ api_base_url: '' })
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
  const [cloneForm, setCloneForm] = useState(defaultCloneForm())
  const [cloneFile, setCloneFile] = useState(null)
  const [transcriptionForm, setTranscriptionForm] = useState(defaultTranscriptionForm())
  const [transcriptionFile, setTranscriptionFile] = useState(null)

  const api_base_url = normalize_api_base_url(appConfig.api_base_url)
  const selectedProvider = providers.find(provider => provider.id === selectedProviderId) ?? providers[0]
  const voiceTree = useMemo(() => buildVoiceTree(voiceOptions), [voiceOptions])

  useEffect(() => {
    loadConfig().then(setAppConfig).catch(() => setAppConfig({ api_base_url: '' }))
  }, [])

  useEffect(() => {
    loadProviders().catch(error => {
      setProviders([])
      setTestResult({ kind: 'error', message: error.message })
    })
  }, [api_base_url])

  useEffect(() => {
    if (!selectedProvider) return
    setTestMode(getDefaultTestMode(selectedProvider))
    setSpeechForm(defaultSpeechForm(selectedProvider))
    setEffectForm(defaultEffectForm())
    setIsolationForm(defaultIsolationForm())
    setIsolationFile(null)
    setDesignForm(defaultDesignForm())
    setCloneForm(defaultCloneForm())
    setCloneFile(null)
    setTranscriptionForm(defaultTranscriptionForm(selectedProvider))
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
        const default_voice = getDefaultVoiceValue(options)
        setSpeechForm(current => current.voice || !default_voice ? current : { ...current, voice: default_voice })
      })
      .catch(() => {
        if (!cancelled) setVoiceOptions([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedProvider?.id, api_base_url])

  async function loadProviders() {
    const response = await fetch(apiUrl('/api/providers', api_base_url))
    const payload = await response.json()
    if (!response.ok) throw new Error(formatErrorPayload(payload) || 'Failed to load providers')
    const nextProviders = payload.providers || []
    setProviders(nextProviders)
    setSelectedProviderId(current => {
      if (current && nextProviders.some(provider => provider.id === current)) return current
      return nextProviders[0]?.id ?? ''
    })
  }

  async function loadProviderVoices(providerId) {
    const response = await fetch(apiUrl(`/api/providers/${encodeURIComponent(providerId)}/voices`, api_base_url))
    const payload = await response.json()
    if (!response.ok) throw new Error(formatErrorPayload(payload) || 'Failed to load voices')
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

    const response = await fetch(apiUrl(`/api/providers/${encodeURIComponent(selectedProvider.id)}/config`, api_base_url), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: Boolean(formValues.enabled), config, secrets }),
    })
    const payload = await response.json()
    if (!response.ok) {
      setSaveStatus(formatErrorPayload(payload) || 'Save failed')
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
      } else if (testMode === 'clone') {
        await runCloneTest()
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
    const response = await fetch(apiUrl('/v1/audio/speech', api_base_url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: selectedProvider.id,
        model: speechForm.model || undefined,
        input: speechForm.input,
        voice: speechForm.voice || undefined,
        response_format: speechForm.response_format,
        stream_format: speechForm.stream_format || undefined,
        speed: Number(speechForm.speed) || undefined,
        instructions: speechForm.instructions || undefined,
        extra_params: parseJsonObject(speechForm.extra_params, 'Extra params'),
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    if (speechForm.stream_format === 'sse') {
      const text = await response.text()
      setTestResult({
        kind: 'json',
        content: text,
        mime_type: response.headers.get('content-type') || 'text/event-stream',
        endpoint: 'POST /v1/audio/speech',
      })
      return
    }
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'audio',
      objectUrl,
      mime_type: response.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'POST /v1/audio/speech',
    })
  }

  async function runTranscriptionTest() {
    const form = new FormData()
    form.set('provider', selectedProvider.id)
    form.set('response_format', transcriptionForm.response_format)
    if (transcriptionForm.model.trim()) form.set('model', transcriptionForm.model.trim())
    if (transcriptionForm.language.trim()) form.set('language', transcriptionForm.language.trim())
    if (transcriptionForm.prompt.trim()) form.set('prompt', transcriptionForm.prompt.trim())
    if (transcriptionForm.temperature.trim()) form.set('temperature', transcriptionForm.temperature.trim())
    if (transcriptionForm.stream) form.set('stream', 'true')
    appendExtraParams(form, transcriptionForm.extra_params)
    if (!transcriptionFile) throw new Error('Choose an audio file.')
    form.set('file', transcriptionFile)

    const response = await fetch(apiUrl('/v1/audio/transcriptions', api_base_url), {
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
      mime_type: contentType,
      endpoint: 'POST /v1/audio/transcriptions',
    })
  }

  async function runEffectTest() {
    const response = await fetch(apiUrl('/v1/audio/effect', api_base_url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: selectedProvider.id,
        input: effectForm.input,
        response_format: effectForm.response_format,
        duration_seconds: Number(effectForm.duration_seconds) || undefined,
        prompt_influence: Number(effectForm.prompt_influence) || undefined,
        loop: effectForm.loop,
        extra_params: parseJsonObject(effectForm.extra_params, 'Extra params'),
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'audio',
      objectUrl,
      mime_type: response.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'POST /v1/audio/effect',
    })
  }

  async function runIsolationTest() {
    const form = new FormData()
    form.set('provider', selectedProvider.id)
    form.set('file_format', isolationForm.file_format)
    appendExtraParams(form, isolationForm.extra_params)
    if (!isolationFile) throw new Error('Choose an audio file.')
    form.set('file', isolationFile)

    const response = await fetch(apiUrl('/v1/audio/isolation', api_base_url), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error(await readError(response))
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'audio',
      objectUrl,
      mime_type: response.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'POST /v1/audio/isolation',
    })
  }

  async function runDesignTest() {
    const typed_extra_params = compactPayload({
      auto_generate_text: designForm.auto_generate_text,
      guidance_scale: optionalNumber(designForm.guidance_scale),
      seed: optionalNumber(designForm.seed),
    })
    const extra_params = {
      ...parseJsonObject(designForm.extra_params, 'Extra params'),
      ...typed_extra_params,
    }
    const response = await fetch(apiUrl('/v1/audio/design', api_base_url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: selectedProvider.id,
        input: designForm.input,
        name: designForm.name || undefined,
        text: designForm.text || undefined,
        response_format: designForm.response_format,
        model: designForm.model || undefined,
        extra_params: Object.keys(extra_params).length ? extra_params : undefined,
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const payload = await response.json()
    setTestResult({
      kind: 'json',
      content: JSON.stringify(payload, null, 2),
      mime_type: 'application/json',
      endpoint: 'POST /v1/audio/design',
    })
    if (selectedProvider?.capabilities?.tts) {
      loadProviderVoices(selectedProvider.id)
        .then(options => setVoiceOptions(options))
        .catch(() => {})
    }
  }

  async function runCloneTest() {
    const form = new FormData()
    form.set('provider', selectedProvider.id)
    form.set('name', cloneForm.name)
    if (cloneForm.consent.trim()) form.set('consent', cloneForm.consent.trim())
    appendExtraParams(form, cloneForm.extra_params)
    if (cloneFile) {
      form.set('audio_sample', cloneFile)
    } else {
      throw new Error('Choose an audio file.')
    }

    const response = await fetch(apiUrl('/v1/audio/voices', api_base_url), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error(await readError(response))
    const payload = await response.json()
    setTestResult({
      kind: 'json',
      content: JSON.stringify(payload, null, 2),
      mime_type: 'application/json',
      endpoint: 'POST /v1/audio/voices',
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
                    {['tts', 'asr', 'effect', 'isolation', 'design', 'clone'].map(mode => (
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
                    ) : testMode === 'clone' ? (
                      <CloneTestForm
                        file={cloneFile}
                        form={cloneForm}
                        onFileChange={setCloneFile}
                        onFormChange={setCloneForm}
                      />
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
                        modelField={getProviderField(selectedProvider, 'asr_model')}
                        onFileChange={setTranscriptionFile}
                        onFormChange={setTranscriptionForm}
                        supportsStreaming={Boolean(selectedProvider.capabilities?.asr_streaming)}
                      />
                    ) : (
                      <SpeechTestForm
                        form={speechForm}
                        modelField={getProviderField(selectedProvider, 'tts_model')}
                        onFormChange={setSpeechForm}
                        supportsStreaming={Boolean(selectedProvider.capabilities?.tts_streaming)}
                        voiceOptions={voiceOptions}
                        voiceTree={voiceTree}
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
  const listId = field.options?.length ? `${inputId}-options` : undefined
  return (
    <label className="grid gap-1.5 text-sm font-semibold" htmlFor={inputId}>
      {field.label}
      <input
        className="input"
        id={inputId}
        list={listId}
        placeholder={field.placeholder || ''}
        type={field.type === 'password' ? 'password' : field.type === 'boolean' ? 'checkbox' : field.type}
        checked={field.type === 'boolean' ? Boolean(value) : undefined}
        value={field.type === 'boolean' ? undefined : value}
        onChange={event => onChange(field.type === 'boolean' ? event.target.checked : event.target.value)}
      />
      {listId ? (
        <datalist id={listId}>
          {field.options.map(option => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
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

function SpeechTestForm({
  form,
  modelField,
  onFormChange,
  supportsStreaming,
  voiceOptions,
  voiceTree,
}) {
  const modelListId = modelField?.options?.length ? 'speech-model-options' : undefined
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
      {modelField ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Model
          <input
            className="input"
            list={modelListId}
            placeholder={modelField.placeholder || 'provider default'}
            value={form.model}
            onChange={event => onFormChange({ ...form, model: event.target.value })}
          />
          {modelListId ? (
            <datalist id={modelListId}>
              {modelField.options.map(option => (
                <option key={option} value={option} />
              ))}
            </datalist>
          ) : null}
        </label>
      ) : null}
      <label className="grid gap-1.5 text-sm font-semibold">
        Voice
        {voiceOptions.length ? (
          <VoiceCascader
            value={form.voice || getDefaultVoiceValue(voiceOptions)}
            voiceOptions={voiceOptions}
            voiceTree={voiceTree}
            onChange={voice => onFormChange({ ...form, voice })}
          />
        ) : (
          <input
            className="input"
            placeholder="optional"
            value={form.voice}
            onChange={event => onFormChange({ ...form, voice: event.target.value })}
          />
        )}
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.response_format}
          onChange={event => onFormChange({ ...form, response_format: event.target.value })}
        >
          <option value="mp3">mp3</option>
          <option value="opus">opus</option>
          <option value="aac">aac</option>
          <option value="flac">flac</option>
          <option value="wav">wav</option>
          <option value="pcm">pcm</option>
        </select>
      </label>
      {supportsStreaming ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Stream format
          <select
            className="input"
            value={form.stream_format}
            onChange={event => onFormChange({ ...form, stream_format: event.target.value })}
          >
            <option value="">off</option>
            <option value="audio">audio</option>
            <option value="sse">sse</option>
          </select>
        </label>
      ) : null}
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
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        Instructions
        <textarea
          className="textarea min-h-20"
          value={form.instructions}
          onChange={event => onFormChange({ ...form, instructions: event.target.value })}
        />
      </label>
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function VoiceCascader({ onChange, value, voiceOptions, voiceTree }) {
  const selectedVoice = voiceOptions.find(option => option.value === value) ?? voiceOptions[0]
  const [open, setOpen] = useState(false)
  const [activeLocale, setActiveLocale] = useState('')
  const [activeGender, setActiveGender] = useState('')

  useEffect(() => {
    if (!open) return
    const locale = voiceTree.find(item => item.locale === selectedVoice?.locale)?.locale ?? voiceTree[0]?.locale ?? ''
    const localeGroup = voiceTree.find(item => item.locale === locale)
    const gender = localeGroup?.genders.find(item => item.gender === selectedVoice?.gender)?.gender ?? localeGroup?.genders[0]?.gender ?? ''
    setActiveLocale(locale)
    setActiveGender(gender)
  }, [open, selectedVoice?.value, voiceTree])

  const localeGroup = voiceTree.find(item => item.locale === activeLocale) ?? voiceTree[0]
  const genderGroup = localeGroup?.genders.find(item => item.gender === activeGender) ?? localeGroup?.genders[0]
  const showGenderColumn = Boolean(localeGroup?.genders.some(group => group.gender))

  return (
    <div
      className="voice-cascader"
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
    >
      <button
        className="input voice-cascader-trigger"
        type="button"
        onClick={() => setOpen(current => !current)}
      >
        <span className="voice-cascader-selected">
          <span className="voice-cascader-name">{selectedVoice?.name ?? 'Select voice'}</span>
          {selectedVoice?.locale ? <span className="voice-cascader-meta">· {selectedVoice.locale}</span> : null}
          {selectedVoice?.gender ? <span className="voice-cascader-meta">· {selectedVoice.gender}</span> : null}
        </span>
        <span className="text-slate-400">▾</span>
      </button>

      {open ? (
        <div className={`voice-cascader-panel ${showGenderColumn ? '' : 'voice-cascader-panel-no-gender'}`}>
          <div className="voice-cascader-column">
            {voiceTree.map(group => (
              <button
                className={`voice-cascader-option ${group.locale === localeGroup?.locale ? 'voice-cascader-option-active' : ''}`}
                key={group.locale}
                type="button"
                onClick={() => {
                  setActiveLocale(group.locale)
                  setActiveGender(group.genders[0]?.gender ?? '')
                }}
              >
                {group.label}
              </button>
            ))}
          </div>
          {showGenderColumn ? (
            <div className="voice-cascader-column">
              {(localeGroup?.genders ?? []).map(group => (
                <button
                  className={`voice-cascader-option ${group.gender === genderGroup?.gender ? 'voice-cascader-option-active' : ''}`}
                  key={group.gender}
                  type="button"
                  onClick={() => setActiveGender(group.gender)}
                >
                  {group.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="voice-cascader-column voice-cascader-voices">
            {(genderGroup?.options ?? []).map(option => (
              <button
                className={`voice-cascader-option ${option.value === selectedVoice?.value ? 'voice-cascader-option-active' : ''}`}
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                <span className="truncate">{option.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function IsolationTestForm({ file, form, onFileChange, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <AudioFileControl
        file={file}
        inputId="isolation-audio-source"
        onFileChange={onFileChange}
      />
      <label className="grid gap-1.5 text-sm font-semibold">
        File format
        <select
          className="input"
          value={form.file_format}
          onChange={event => onFormChange({ ...form, file_format: event.target.value })}
        >
          <option value="other">other</option>
          <option value="pcm_s16le_16">pcm_s16le_16</option>
        </select>
      </label>
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function TranscriptionTestForm({ file, form, modelField, onFileChange, onFormChange, supportsStreaming }) {
  const modelListId = modelField?.options?.length ? 'transcription-model-options' : undefined
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <AudioFileControl
        file={file}
        inputId="transcription-audio-source"
        onFileChange={onFileChange}
      />
      {modelField ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          Model
          <input
            className="input"
            list={modelListId}
            placeholder={modelField.placeholder || 'provider default'}
            value={form.model}
            onChange={event => onFormChange({ ...form, model: event.target.value })}
          />
          {modelListId ? (
            <datalist id={modelListId}>
              {modelField.options.map(option => (
                <option key={option} value={option} />
              ))}
            </datalist>
          ) : null}
        </label>
      ) : null}
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
        Prompt
        <input
          className="input"
          value={form.prompt}
          onChange={event => onFormChange({ ...form, prompt: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Temperature
        <input
          className="input"
          min="0"
          max="1"
          step="0.1"
          type="number"
          value={form.temperature}
          onChange={event => onFormChange({ ...form, temperature: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.response_format}
          onChange={event => onFormChange({ ...form, response_format: event.target.value })}
        >
          <option value="json">json</option>
          <option value="text">text</option>
          <option value="verbose_json">verbose_json</option>
          <option value="srt">srt</option>
          <option value="vtt">vtt</option>
          <option value="diarized_json">diarized_json</option>
        </select>
      </label>
      {supportsStreaming ? (
        <label className="inline-flex items-center gap-2 self-end text-sm font-semibold">
          <input
            type="checkbox"
            checked={form.stream}
            onChange={event => onFormChange({ ...form, stream: event.target.checked })}
          />
          Stream
        </label>
      ) : null}
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function AudioFileControl({ file, inputId, onFileChange }) {
  const fileId = `${inputId}-file`
  return (
    <div className="grid gap-1.5 text-sm font-semibold md:col-span-2">
      <label htmlFor={fileId}>Audio file</label>
      <div className="audio-source-actions">
        <span className="truncate text-sm font-normal text-slate-500">
          {file ? file.name : 'Choose an audio file'}
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
            onFileChange(event.target.files?.[0] ?? null)
          }}
        />
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
          value={form.duration_seconds}
          onChange={event => onFormChange({ ...form, duration_seconds: event.target.value })}
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
          value={form.prompt_influence}
          onChange={event => onFormChange({ ...form, prompt_influence: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Response format
        <select
          className="input"
          value={form.response_format}
          onChange={event => onFormChange({ ...form, response_format: event.target.value })}
        >
          <option value="mp3">mp3</option>
          <option value="wav">wav</option>
          <option value="pcm">pcm</option>
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
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
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
          value={form.input}
          onChange={event => onFormChange({ ...form, input: event.target.value })}
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
          value={form.response_format}
          onChange={event => onFormChange({ ...form, response_format: event.target.value })}
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
          value={form.guidance_scale}
          onChange={event => onFormChange({ ...form, guidance_scale: event.target.value })}
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
          checked={form.auto_generate_text}
          onChange={event => onFormChange({ ...form, auto_generate_text: event.target.checked })}
        />
        Auto text
      </label>
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function CloneTestForm({ file, form, onFileChange, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        <label htmlFor="clone-audio-sample">Audio sample</label>
        <div className="audio-source-actions">
          <span className="truncate text-sm font-normal text-slate-500">
            {file ? file.name : 'Choose an audio sample'}
          </span>
          <label className="btn-secondary shrink-0 cursor-pointer" htmlFor="clone-audio-sample">
            Choose file
          </label>
          <input
            className="sr-only"
            id="clone-audio-sample"
            type="file"
            accept="audio/*,video/mp4,video/webm"
            onChange={event => onFileChange(event.target.files?.[0] || null)}
          />
        </div>
      </div>
      <label className="grid gap-1.5 text-sm font-semibold">
        Name
        <input
          className="input"
          value={form.name}
          onChange={event => onFormChange({ ...form, name: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        Consent
        <input
          className="input"
          value={form.consent}
          onChange={event => onFormChange({ ...form, consent: event.target.value })}
        />
      </label>
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function ExtraParamsField({ onChange, value }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
      Extra params
      <textarea
        className="textarea min-h-20 font-mono"
        placeholder="{}"
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </label>
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
        <div className="text-sm text-slate-500">{result.endpoint} · {result.mime_type} · {formatBytes(result.size)}</div>
        <audio className="w-full" controls src={result.objectUrl} />
        <div>
          <a className="link" href={result.objectUrl} rel="noreferrer" target="_blank">Open audio preview</a>
        </div>
      </div>
    )
  }
  return (
    <div className="mt-4 grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="text-sm text-slate-500">{result.endpoint} · {result.mime_type}</div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-sm text-slate-100">{result.content}</pre>
    </div>
  )
}

async function loadConfig() {
  const response = await fetch('/voxout.config.json', { cache: 'no-store' })
  if (!response.ok) return { api_base_url: '' }
  const payload = await response.json()
  return {
    api_base_url: typeof payload.api_base_url === 'string' ? payload.api_base_url : '',
  }
}

async function readError(response) {
  const text = await response.text()
  try {
    return formatErrorPayload(JSON.parse(text)) || text
  } catch {
    return text || `Request failed: ${response.status}`
  }
}

function formatErrorPayload(payload) {
  const error = payload?.error
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error.message === 'string') return error.message
  return ''
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
  if (mode === 'effect') return Boolean(provider.capabilities?.sound_effects)
  if (mode === 'isolation') return Boolean(provider.capabilities?.isolation)
  if (mode === 'design') return Boolean(provider.capabilities?.voice_design)
  if (mode === 'clone') return Boolean(provider.capabilities?.voice_clone)
  return Boolean(provider.capabilities?.tts)
}

function getDefaultTestMode(provider) {
  if (provider?.capabilities?.tts) return 'tts'
  if (provider?.capabilities?.asr) return 'asr'
  if (provider?.capabilities?.sound_effects) return 'effect'
  if (provider?.capabilities?.isolation) return 'isolation'
  if (provider?.capabilities?.voice_design) return 'design'
  if (provider?.capabilities?.voice_clone) return 'clone'
  return 'tts'
}

function getTestModeLabel(mode) {
  if (mode === 'tts') return 'Speech'
  if (mode === 'asr') return 'Transcription'
  if (mode === 'effect') return 'Effect'
  if (mode === 'isolation') return 'Isolation'
  if (mode === 'clone') return 'Clone'
  return 'Design'
}

function defaultSpeechForm(provider) {
  return {
    input: '你好，voxout。',
    model: provider?.config?.tts_model ?? '',
    voice: '',
    response_format: provider?.id === 'mimo' ? 'wav' : 'mp3',
    stream_format: '',
    speed: '1',
    instructions: '',
    extra_params: '',
  }
}

function defaultEffectForm() {
  return {
    input: 'a short cinematic whoosh',
    duration_seconds: '1.5',
    prompt_influence: '0.3',
    response_format: 'mp3',
    loop: false,
    extra_params: '',
  }
}

function defaultIsolationForm() {
  return {
    file_format: 'other',
    extra_params: '',
  }
}

function defaultDesignForm() {
  return {
    input: 'A calm narrator voice with a clean tone and warm delivery.',
    name: '',
    text: '',
    model: '',
    response_format: 'mp3_44100_128',
    auto_generate_text: true,
    guidance_scale: '',
    seed: '',
    extra_params: '',
  }
}

function defaultCloneForm() {
  return {
    name: 'Cloned voice',
    consent: '',
    extra_params: '',
  }
}

function defaultTranscriptionForm(provider) {
  return {
    model: getProviderField(provider, 'asr_model') ? provider?.config?.asr_model ?? '' : '',
    language: 'auto',
    prompt: '',
    temperature: '',
    stream: false,
    response_format: 'json',
    extra_params: '',
  }
}

function apiUrl(path, api_base_url) {
  return `${api_base_url}${path}`
}

function normalize_api_base_url(value) {
  return String(value || '').replace(/\/+$/, '')
}

function optionalNumber(value) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const number = Number(text)
  return Number.isFinite(number) ? number : undefined
}

function compactPayload(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''),
  )
}

function parseJsonObject(value, fieldName) {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${fieldName} must be valid JSON.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fieldName} must be a JSON object.`)
  }
  return parsed
}

function appendExtraParams(form, value) {
  const extra_params = parseJsonObject(value, 'Extra params')
  if (extra_params) form.set('extra_params', JSON.stringify(extra_params))
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

function formatVoiceOption(voice) {
  return {
    value: voice.id,
    name: voice.name || voice.id,
    locale: voice.locale || voice.language || '',
    gender: voice.gender || '',
    label: [
      voice.name || voice.id,
      voice.locale || voice.language,
      voice.gender,
    ].filter(Boolean).join(' · '),
  }
}

function buildVoiceTree(options) {
  const localeGroups = new Map()
  for (const option of options) {
    const locale = option.locale || ''
    const gender = option.gender || ''
    if (!localeGroups.has(locale)) {
      localeGroups.set(locale, {
        locale,
        label: option.locale || 'Unknown language',
        genderGroups: new Map(),
      })
    }
    const localeGroup = localeGroups.get(locale)
    if (!localeGroup.genderGroups.has(gender)) {
      localeGroup.genderGroups.set(gender, {
        gender,
        label: option.gender,
        options: [],
      })
    }
    localeGroup.genderGroups.get(gender).options.push(option)
  }
  return [...localeGroups.values()]
    .sort((left, right) => compareLocaleLabels(left.label, right.label))
    .map(group => ({
      locale: group.locale,
      label: group.label,
      genders: [...group.genderGroups.values()]
        .sort((left, right) => left.label.localeCompare(right.label))
        .map(genderGroup => ({
          ...genderGroup,
          options: genderGroup.options.sort((a, b) => a.name.localeCompare(b.name)),
        })),
    }))
}

function getDefaultVoiceValue(options) {
  return options.find(option => isChineseLocale(option.locale))?.value ?? options[0]?.value ?? ''
}

function compareLocaleLabels(left, right) {
  const leftChinese = isChineseLocale(left)
  const rightChinese = isChineseLocale(right)
  if (leftChinese !== rightChinese) return leftChinese ? -1 : 1
  return left.localeCompare(right)
}

function isChineseLocale(locale) {
  return /^zh(?:[-_]|$)/i.test(String(locale || '').trim())
}

function getProviderField(provider, key) {
  return (provider?.fields || []).find(field => field.key === key)
}

createRoot(document.querySelector('#root')).render(<App />)
