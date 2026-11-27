import type { UpdateManifest, UpdatePlatform } from '../../shared/types'

/**
 * Фид обновлений: GitHub Releases этого репозитория.
 *
 * Один тег `v<version>` — артефакты для всех платформ:
 *   Windows  Syntee-Helper-Setup-<version>-x64.exe   (NSIS, ставится молча)
 *   Linux    syntee-helper-<version>-x86_64.tar.zst  (переносимый архив)
 *
 * Целостность берётся из поля `digest`, которое GitHub проставляет ассету
 * сам: `sha256:<hex>`. Если digest отсутствует или размер нулевой — релиз
 * игнорируется целиком, чтобы не поставить битый файл.
 */
declare const __SYNTEE_RELEASE_REPOSITORY__: string | undefined
const repository = typeof __SYNTEE_RELEASE_REPOSITORY__ === 'string'
  ? __SYNTEE_RELEASE_REPOSITORY__
  : 'Lun13371/SynteeAgentDesktop'
const tagPrefix = 'v'

const versionPattern = /^(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/

const PLATFORMS: readonly UpdatePlatform[] = ['win32', 'linux'] as const

/** Имя ассета, который CI публикует для платформы. */
export function releaseAssetName(version: string, platform: UpdatePlatform): string {
  return platform === 'win32'
    ? `Syntee-Helper-Setup-${version}-x64.exe`
    : `syntee-helper-${version}-x86_64.tar.zst`
}

/** Прямая ссылка на ассет релиза или null, если версия некорректна. */
export function releaseAssetUrl(version: string, platform: UpdatePlatform): string | null {
  if (!versionPattern.test(version)) return null
  return `https://github.com/${repository}/releases/download/${tagPrefix}${version}/${releaseAssetName(version, platform)}`
}

function versionFromTag(tag: string): string | null {
  if (!tag.startsWith(tagPrefix)) return null
  const version = tag.slice(tagPrefix.length)
  return versionPattern.test(version) ? version : null
}

function compareVersions(a: string, b: string): number {
  const [am, an, ap] = a.split('.').map(Number)
  const [bm, bn, bp] = b.split('.').map(Number)
  return am - bm || an - bn || ap - bp
}

type ReleaseAsset = {
  browser_download_url?: string
  digest?: string
  size?: number
  state?: string
}

type Release = {
  draft?: boolean
  prerelease?: boolean
  tag_name?: string
  body?: string
  published_at?: string
  assets?: ReleaseAsset[]
}

/** Платформа, под которую работает текущий процесс (null — не поддерживается). */
export function currentPlatform(): UpdatePlatform | null {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  return null
}

/**
 * Разбирает ответ `/releases` в список манифестов. На один релиз может
 * приходиться два манифеста — по одному на платформу.
 */
export function parseReleaseFeed(payload: unknown): UpdateManifest[] {
  if (!Array.isArray(payload)) throw new Error('Некорректный список релизов GitHub')
  const updates: UpdateManifest[] = []

  for (const release of payload as Release[]) {
    if (!release || release.draft !== false || release.prerelease || typeof release.tag_name !== 'string') continue
    const version = versionFromTag(release.tag_name)
    if (!version) continue
    if (typeof release.published_at !== 'string' || !Array.isArray(release.assets)) continue

    for (const platform of PLATFORMS) {
      const url = releaseAssetUrl(version, platform)
      if (!url) continue
      const asset = release.assets.find(item => item?.browser_download_url === url && item.state === 'uploaded')
      if (!asset) continue
      if (typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue
      if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) continue

      updates.push({
        version,
        platform,
        delivery: platform === 'win32' ? 'installer' : 'archive',
        channel: platform === 'win32' ? 'GitHub / Windows' : 'GitHub / Linux',
        zip_url: url,
        zip_size: asset.size,
        sha256: asset.digest.slice(7),
        force: false,
        min_version: null,
        changelog: typeof release.body === 'string' ? release.body : null,
        released_at: release.published_at,
      })
    }
  }

  return updates.sort((a, b) => compareVersions(b.version, a.version))
}

/** Самая новая версия для платформы, если она новее установленной. */
export function findUpdate(
  releases: UpdateManifest[],
  current: string,
  platform: UpdatePlatform,
): UpdateManifest | null {
  if (!versionPattern.test(current)) return null
  return releases.find(release => release.platform === platform && compareVersions(release.version, current) > 0) ?? null
}

let pending: Promise<UpdateManifest[]> | undefined

/** Список релизов с кэшем на время одного запроса (параллельные вызовы склеиваются). */
export function fetchReleaseFeed(): Promise<UpdateManifest[]> {
  pending ??= fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  }).then(async response => {
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`)
    return parseReleaseFeed(await response.json())
  }).finally(() => { pending = undefined })
  return pending
}
