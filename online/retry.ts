export type RequestGroup = 'read' | 'write' | 'create'
const storeKey = 'skyjo-online-backoff-v1'
type Limits = Partial<Record<RequestGroup, number>>

function load(): Limits {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storeKey) || '{}')
    const limits: Limits = {}
    for (const group of ['read', 'write', 'create'] as const) {
      const time = parsed?.[group]
      if (Number.isFinite(time) && time > Date.now()) limits[group] = time
    }
    return limits
  } catch {
    return {}
  }
}

const limits = load()

export function requestGroup(path: string, write: boolean): RequestGroup {
  if (!write) return 'read'
  return path === '/api/games' ? 'create' : 'write'
}

export function retryAt(group: RequestGroup): number {
  const time = limits[group] ?? 0
  return time > Date.now() ? time : 0
}

export function rememberRetry(
  group: RequestGroup,
  header: string | null,
  fallbackSeconds: number,
) {
  const now = Date.now()
  const fallback = now + fallbackSeconds * 1000
  let time = fallback
  if (header)
    time = /^\d+$/.test(header) ? now + Number(header) * 1000 : Date.parse(header)
  if (!Number.isFinite(new Date(time).getTime())) time = fallback
  limits[group] = Math.max(retryAt(group), time)
  try {
    sessionStorage.setItem(storeKey, JSON.stringify(limits))
  } catch {
    /* Still honor the wait in this tab if browser storage is disabled. */
  }
  return limits[group]!
}

export function waitMessage(time: number) {
  if (time <= Date.now()) return 'You can try again now.'
  const date = new Date(time)
  const when = date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString()
    : date.toLocaleString()
  return 'Try again after ' + when + '.'
}
