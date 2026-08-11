import { env } from '@/constants/env'
import { normalizeHex } from '@/utils/hex'

import { requestJson, type RequestParams } from '../client'
import {
  type BorrowerOverview,
  borrowerOverviewSchema,
  type FactoryDetails,
  factoryDetailsSchema,
  factoryListSchema,
  type LenderOverview,
  lenderOverviewSchema,
  type OfferDetails,
  offerDetailsSchema,
  type OfferListResponse,
  offerListResponseSchema,
  type OfferShort,
  type OffersOverview,
  offersOverviewSchema,
  type OfferStatus,
} from './schemas'

function buildOfferUrl(offerId: string, suffix = ''): string {
  return `${env.VITE_API_URL}/offers/${encodeURIComponent(offerId)}${suffix}`
}

function buildSearchUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString()
  return query ? `${env.VITE_API_URL}${path}?${query}` : `${env.VITE_API_URL}${path}`
}

function normalizeWalletScripts(scriptPubkeys: readonly string[]): string[] {
  return [...new Set(scriptPubkeys.map(normalizeHex).filter(Boolean))].sort()
}

export type SortDir = 'asc' | 'desc'

export type SortField =
  | 'created_at_height'
  | 'collateral_amount'
  | 'principal_amount'
  | 'interest_rate'
  | 'loan_expiration_height'

export interface ListOffersParams {
  status?: OfferStatus | OfferStatus[]
  factoryId?: string
  collateralAsset?: string
  principalAsset?: string
  excludeParticipantScript?: string
  notExpired?: boolean
  limit?: number
  offset?: number
  sortBy?: SortField
  sortDir?: SortDir
}

export type OfferFilters = Omit<ListOffersParams, 'limit' | 'offset' | 'sortBy' | 'sortDir'>

export const OFFERS_PAGE_LIMIT = 100

export async function fetchAllOfferPages(
  fetchPage: (params: ListOffersParams) => Promise<OfferListResponse>,
  baseParams: ListOffersParams = {},
): Promise<OfferShort[]> {
  const first = await fetchPage({ ...baseParams, limit: OFFERS_PAGE_LIMIT, offset: 0 })
  const items = [...first.items]
  while (items.length < first.total) {
    const next = await fetchPage({ ...baseParams, limit: OFFERS_PAGE_LIMIT, offset: items.length })
    if (next.items.length === 0) break
    items.push(...next.items)
  }
  return items
}

export function toQueryParams(params: ListOffersParams): Record<string, string> {
  const q: Record<string, string> = {}
  if (params.status) {
    q.status = Array.isArray(params.status) ? params.status.join(',') : params.status
  }
  if (params.factoryId) q.factory_id = params.factoryId
  if (params.collateralAsset) q.collateral_asset = params.collateralAsset
  if (params.principalAsset) q.principal_asset = params.principalAsset
  if (params.excludeParticipantScript) {
    q.exclude_participant_script = normalizeHex(params.excludeParticipantScript)
  }
  if (params.notExpired) q.not_expired = 'true'
  if (params.limit !== undefined) q.limit = String(params.limit)
  if (params.offset !== undefined) q.offset = String(params.offset)
  if (params.sortBy) q.sort_by = params.sortBy
  if (params.sortDir) q.sort_dir = params.sortDir
  return q
}

export async function fetchOffers(
  params: ListOffersParams = {},
  options: RequestParams = {},
): Promise<OfferListResponse> {
  return requestJson(buildSearchUrl('/offers', toQueryParams(params)), offerListResponseSchema, {
    signal: options.signal,
  })
}

export async function fetchOffer(
  offerId: string,
  options: RequestParams = {},
): Promise<OfferDetails> {
  return requestJson(buildOfferUrl(offerId), offerDetailsSchema, { signal: options.signal })
}

export async function fetchOffersOverview(options: RequestParams = {}): Promise<OffersOverview> {
  return requestJson(`${env.VITE_API_URL}/offers/overview`, offersOverviewSchema, {
    signal: options.signal,
  })
}

export async function fetchBorrowerOverview(
  scriptPubkeyHex: string,
  options: RequestParams = {},
): Promise<BorrowerOverview> {
  const url = buildSearchUrl('/borrowers/overview', {
    script_pubkey: normalizeHex(scriptPubkeyHex),
  })
  return requestJson(url, borrowerOverviewSchema, { signal: options.signal })
}

export async function fetchBorrowerOverviewByScripts(
  scriptPubkeys: readonly string[],
  options: RequestParams = {},
): Promise<BorrowerOverview> {
  const scripts = normalizeWalletScripts(scriptPubkeys)
  const overviews = await Promise.all(scripts.map(script => fetchBorrowerOverview(script, options)))
  const sumAssets = (field: 'collateral_locked' | 'borrowings') => {
    const totals = new Map<string, bigint>()
    for (const overview of overviews) {
      for (const entry of overview[field]) {
        totals.set(entry.asset, (totals.get(entry.asset) ?? 0n) + entry.amount)
      }
    }
    return [...totals].map(([asset, amount]) => ({ asset, amount }))
  }
  return {
    collateral_locked: sumAssets('collateral_locked'),
    borrowings: sumAssets('borrowings'),
    active_loans: overviews.reduce((sum, overview) => sum + overview.active_loans, 0),
    pending_offers: overviews.reduce((sum, overview) => sum + overview.pending_offers, 0),
  }
}

