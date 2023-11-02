// Netlify Cache Handler
// (CJS format because Next.js doesn't support ESM yet)
//
import { getDeployStore } from '@netlify/blobs'
import { purgeCache } from '@netlify/functions'
import { readFileSync } from 'node:fs'
import type {
  CacheHandler,
  CacheHandlerContext,
  IncrementalCache,
} from 'next/dist/server/lib/incremental-cache/index.js'
import { join } from 'node:path/posix'
// @ts-expect-error This is a type only import
import type { CacheEntryValue } from '../../build/content/prerendered.js'

type TagManifest = { revalidatedAt: number }

const tagsManifestPath = '_netlify-cache/tags'
const blobStore = getDeployStore()

// load the prerender manifest
const prerenderManifest = JSON.parse(
  readFileSync(join(process.cwd(), '.next/prerender-manifest.json'), 'utf-8'),
)

/** Converts a cache key pathname to a route */
function toRoute(pathname: string): string {
  return pathname.replace(/\/$/, '').replace(/\/index$/, '') || '/'
}

export default class NetlifyCacheHandler implements CacheHandler {
  options: CacheHandlerContext
  revalidatedTags: string[]
  /** Indicates if the application is using the new appDir */
  #appDir: boolean

  constructor(options: CacheHandlerContext) {
    this.#appDir = Boolean(options._appDir)
    this.options = options
    this.revalidatedTags = options.revalidatedTags
  }

  async get(...args: Parameters<CacheHandler['get']>): ReturnType<CacheHandler['get']> {
    const [cacheKey, ctx = {}] = args
    console.debug(`[NetlifyCacheHandler.get]: ${cacheKey}`)
    const blob = await this.getBlobKey(cacheKey, ctx.fetchCache)

    if (!blob) {
      return null
    }

    const revalidateAfter = this.calculateRevalidate(cacheKey, blob.lastModified)
    // first check if there is a tag manifest
    // if not => stale check with revalidateAfter
    // yes => check with manifest
    const isStale = revalidateAfter !== false && revalidateAfter < Date.now()
    console.debug(`!!! CHACHE KEY: ${cacheKey} - is stale: `, {
      isStale,
      revalidateAfter,
    })
    if (isStale) {
      return null
    }

    switch (blob.value.kind) {
      // TODO:
      // case 'ROUTE':
      // case 'FETCH':
      case 'PAGE':
        return {
          lastModified: blob.lastModified,
          value: {
            kind: 'PAGE',
            html: blob.value.html,
            pageData: blob.value.pageData,
            headers: blob.value.headers,
            status: blob.value.status,
          },
        }

      // default:
      // console.log('TODO: implmenet', blob)
    }
    return null
  }

  async set(...args: Parameters<IncrementalCache['set']>) {
    const [key, data, ctx] = args
    console.debug(`[NetlifyCacheHandler.set]: ${key}`)
    let cacheKey: string | null = null
    switch (data?.kind) {
      case 'FETCH':
        cacheKey = join('cache/fetch-cache', key)
        break
      case 'PAGE':
        cacheKey = join('server/app', key)
        break
      default:
        console.debug(`TODO: implement NetlifyCacheHandler.set for ${key}`, { data, ctx })
    }

    if (cacheKey) {
      await blobStore.setJSON(cacheKey, {
        lastModified: Date.now(),
        value: data,
      })
    }
  }

  async revalidateTag(tag: string) {
    console.debug('NetlifyCacheHandler.revalidateTag', tag)

    const data: TagManifest = {
      revalidatedAt: Date.now(),
    }

    try {
      await blobStore.setJSON(this.tagManifestPath(tag), data)
    } catch (error) {
      console.warn(`Failed to update tag manifest for ${tag}`, error)
    }

    purgeCache({ tags: [tag] })
  }

  // eslint-disable-next-line class-methods-use-this
  private tagManifestPath(tag: string) {
    return [tagsManifestPath, tag].join('/')
  }

  /**
   * Computes a cache key and tries to load it for different scenarios (app/server or fetch)
   * @param key The cache key used by next.js
   * @param fetch If it is a FETCH request or not
   * @returns the parsed data from the cache or null if not
   */
  private async getBlobKey(
    key: string,
    fetch?: boolean,
  ): Promise<
    | null
    | ({
        path: string
        isAppPath: boolean
      } & CacheEntryValue)
  > {
    const appKey = join('server/app', key)
    const pagesKey = join('server/pages', key)
    const fetchKey = join('cache/fetch-cache', key)

    if (fetch) {
      return await blobStore
        .get(fetchKey, { type: 'json' })
        .then((res) => (res !== null ? { path: fetchKey, isAppPath: false, ...res } : null))
    }

    // pagesKey needs to be requested first as there could be both sadly
    const values = await Promise.all([
      blobStore
        .get(pagesKey, { type: 'json' })
        .then((res) => ({ path: pagesKey, isAppPath: false, ...res })),
      // only request the appKey if the whole application supports the app key
      !this.#appDir
        ? Promise.resolve(null)
        : blobStore
            .get(appKey, { type: 'json' })
            .then((res) => ({ path: appKey, isAppPath: true, ...res })),
    ])

    // just get the first item out of it that is defined (either the pageRoute or the appRoute)
    const [cacheEntry] = values.filter(({ value }) => !!value)

    // TODO: set the cache tags based on the tag manifest once we have that
    // if (cacheEntry) {
    //   const cacheTags: string[] =
    //     cacheEntry.value.headers?.[NEXT_CACHE_TAGS_HEADER]?.split(',') || []
    //   const manifests = await Promise.all(
    //     cacheTags.map((tag) => blobStore.get(this.tagManifestPath(tag), { type: 'json' })),
    //   )
    //   console.log(manifests)
    // }

    return cacheEntry || null
  }

  /**
   * Retrieves the milliseconds since midnight, January 1, 1970 when it should revalidate for a path.
   */
  private calculateRevalidate(pathname: string, fromTime: number, dev?: boolean): number | false {
    // in development we don't have a prerender-manifest
    // and default to always revalidating to allow easier debugging
    if (dev) return Date.now() - 1_000

    // if an entry isn't present in routes we fallback to a default
    const { initialRevalidateSeconds } = prerenderManifest.routes[toRoute(pathname)] || {
      initialRevalidateSeconds: 0,
    }
    // the initialRevalidate can be either set to false or to a number (representing the seconds)
    const revalidateAfter: number | false =
      typeof initialRevalidateSeconds === 'number'
        ? initialRevalidateSeconds * 1_000 + fromTime
        : initialRevalidateSeconds

    return revalidateAfter
  }
}
