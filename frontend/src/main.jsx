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
  const [apiKeys, setApiKeys] = useState([])
  const [apiKeyStatus, setApiKeyStatus] = useState('')
  const [apiKeyDialog, setApiKeyDialog] = useState(null)
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
  const [videoForm, setVideoForm] = useState(defaultVideoForm())
  const [videoImageFile, setVideoImageFile] = useState(null)
  const [videoAudioFile, setVideoAudioFile] = useState(null)

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
    setDesignForm(defaultDesignForm(selectedProvider))
    setCloneForm(defaultCloneForm())
    setCloneFile(null)
    setTranscriptionForm(defaultTranscriptionForm(selectedProvider))
    setTranscriptionFile(null)
    setVideoForm(defaultVideoForm(selectedProvider))
    setVideoImageFile(null)
    setVideoAudioFile(null)
    setIsConfigOpen(false)
    setSaveStatus('')
    setFormValues({})
    setApiKeys([])
    setApiKeyStatus('')
    setApiKeyDialog(null)
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

  async function loadProviderApiKeys(providerId) {
    const response = await fetch(apiUrl(`/api/providers/${encodeURIComponent(providerId)}/api-keys`, api_base_url))
    const payload = await response.json()
    if (!response.ok) throw new Error(formatErrorPayload(payload) || 'Failed to load API keys')
    return payload.api_keys || []
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
    setApiKeys([])
    setApiKeyStatus('Loading API keys...')
    setIsConfigOpen(true)
    loadProviderApiKeys(selectedProvider.id)
      .then(keys => {
        setApiKeys(keys)
        setApiKeyStatus('')
      })
      .catch(error => setApiKeyStatus(error instanceof Error ? error.message : String(error)))
  }

  function closeConfig() {
    setIsConfigOpen(false)
    setSaveStatus('')
    setApiKeyStatus('')
    setApiKeyDialog(null)
  }

  function openApiKeyCreate() {
    setApiKeyDialog({
      mode: 'create',
      values: { name: '', api_key: '', weight: '1', enabled: true },
      status: '',
    })
  }

  function openApiKeyEdit(apiKey) {
    setApiKeyDialog({
      mode: 'edit',
      apiKey,
      values: {
        name: apiKey.name || '',
        api_key: '',
        weight: String(apiKey.weight ?? 1),
        enabled: Boolean(apiKey.enabled),
      },
      status: '',
    })
  }

  function updateApiKeyDialogValue(key, value) {
    setApiKeyDialog(current => current ? ({
      ...current,
      values: { ...current.values, [key]: value },
      status: '',
    }) : current)
  }

  async function saveApiKey(event) {
    event.preventDefault()
    if (!selectedProvider || !apiKeyDialog) return
    setApiKeyDialog(current => current ? { ...current, status: 'Saving...' } : current)

    const values = apiKeyDialog.values
    const body = {
      name: values.name || undefined,
      weight: values.weight === '' ? 1 : Number(values.weight) || 0,
      enabled: Boolean(values.enabled),
    }
    if (values.api_key.trim()) body.api_key = values.api_key.trim()
    if (apiKeyDialog.mode === 'create' && !body.api_key) {
      setApiKeyDialog(current => current ? { ...current, status: 'api_key is required.' } : current)
      return
    }

    const path = apiKeyDialog.mode === 'edit'
      ? `/api/providers/${encodeURIComponent(selectedProvider.id)}/api-keys/${encodeURIComponent(apiKeyDialog.apiKey.id)}`
      : `/api/providers/${encodeURIComponent(selectedProvider.id)}/api-keys`
    const response = await fetch(apiUrl(path, api_base_url), {
      method: apiKeyDialog.mode === 'edit' ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json()
    if (!response.ok) {
      setApiKeyDialog(current => current ? { ...current, status: formatErrorPayload(payload) || 'Save failed' } : current)
      return
    }
    const keys = await loadProviderApiKeys(selectedProvider.id)
    setApiKeys(keys)
    await loadProviders()
    setApiKeyDialog(null)
    setApiKeyStatus('Saved')
  }

  async function deleteApiKey(apiKey) {
    if (!selectedProvider) return
    setApiKeyStatus('Deleting...')
    const response = await fetch(apiUrl(`/api/providers/${encodeURIComponent(selectedProvider.id)}/api-keys/${encodeURIComponent(apiKey.id)}`, api_base_url), {
      method: 'DELETE',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      setApiKeyStatus(formatErrorPayload(payload) || 'Delete failed')
      return
    }
    setApiKeys(await loadProviderApiKeys(selectedProvider.id))
    await loadProviders()
    setApiKeyStatus('Deleted')
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
      } else if (testMode === 'video') {
        await runVideoTest()
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
        extra_params: parseJsonObject(speechForm.extra_params, 'extra_params'),
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
        instructions: effectForm.instructions,
        response_format: effectForm.response_format,
        duration_seconds: Number(effectForm.duration_seconds) || undefined,
        prompt_influence: Number(effectForm.prompt_influence) || undefined,
        loop: effectForm.loop,
        extra_params: parseJsonObject(effectForm.extra_params, 'extra_params'),
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
      ...parseJsonObject(designForm.extra_params, 'extra_params'),
      ...typed_extra_params,
    }
    const response = await fetch(apiUrl('/v1/audio/voices/design', api_base_url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: selectedProvider.id,
        instructions: designForm.instructions,
        name: designForm.name || undefined,
        input: designForm.input || undefined,
        response_format: designForm.response_format,
        model: designForm.model || undefined,
        extra_params: Object.keys(extra_params).length ? extra_params : undefined,
      }),
    })
    if (!response.ok) throw new Error(await readError(response))
    const payload = await response.json()
    setTestResult({
      kind: 'json',
      payload,
      content: JSON.stringify(payload, null, 2),
      mime_type: 'application/json',
      endpoint: 'POST /v1/audio/voices/design',
      createdPreviewIds: {},
    })
  }

  async function createDesignedVoice(preview) {
    if (!selectedProvider) return
    setTestStatus('Creating voice...')
    try {
      const response = await fetch(apiUrl('/v1/audio/voices/create', api_base_url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider.id,
          generated_voice_id: preview.generated_voice_id,
          name: preview.name || designForm.name || preview.generated_voice_id,
          instructions: preview.instructions || designForm.instructions,
          language: preview.language,
        }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(formatErrorPayload(payload) || 'Create voice failed')
      setTestResult(current => ({
        ...current,
        createdPreviewIds: {
          ...(current?.createdPreviewIds || {}),
          [preview.generated_voice_id]: payload.id,
        },
        createResponse: payload,
        content: JSON.stringify({
          ...(current?.payload || {}),
          created_voice: payload,
        }, null, 2),
      }))
      setTestStatus('Created')
      if (selectedProvider.capabilities?.tts) {
        loadProviderVoices(selectedProvider.id)
          .then(options => setVoiceOptions(options))
          .catch(() => {})
      }
    } catch (error) {
      setTestStatus('Create failed')
      setTestResult(current => ({
        ...(current || {}),
        kind: current?.kind || 'error',
        createError: error instanceof Error ? error.message : String(error),
      }))
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

  async function runVideoTest() {
    if (videoForm.operation === 'retrieve' || videoForm.operation === 'download') {
      const videoId = videoForm.video_id.trim()
      if (!videoId) throw new Error('video_id is required.')
      const query = new URLSearchParams({ provider: selectedProvider.id })
      const path = videoForm.operation === 'download'
        ? `/v1/videos/${encodeURIComponent(videoId)}/content?${query.toString()}`
        : `/v1/videos/${encodeURIComponent(videoId)}?${query.toString()}`
      const response = await fetch(apiUrl(path, api_base_url))
      if (!response.ok) throw new Error(await readError(response))
      if (videoForm.operation === 'download') {
        const blob = await response.blob()
        const objectUrl = URL.createObjectURL(blob)
        setTestResult({
          kind: 'video',
          objectUrl,
          mime_type: response.headers.get('content-type') || blob.type,
          size: blob.size,
          endpoint: 'GET /v1/videos/{video_id}/content',
        })
        return
      }
      const payload = await response.json()
      setTestResult({
        kind: 'json',
        payload,
        content: JSON.stringify(payload, null, 2),
        mime_type: 'application/json',
        endpoint: 'GET /v1/videos/{video_id}',
      })
      return
    }

    const form = new FormData()
    form.set('provider', selectedProvider.id)
    if (videoForm.model.trim()) form.set('model', videoForm.model.trim())
    form.set('size', videoForm.size)
    if (videoImageFile) {
      form.set('ref_image', videoImageFile)
    } else if (videoForm.ref_image.trim()) {
      form.set('ref_image', videoForm.ref_image.trim())
    } else {
      throw new Error('ref_image is required.')
    }
    if (videoForm.input_mode === 'tts') {
      const input = videoForm.tts_input.trim()
      if (!input) throw new Error('input_tts.input is required.')
      form.set('input_tts', JSON.stringify(compactPayload({
        input,
        model: videoForm.tts_model.trim() || undefined,
        voice: videoForm.tts_voice.trim() || undefined,
        response_format: videoForm.tts_response_format,
      })))
    } else if (videoAudioFile) {
      form.set('input', videoAudioFile)
    } else if (videoForm.input.trim()) {
      form.set('input', videoForm.input.trim())
    } else {
      throw new Error('input is required.')
    }
    appendExtraParams(form, videoForm.extra_params)

    const response = await fetch(apiUrl('/v1/videos', api_base_url), {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error(await readError(response))
    const payload = await response.json()
    setVideoForm(current => current.video_id || !payload.id ? current : { ...current, video_id: payload.id })
    if (!payload.id) {
      setTestResult({
        kind: 'json',
        payload,
        content: JSON.stringify(payload, null, 2),
        mime_type: 'application/json',
        endpoint: 'POST /v1/videos',
      })
      return
    }

    setVideoProgressResult(payload, 'POST /v1/videos')
    const finalPayload = await pollVideoResult(payload.id)
    const contentQuery = new URLSearchParams({ provider: selectedProvider.id })
    const contentResponse = await fetch(apiUrl(`/v1/videos/${encodeURIComponent(payload.id)}/content?${contentQuery.toString()}`, api_base_url))
    if (!contentResponse.ok) throw new Error(await readError(contentResponse))
    const blob = await contentResponse.blob()
    const objectUrl = URL.createObjectURL(blob)
    setTestResult({
      kind: 'video',
      objectUrl,
      payload: finalPayload,
      content: JSON.stringify(finalPayload, null, 2),
      mime_type: contentResponse.headers.get('content-type') || blob.type,
      size: blob.size,
      endpoint: 'GET /v1/videos/{video_id}/content',
    })
  }

  async function pollVideoResult(videoId) {
    const timeoutMs = 10 * 60 * 1000
    const intervalMs = 3000
    const deadline = Date.now() + timeoutMs
    let attempt = 0
    let lastPayload = null
    while (Date.now() <= deadline) {
      if (attempt > 0) await delay(intervalMs)
      attempt += 1
      const query = new URLSearchParams({ provider: selectedProvider.id })
      const response = await fetch(apiUrl(`/v1/videos/${encodeURIComponent(videoId)}?${query.toString()}`, api_base_url), {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(await readError(response))
      const payload = await response.json()
      lastPayload = payload
      setVideoProgressResult(payload, 'GET /v1/videos/{video_id}', attempt)
      const status = normalizeVideoStatus(payload.status)
      if (isVideoSuccessStatus(status)) return payload
      if (isVideoErrorStatus(status)) {
        throw new Error(payload.error?.message || payload.error || `Video task failed with status: ${payload.status || 'unknown'}`)
      }
    }
    throw new Error(`Video task did not complete after ${Math.round(timeoutMs / 1000)}s. Last response: ${JSON.stringify(lastPayload)}`)
  }

  function setVideoProgressResult(payload, endpoint, attempt = 0) {
    const progress = formatVideoProgress(payload)
    const status = payload?.status ? String(payload.status) : 'pending'
    setTestStatus(`${status}${progress ? ` · ${progress}` : ''}${attempt ? ` · poll ${attempt}` : ''}`)
    setTestResult({
      kind: 'json',
      payload,
      content: JSON.stringify(payload, null, 2),
      mime_type: 'application/json',
      endpoint,
    })
  }

  const capabilityText = useMemo(() => {
    if (!selectedProvider) return ''
    return Object.entries(selectedProvider.capabilities || {})
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key)
      .join(', ')
  }, [selectedProvider])

  return (
    <main className="min-h-screen bg-[#0F172A] text-[#F8FAFC]">
      <div className="mx-auto grid max-w-7xl gap-6 px-5 py-7 lg:px-8">
        <header className="border-b border-slate-800/80 pb-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="font-mono text-3xl font-bold tracking-tight text-white">voxout</h1>
                <span className="relative flex h-2.5 w-2.5 mt-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
              </div>
              <p className="mt-1.5 text-sm text-slate-400">Provider gateway configuration and audio testing playground</p>
            </div>
            <div className="self-start sm:self-auto text-xs text-slate-400 font-mono bg-slate-900/80 px-3.5 py-2 rounded-lg border border-slate-800">
              v0.1.0 · <span className="text-emerald-400 font-bold">GATEWAY ACTIVE</span>
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="panel h-fit">
            <h2 className="mb-4 text-sm font-bold font-mono tracking-wider text-slate-400 uppercase">Providers</h2>
            <div className="grid gap-2.5">
              {providers.map(provider => (
                <button
                  className={`provider-card ${provider.id === selectedProvider?.id ? 'provider-card-active' : ''}`}
                  key={provider.id}
                  type="button"
                  onClick={() => setSelectedProviderId(provider.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <strong className="text-slate-200">{provider.name}</strong>
                    <span className="badge">{provider.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div className="text-xs text-slate-500 font-mono mt-1">{provider.id}</div>
                </button>
              ))}
            </div>
          </aside>

          <section className="panel">
            {selectedProvider ? (
              <>
                <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold font-mono text-white">{selectedProvider.name}</h2>
                    <div className="text-xs text-emerald-400 font-mono mt-1 tracking-wider uppercase">{capabilityText}</div>
                  </div>
                  <button className="btn-secondary" type="button" onClick={openConfig}>Configure</button>
                </div>

                <div className="border-t border-slate-800/80 pt-6">
                  <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <h2 className="text-sm font-bold font-mono tracking-wider text-slate-400 uppercase">Test API</h2>
                  </div>
                  <div className="mb-5 flex flex-wrap gap-2.5">
                    {getSupportedTestModes(selectedProvider).map(mode => (
                      <button
                        className={`tab ${testMode === mode ? 'tab-active' : ''}`}
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
                    ) : testMode === 'video' ? (
                      <VideoTestForm
                        audioFile={videoAudioFile}
                        form={videoForm}
                        imageFile={videoImageFile}
                        modelField={getProviderField(selectedProvider, 'video_model')}
                        onAudioFileChange={setVideoAudioFile}
                        onFormChange={setVideoForm}
                        onImageFileChange={setVideoImageFile}
                        voiceField={getProviderField(selectedProvider, 'tts_voice')}
                      />
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

                  <ResultPreview result={testResult} onCreatePreview={createDesignedVoice} />
                </div>

                {isConfigOpen ? (
                  <ConfigDialog
                    apiKeyDialog={apiKeyDialog}
                    apiKeys={apiKeys}
                    apiKeyStatus={apiKeyStatus}
                    formValues={formValues}
                    onApiKeyDialogClose={() => setApiKeyDialog(null)}
                    onApiKeyFieldChange={updateApiKeyDialogValue}
                    onApiKeySave={saveApiKey}
                    onClose={closeConfig}
                    onCreateApiKey={openApiKeyCreate}
                    onDeleteApiKey={deleteApiKey}
                    onEditApiKey={openApiKeyEdit}
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

function ConfigDialog({
  apiKeyDialog,
  apiKeys,
  apiKeyStatus,
  formValues,
  onApiKeyDialogClose,
  onApiKeyFieldChange,
  onApiKeySave,
  onClose,
  onCreateApiKey,
  onDeleteApiKey,
  onEditApiKey,
  onFieldChange,
  onSubmit,
  provider,
  saveStatus,
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 backdrop-blur-sm px-4 py-6" onMouseDown={onClose}>
      <div className="modal-panel" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4 bg-slate-900/80">
          <div>
            <h2 className="text-xl font-bold font-mono text-white">{provider.name}</h2>
            <div className="text-xs text-slate-400 font-mono mt-0.5">{provider.id}</div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close configuration">×</button>
        </div>

        <form className="grid gap-4 px-5 py-4" onSubmit={onSubmit}>
          <label className="inline-flex items-center gap-2 font-semibold text-slate-200 cursor-pointer text-sm">
            <input
              type="checkbox"
              className="rounded border-slate-800 bg-slate-950 text-emerald-500 focus:ring-emerald-500/20"
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

          <section className="grid gap-3 border-t border-slate-800 pt-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-bold font-mono text-slate-200 uppercase tracking-wider text-sm">API keys</h3>
                <div className="text-xs text-slate-400 font-mono">{apiKeys.length} configured</div>
              </div>
              <button className="btn-secondary py-1.5 px-3 text-xs" type="button" onClick={onCreateApiKey}>Add key</button>
            </div>
            <div className="grid gap-2">
              {apiKeys.length ? apiKeys.map(apiKey => (
                <div className="api-key-row" key={apiKey.id}>
                  <div className="min-w-0">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <strong className="truncate text-slate-200">{apiKey.name}</strong>
                      <span className="badge">{apiKey.enabled ? 'enabled' : 'disabled'}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-400 font-mono">
                      {apiKey.key_hint} · weight {apiKey.weight ?? 1}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button className="btn-secondary py-1.5 px-3 text-xs" type="button" onClick={() => onEditApiKey(apiKey)}>Edit</button>
                    <button className="btn-secondary py-1.5 px-3 text-xs" type="button" onClick={() => onDeleteApiKey(apiKey)}>Delete</button>
                  </div>
                </div>
              )) : (
                <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/20 p-4 text-sm text-slate-500 text-center font-mono">No API keys configured.</div>
              )}
            </div>
          </section>

          <div className="flex flex-col gap-3 border-t border-slate-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-slate-400 font-mono">{apiKeyStatus || saveStatus}</span>
            <div className="flex gap-2 justify-end">
              <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
              <button className="btn-primary" type="submit">Save</button>
            </div>
          </div>
        </form>
      </div>
      {apiKeyDialog ? (
        <ApiKeyDialog
          dialog={apiKeyDialog}
          onClose={onApiKeyDialogClose}
          onFieldChange={onApiKeyFieldChange}
          onSubmit={onApiKeySave}
        />
      ) : null}
    </div>
  )
}

function ApiKeyDialog({ dialog, onClose, onFieldChange, onSubmit }) {
  const isEdit = dialog.mode === 'edit'
  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/70 backdrop-blur-sm px-4 py-6"
      onMouseDown={event => {
        event.stopPropagation()
        onClose()
      }}
    >
      <div className="modal-panel max-w-xl" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4 bg-slate-900/80">
          <div>
            <h2 className="text-xl font-bold font-mono text-white">{isEdit ? 'Edit API key' : 'Add API key'}</h2>
            <div className="text-xs text-slate-400 font-mono mt-0.5">{isEdit ? dialog.apiKey.key_hint : 'Weighted random selection uses enabled keys.'}</div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close API key dialog">×</button>
        </div>
        <form className="grid gap-4 px-5 py-4" onSubmit={onSubmit}>
          <label className="grid gap-1.5 text-xs font-semibold text-slate-300 font-mono tracking-wider">
            name
            <input
              className="input"
              placeholder="Default"
              value={dialog.values.name}
              onChange={event => onFieldChange('name', event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-slate-300 font-mono tracking-wider">
            api_key
            <input
              className="input"
              placeholder={isEdit ? 'Leave blank to keep existing key' : ''}
              type="password"
              value={dialog.values.api_key}
              onChange={event => onFieldChange('api_key', event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-slate-300 font-mono tracking-wider">
            weight
            <input
              className="input"
              min="0"
              step="1"
              type="number"
              value={dialog.values.weight}
              onChange={event => onFieldChange('weight', event.target.value)}
            />
          </label>
          <label className="inline-flex items-center gap-2 font-semibold text-slate-200 cursor-pointer text-sm font-mono">
            <input
              type="checkbox"
              className="rounded border-slate-800 bg-slate-950 text-emerald-500 focus:ring-emerald-500/20"
              checked={Boolean(dialog.values.enabled)}
              onChange={event => onFieldChange('enabled', event.target.checked)}
            />
            enabled
          </label>
          <div className="flex flex-col gap-3 border-t border-slate-800 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-slate-400 font-mono">{dialog.status}</span>
            <div className="flex gap-2 justify-end">
              <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
              <button className="btn-primary" type="submit">Save key</button>
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
        input
        <textarea
          className="textarea min-h-28"
          value={form.input}
          onChange={event => onFormChange({ ...form, input: event.target.value })}
        />
      </label>
      {modelField ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          model
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
        voice
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
        response_format
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
          stream_format
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
        speed
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
        instructions
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
        file_format
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
          model
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
        language
        <input
          className="input"
          placeholder="auto"
          value={form.language}
          onChange={event => onFormChange({ ...form, language: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        prompt
        <input
          className="input"
          value={form.prompt}
          onChange={event => onFormChange({ ...form, prompt: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        temperature
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
        response_format
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
          stream
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
      <label htmlFor={fileId}>file</label>
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

function VideoTestForm({
  audioFile,
  form,
  imageFile,
  modelField,
  onAudioFileChange,
  onFormChange,
  onImageFileChange,
  voiceField,
}) {
  const modelListId = modelField?.options?.length ? 'video-model-options' : undefined
  const voiceListId = voiceField?.options?.length ? 'video-tts-voice-options' : undefined
  const isCreate = form.operation === 'create'
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold">
        operation
        <select
          className="input"
          value={form.operation}
          onChange={event => onFormChange({ ...form, operation: event.target.value })}
        >
          <option value="create">create</option>
          <option value="retrieve">retrieve</option>
          <option value="download">download</option>
        </select>
      </label>
      {!isCreate ? (
        <label className="grid gap-1.5 text-sm font-semibold">
          video_id
          <input
            className="input"
            value={form.video_id}
            onChange={event => onFormChange({ ...form, video_id: event.target.value })}
          />
        </label>
      ) : null}
      {isCreate ? (
        <>
          {modelField ? (
            <label className="grid gap-1.5 text-sm font-semibold">
              model
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
            size
            <select
              className="input"
              value={form.size}
              onChange={event => onFormChange({ ...form, size: event.target.value })}
            >
              <option value="640x640">640x640</option>
              <option value="640x480">640x480</option>
              <option value="480x640">480x640</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
            ref_image
            <input
              className="input"
              placeholder="https://example.com/avatar.png"
              value={form.ref_image}
              onChange={event => onFormChange({ ...form, ref_image: event.target.value })}
            />
          </label>
          <FilePicker
            accept="image/png,image/jpeg,image/webp"
            file={imageFile}
            inputId="video-ref-image"
            label="ref_image_file"
            onFileChange={onImageFileChange}
          />
          <label className="grid gap-1.5 text-sm font-semibold">
            input_mode
            <select
              className="input"
              value={form.input_mode}
              onChange={event => onFormChange({ ...form, input_mode: event.target.value })}
            >
              <option value="tts">input_tts</option>
              <option value="audio">input</option>
            </select>
          </label>
          {form.input_mode === 'tts' ? (
            <>
              <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
                input_tts.input
                <textarea
                  className="textarea min-h-24"
                  value={form.tts_input}
                  onChange={event => onFormChange({ ...form, tts_input: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                input_tts.voice
                <input
                  className="input"
                  list={voiceListId}
                  placeholder={voiceField?.placeholder || 'preset or custom voice ID'}
                  value={form.tts_voice}
                  onChange={event => onFormChange({ ...form, tts_voice: event.target.value })}
                />
                {voiceListId ? (
                  <datalist id={voiceListId}>
                    {voiceField.options.map(option => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
                ) : null}
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                input_tts.model
                <input
                  className="input"
                  placeholder="higgs-tts-3"
                  value={form.tts_model}
                  onChange={event => onFormChange({ ...form, tts_model: event.target.value })}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                input_tts.response_format
                <select
                  className="input"
                  value={form.tts_response_format}
                  onChange={event => onFormChange({ ...form, tts_response_format: event.target.value })}
                >
                  <option value="mp3">mp3</option>
                  <option value="wav">wav</option>
                  <option value="aac">aac</option>
                  <option value="flac">flac</option>
                  <option value="opus">opus</option>
                  <option value="pcm">pcm</option>
                </select>
              </label>
            </>
          ) : (
            <>
              <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
                input
                <input
                  className="input"
                  placeholder="https://example.com/speech.mp3"
                  value={form.input}
                  onChange={event => onFormChange({ ...form, input: event.target.value })}
                />
              </label>
              <FilePicker
                accept="audio/aac,audio/wav,audio/mpeg,audio/flac,audio/ogg"
                file={audioFile}
                inputId="video-driving-audio"
                label="input_file"
                onFileChange={onAudioFileChange}
              />
            </>
          )}
          <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
        </>
      ) : null}
    </div>
  )
}

function FilePicker({ accept, file, inputId, label, onFileChange }) {
  return (
    <div className="grid gap-1.5 text-sm font-semibold md:col-span-2">
      <label htmlFor={inputId}>{label}</label>
      <div className="audio-source-actions rounded-lg border border-slate-800">
        <span className="truncate text-sm font-normal text-slate-500">
          {file ? file.name : 'Choose file'}
        </span>
        <label className="btn-secondary shrink-0 cursor-pointer" htmlFor={inputId}>
          Choose file
        </label>
        <input
          accept={accept}
          className="sr-only"
          id={inputId}
          type="file"
          onChange={event => onFileChange(event.target.files?.[0] ?? null)}
        />
      </div>
    </div>
  )
}

function EffectTestForm({ form, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        instructions
        <textarea
          className="textarea min-h-28"
          value={form.instructions}
          onChange={event => onFormChange({ ...form, instructions: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        duration_seconds
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
        prompt_influence
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
        response_format
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
        loop
      </label>
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function DesignTestForm({ form, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        instructions
        <textarea
          className="textarea min-h-28"
          value={form.instructions}
          onChange={event => onFormChange({ ...form, instructions: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        name
        <input
          className="input"
          value={form.name}
          onChange={event => onFormChange({ ...form, name: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        model
        <input
          className="input"
          placeholder="provider default"
          value={form.model}
          onChange={event => onFormChange({ ...form, model: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        input
        <textarea
          className="textarea min-h-20"
          value={form.input}
          onChange={event => onFormChange({ ...form, input: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        response_format
        <select
          className="input"
          value={form.response_format}
          onChange={event => onFormChange({ ...form, response_format: event.target.value })}
        >
          <option value="mp3">mp3</option>
          <option value="mp3_44100_128">mp3_44100_128</option>
          <option value="mp3_44100_192">mp3_44100_192</option>
          <option value="wav">wav</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        extra_params.guidance_scale
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
        extra_params.seed
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
        extra_params.auto_generate_text
      </label>
      <ExtraParamsField value={form.extra_params} onChange={extra_params => onFormChange({ ...form, extra_params })} />
    </div>
  )
}

function CloneTestForm({ file, form, onFileChange, onFormChange }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="grid gap-1.5 text-sm font-semibold md:col-span-2">
        <label htmlFor="clone-audio-sample">audio_sample</label>
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
        name
        <input
          className="input"
          value={form.name}
          onChange={event => onFormChange({ ...form, name: event.target.value })}
        />
      </label>
      <label className="grid gap-1.5 text-sm font-semibold">
        consent
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
      extra_params
      <textarea
        className="textarea min-h-20 font-mono"
        placeholder="{}"
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  )
}

function ResultPreview({ onCreatePreview, result }) {
  if (!result) return null
  if (result.kind === 'error') {
    return (
      <div className="mt-5 rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-400 font-mono shadow-inner shadow-red-950/10">
        <span className="font-bold text-red-500 mr-1.5">[ERROR]</span>
        {result.message}
      </div>
    )
  }
  if (result.kind === 'audio') {
    return (
      <div className="mt-5 grid gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5 shadow-xl shadow-slate-950/10 backdrop-blur-sm">
        <div className="text-xs text-slate-400 font-mono flex items-center justify-between border-b border-slate-800 pb-2.5">
          <span>{result.endpoint}</span>
          <span className="text-[10px] bg-slate-950 px-2 py-0.5 rounded text-slate-500">{result.mime_type} · {formatBytes(result.size)}</span>
        </div>
        <audio className="w-full mt-2" controls src={result.objectUrl} />
        <div className="mt-1">
          <a className="link" href={result.objectUrl} rel="noreferrer" target="_blank">Open audio preview</a>
        </div>
      </div>
    )
  }
  if (result.kind === 'video') {
    return (
      <div className="mt-5 grid gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5 shadow-xl shadow-slate-950/10 backdrop-blur-sm">
        <div className="text-xs text-slate-400 font-mono flex items-center justify-between border-b border-slate-800 pb-2.5">
          <span>{result.endpoint}</span>
          <span className="text-[10px] bg-slate-950 px-2 py-0.5 rounded text-slate-500">{result.mime_type} · {formatBytes(result.size)}</span>
        </div>
        <video className="mt-2 w-full max-h-[32rem] rounded-lg bg-black" controls src={result.objectUrl} />
        <div className="mt-1">
          <a className="link" href={result.objectUrl} rel="noreferrer" target="_blank">Open video preview</a>
        </div>
        {result.content ? (
          <div className="flex flex-col gap-2 mt-2">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono bg-slate-950/60 border border-slate-800/80 px-4 py-2 rounded-t-xl border-b-0">
              <span>RESPONSE DATA</span>
              <span className="text-[10px] bg-slate-900 text-slate-500 px-1.5 py-0.5 rounded font-mono">JSON</span>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-b-xl border border-slate-800/80 bg-slate-950/80 p-4 text-xs text-emerald-400 font-mono leading-relaxed shadow-inner">{result.content}</pre>
          </div>
        ) : null}
      </div>
    )
  }
  const voicePreviews = getVoicePreviewItems(result.payload)
  return (
    <div className="mt-5 grid gap-4 rounded-xl border border-slate-800 bg-slate-900/40 p-5 shadow-xl shadow-slate-950/10 backdrop-blur-sm">
      <div className="text-xs text-slate-400 font-mono flex items-center justify-between border-b border-slate-800 pb-2.5">
        <span>{result.endpoint}</span>
        <span className="text-[10px] bg-slate-950 px-2 py-0.5 rounded text-slate-500">{result.mime_type}</span>
      </div>
      {result.createError ? (
        <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-400 font-mono">
          <span className="font-bold text-red-500 mr-1.5">[CREATE ERROR]</span>
          {result.createError}
        </div>
      ) : null}
      {voicePreviews.length ? (
        <div className="grid gap-3 mt-1">
          {voicePreviews.map(preview => {
            const createdId = result.createdPreviewIds?.[preview.generated_voice_id]
            return (
              <div className="preview-card" key={preview.generated_voice_id || preview.id}>
                <div className="min-w-0">
                  <div className="truncate font-semibold text-slate-200">{preview.name || preview.generated_voice_id || preview.id}</div>
                  <div className="text-xs text-slate-400 font-mono mt-1">
                    {[preview.language, preview.preview_mime_type, formatDuration(preview.duration_seconds)].filter(Boolean).join(' · ')}
                  </div>
                  {preview.preview_audio ? <audio className="mt-3 w-full" controls src={preview.preview_audio} /> : null}
                </div>
                <button
                  className="btn-primary shrink-0 self-center"
                  disabled={Boolean(createdId)}
                  type="button"
                  onClick={() => onCreatePreview?.(preview)}
                >
                  {createdId ? 'Created' : 'Create'}
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 mt-2">
        <div className="flex items-center justify-between text-[11px] text-slate-400 font-mono bg-slate-950/60 border border-slate-800/80 px-4 py-2 rounded-t-xl border-b-0">
          <span>RESPONSE DATA</span>
          <span className="text-[10px] bg-slate-900 text-slate-500 px-1.5 py-0.5 rounded font-mono">JSON</span>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-b-xl border border-slate-800/80 bg-slate-950/80 p-4 text-xs text-emerald-400 font-mono leading-relaxed shadow-inner">{result.content}</pre>
      </div>
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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeVideoStatus(status) {
  return String(status ?? '').trim().toLowerCase()
}

function isVideoSuccessStatus(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done', 'finished'].includes(status)
}

function isVideoErrorStatus(status) {
  return ['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(status)
}

function formatVideoProgress(payload) {
  const value = payload?.progress
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  const percent = value <= 1 ? value * 100 : value
  return `${Math.max(0, Math.min(100, Math.round(percent)))}%`
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
  if (mode === 'video') return Boolean(provider.capabilities?.video)
  return Boolean(provider.capabilities?.tts)
}

function getSupportedTestModes(provider) {
  return ['tts', 'asr', 'effect', 'isolation', 'design', 'clone', 'video']
    .filter(mode => supportsTestMode(provider, mode))
}

function getDefaultTestMode(provider) {
  return getSupportedTestModes(provider)[0] || 'tts'
}

function getTestModeLabel(mode) {
  if (mode === 'tts') return 'Speech'
  if (mode === 'asr') return 'Transcription'
  if (mode === 'effect') return 'Effect'
  if (mode === 'isolation') return 'Isolation'
  if (mode === 'clone') return 'Clone'
  if (mode === 'video') return 'Video'
  return 'Design'
}

function defaultSpeechForm(provider) {
  return {
    input: '你好，voxout。',
    model: provider?.config?.tts_model ?? '',
    voice: '',
    response_format: 'mp3',
    stream_format: '',
    speed: '1',
    instructions: '',
    extra_params: '',
  }
}

function defaultEffectForm() {
  return {
    instructions: 'a short cinematic whoosh',
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

function defaultDesignForm(provider) {
  return {
    instructions: 'A calm narrator voice with a clean tone and warm delivery.',
    name: '',
    input: '',
    model: '',
    response_format: provider?.id === 'mimo' ? 'mp3' : 'mp3_44100_128',
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

function defaultVideoForm(provider) {
  return {
    operation: 'create',
    model: getProviderField(provider, 'video_model') ? provider?.config?.video_model ?? '' : '',
    size: provider?.config?.video_size ?? '640x640',
    ref_image: '',
    input_mode: 'tts',
    input: '',
    tts_input: 'Hello from voxout.',
    tts_model: 'higgs-tts-3',
    tts_voice: provider?.config?.tts_voice ?? 'chloe',
    tts_response_format: 'mp3',
    video_id: '',
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
  const extra_params = parseJsonObject(value, 'extra_params')
  if (extra_params) form.set('extra_params', JSON.stringify(extra_params))
}

function formatBytes(value) {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

function formatDuration(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return ''
  return `${number.toFixed(number >= 10 ? 0 : 1)}s`
}

function getVoicePreviewItems(payload) {
  if (!payload || payload.object !== 'list' || !Array.isArray(payload.data)) return []
  return payload.data.filter(item => item?.object === 'audio.voice.preview')
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
