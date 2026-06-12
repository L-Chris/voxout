export function getSynthesisTimeoutMs(): number {
  const value = Number(process.env.TTS_SYNTHESIS_TIMEOUT_MS ?? 45000)
  return Number.isFinite(value) && value > 0 ? value : 45000
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
