import type { LiquidProviderDetail } from './types'

const APOGEE_RDNS = 'io.resolvr.apogee'
const DISCOVERY_TIMEOUT_MS = 1_500

let cachedApogee: LiquidProviderDetail | null = null

function isProviderDetail(value: unknown): value is LiquidProviderDetail {
  if (!value || typeof value !== 'object') return false
  const detail = value as Partial<LiquidProviderDetail>
  return (
    !!detail.info &&
    detail.info.rdns === APOGEE_RDNS &&
    !!detail.provider &&
    typeof detail.provider.request === 'function' &&
    typeof detail.provider.on === 'function'
  )
}

export async function discoverApogeeProvider(
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<LiquidProviderDetail> {
  if (cachedApogee) return cachedApogee

  return new Promise<LiquidProviderDetail>((resolve, reject) => {
    let settled = false
    const finish = (detail?: LiquidProviderDetail) => {
      if (settled) return
      settled = true
      window.removeEventListener('liquid:announceProvider', onAnnounce as EventListener)
      clearTimeout(timer)
      if (!detail) {
        reject(new Error('Apogee was not found. Install or enable the Apogee browser extension.'))
        return
      }
      cachedApogee = detail
      resolve(detail)
    }
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail
      if (isProviderDetail(detail)) finish(detail)
    }
    const timer = window.setTimeout(() => finish(), timeoutMs)
    window.addEventListener('liquid:announceProvider', onAnnounce as EventListener)
    window.dispatchEvent(new Event('liquid:requestProvider'))
  })
}

export function forgetApogeeProvider(): void {
  cachedApogee = null
}