export async function fetchBorrowerOffers(
  scriptPubkeyHex: string,
  params: ListOffersParams = {},
  options: RequestParams = {},
): Promise<OfferListResponse> {
  const url = buildSearchUrl('/borrowers/offers', {
    script_pubkey: normalizeHex(scriptPubkeyHex),
    ...toQueryParams(params),
  })
  return requestJson(url, offerListResponseSchema, { signal: options.signal })
}

export async function fetchBorrowerOffersByScripts(
  scriptPubkeys: readonly string[],
  params: ListOffersParams = {},
  options: RequestParams = {},
): Promise<OfferListResponse> {
  const scripts = normalizeWalletScripts(scriptPubkeys)
  const unpaged = { ...params, limit: undefined, offset: undefined }
  const pages = await Promise.all(
    scripts.map(script =>
      fetchAllOfferPages(page => fetchBorrowerOffers(script, page, options), unpaged),
    ),
  )
  const unique = [...new Map(pages.flat().map(offer => [offer.id, offer])).values()]
  unique.sort((a, b) => compareOffers(a, b, params))
  const offset = params.offset ?? 0
  const limit = params.limit ?? OFFERS_PAGE_LIMIT
  return { items: unique.slice(offset, offset + limit), total: unique.length, limit, offset }
}

export async function fetchLenderOverview(
  scriptPubkeys: readonly string[],
  options: RequestParams = {},
): Promise<LenderOverview> {
  const scripts = normalizeWalletScripts(scriptPubkeys)
  if (scripts.length === 0) throw new Error('At least one lender script pubkey is required')
  const overviews = await Promise.all(
    scripts.map(script => {
      const url = buildSearchUrl('/lenders/overview', { script_pubkey: script })
      return requestJson(url, lenderOverviewSchema, { signal: options.signal })
    }),
  )
  const sumAssets = (field: 'supplied_loans' | 'interest_outstanding') => {
    const totals = new Map<string, bigint>()
    for (const overview of overviews) {
      for (const entry of overview[field]) {
        totals.set(entry.asset, (totals.get(entry.asset) ?? 0n) + entry.amount)
      }
    }
    return [...totals].map(([asset, amount]) => ({ asset, amount }))
  }
  return {
    supplied_loans: sumAssets('supplied_loans'),
    interest_outstanding: sumAssets('interest_outstanding'),
    active_loans: overviews.reduce((sum, overview) => sum + overview.active_loans, 0),
    to_be_claimed: overviews.reduce((sum, overview) => sum + overview.to_be_claimed, 0),
  }
}

export async function fetchLenderOffers(
  scriptPubkeys: readonly string[],
  params: ListOffersParams = {},
  options: RequestParams = {},
): Promise<OfferListResponse> {
  const scripts = normalizeWalletScripts(scriptPubkeys)
  if (scripts.length === 0) throw new Error('At least one lender script pubkey is required')
  const unpaged = { ...params, limit: undefined, offset: undefined }
  const pages = await Promise.all(
    scripts.map(script =>
      fetchAllOfferPages(page => fetchLenderOffersForScript(script, page, options), unpaged),
    ),
  )
  const unique = [...new Map(pages.flat().map(offer => [offer.id, offer])).values()]
  unique.sort((a, b) => compareOffers(a, b, params))
  const offset = params.offset ?? 0
  const limit = params.limit ?? OFFERS_PAGE_LIMIT
  return { items: unique.slice(offset, offset + limit), total: unique.length, limit, offset }
}

async function fetchLenderOffersForScript(
  scriptPubkey: string,
  params: ListOffersParams,
  options: RequestParams,
): Promise<OfferListResponse> {
  const url = buildSearchUrl('/lenders/offers', {
    script_pubkey: scriptPubkey,
    ...toQueryParams(params),
  })
  return requestJson(url, offerListResponseSchema, { signal: options.signal })
}

export async function fetchFactoriesByScript(
  scriptPubkeyHex: string,
  options: RequestParams = {},
): Promise<FactoryDetails[]> {
  const url = buildSearchUrl('/factories/by-script', {
    script_pubkey: normalizeHex(scriptPubkeyHex),
  })
  return requestJson(url, factoryListSchema, { signal: options.signal })
}

export async function fetchFactoriesByScripts(
  scriptPubkeys: readonly string[],
  options: RequestParams = {},
): Promise<FactoryDetails[]> {
  const scripts = normalizeWalletScripts(scriptPubkeys)
  const lists = await Promise.all(scripts.map(script => fetchFactoriesByScript(script, options)))
  return [...new Map(lists.flat().map(factory => [factory.id, factory])).values()]
}

function compareOffers(a: OfferShort, b: OfferShort, params: ListOffersParams): number {
  const field = params.sortBy ?? 'created_at_height'
  const direction = params.sortDir === 'asc' ? 1 : -1
  const left = a[field]
  const right = b[field]
  const order = left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)
  return order * direction
}

export async function fetchFactory(
  factoryId: string,
  options: RequestParams = {},
): Promise<FactoryDetails> {
  return requestJson(
    `${env.VITE_API_URL}/factories/${encodeURIComponent(factoryId)}`,
    factoryDetailsSchema,
    { signal: options.signal },
  )
}
