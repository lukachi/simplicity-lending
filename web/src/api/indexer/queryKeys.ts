import { normalizeHex } from '@/utils/hex'

import { type ListOffersParams, toQueryParams } from './methods'

export const offersQueryKeys = {
  all: () => ['offers'] as const,
  lists: () => ['offers', 'list'] as const,
  list: (params: ListOffersParams) => ['offers', 'list', toQueryParams(params)] as const,
  detail: (offerId: string) => ['offers', 'detail', offerId] as const,
  overview: () => ['offers', 'overview'] as const,
} as const

export const borrowerQueryKeys = {
  all: () => ['borrower'] as const,
  overview: (scriptPubkeyHex: string) =>
    ['borrower', 'overview', normalizeHex(scriptPubkeyHex)] as const,
  offers: (scriptPubkeyHex: string, params: ListOffersParams = {}) =>
    ['borrower', 'offers', normalizeHex(scriptPubkeyHex), toQueryParams(params)] as const,
  overviewByScripts: (scriptPubkeys: readonly string[]) =>
    ['borrower', 'overview', normalizeScriptSet(scriptPubkeys)] as const,
  offersByScripts: (scriptPubkeys: readonly string[], params: ListOffersParams = {}) =>
    ['borrower', 'offers', normalizeScriptSet(scriptPubkeys), toQueryParams(params)] as const,
} as const

export const lenderQueryKeys = {
  all: () => ['lender'] as const,
  overview: (scriptPubkeys: readonly string[]) =>
    ['lender', 'overview', normalizeScriptSet(scriptPubkeys)] as const,
  offers: (scriptPubkeys: readonly string[], params: ListOffersParams = {}) =>
    ['lender', 'offers', normalizeScriptSet(scriptPubkeys), toQueryParams(params)] as const,
} as const

function normalizeScriptSet(scriptPubkeys: readonly string[]): string[] {
  return [...new Set(scriptPubkeys.map(normalizeHex).filter(Boolean))].sort()
}

export const factoryQueryKeys = {
  all: () => ['factories'] as const,
  byScript: (scriptPubkeyHex: string) =>
    ['factories', 'by-script', normalizeHex(scriptPubkeyHex)] as const,
  byScripts: (scriptPubkeys: readonly string[]) =>
    ['factories', 'by-script', normalizeScriptSet(scriptPubkeys)] as const,
  detail: (factoryId: string) => ['factories', 'detail', factoryId] as const,
} as const
