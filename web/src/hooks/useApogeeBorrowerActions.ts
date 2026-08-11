import type { OfferDetails } from '@/api/indexer/schemas'
import { useApogeeManifestAction } from '@/hooks/useApogeeManifestAction'
import type { FactoryState } from '@/hooks/useBorrowerAccount'
import {
  buildCancelOfferManifestInvocation,
  buildClaimPrincipalManifestInvocation,
  buildCreateFactoryManifestInvocation,
  buildCreateOfferManifestInvocation,
  buildRepayLoanManifestInvocation,
} from '@/simplicity/lending/apogee'

export function useApogeeBorrowerActions() {
  const { execute } = useApogeeManifestAction()

  return {
    enableBorrowing: () =>
      execute({
        attemptId: 'enable-borrowing',
        attemptKind: 'create-factory',
        buildInvocation: buildCreateFactoryManifestInvocation,
        trackedOutputIndex: 0,
      }),
    createOffer: (input: {
      factory: FactoryState
      collateralAssetId: string
      collateralAmount: bigint
      principalAssetId: string
      principalAmount: bigint
      principalInterestRate: number
      loanExpirationHeight: number
      protocolFeeKeeperAssetId: string
    }) =>
      execute({
        attemptId: [
          'create-offer',
          input.factory.factoryAssetId,
          input.collateralAssetId,
          input.collateralAmount,
          input.principalAssetId,
          input.principalAmount,
          input.principalInterestRate,
          input.loanExpirationHeight,
          input.protocolFeeKeeperAssetId,
        ].join(':'),
        attemptKind: 'create-offer',
        buildInvocation: identity =>
          buildCreateOfferManifestInvocation({
            ...identity,
            factoryAssetId: input.factory.factoryAssetId,
            factoryAuthOutpoint: input.factory.factoryAuthOutpoint,
            issuanceFactoryOutpoint: input.factory.issuanceFactoryOutpoint,
            collateralAssetId: input.collateralAssetId,
            collateralAmount: input.collateralAmount,
            principalAssetId: input.principalAssetId,
            principalAmount: input.principalAmount,
            principalInterestRate: input.principalInterestRate,
            loanExpirationHeight: input.loanExpirationHeight,
            protocolFeeKeeperAssetId: input.protocolFeeKeeperAssetId,
          }),
        trackedOutputIndex: 2,
      }),
    claimPrincipal: (offer: OfferDetails) =>
      execute({
        attemptId: offer.id,
        attemptKind: 'claim-principal',
        buildInvocation: identity => buildClaimPrincipalManifestInvocation({ ...identity, offer }),
        trackedOutputIndex: 0,
        trackedAssetId: offer.borrower_nft_asset.toLowerCase(),
      }),
    cancelOffer: (offer: OfferDetails) =>
      execute({
        attemptId: offer.id,
        attemptKind: 'cancel-offer',
        buildInvocation: identity => buildCancelOfferManifestInvocation({ ...identity, offer }),
      }),
    repayLoan: (offer: OfferDetails) =>
      execute({
        attemptId: offer.id,
        attemptKind: 'repay-loan',
        buildInvocation: identity => buildRepayLoanManifestInvocation({ ...identity, offer }),
      }),
  }
}
