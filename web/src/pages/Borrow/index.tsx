import { Spinner } from '@heroui/react'
import { useNavigate } from 'react-router-dom'

import BackLink from '@/components/BackLink'
import { UiButton } from '@/components/ui/UiButton'
import UserBalances from '@/components/UserBalances'
import { WalletButton } from '@/components/WalletButton'
import { RoutePath } from '@/constants/routes'
import { useWallet } from '@/providers/wallet/useWallet'

import BorrowOverview from './components/BorrowOverview'
import YourBorrows from './components/YourBorrows'

export default function BorrowPage() {
  const navigate = useNavigate()
  const { backend, isReady, reconnecting } = useWallet()

  return (
    <div className='flex flex-col gap-6'>
      <BackLink />

      {(() => {
        if (isReady) {
          if (backend === 'apogee') {
            return (
              <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl p-12 text-center'>
                <div className='flex max-w-lg flex-col gap-2'>
                  <h2 className='text-h2'>Apogee lender preview</h2>
                  <p className='text-muted'>
                    This first Apogee integration supports accepting existing lending offers. Use a
                    local testnet wallet for borrower accounts and new borrow offers.
                  </p>
                </div>
                <UiButton variant='primary' onPress={() => navigate(RoutePath.Supply)}>
                  View supply offers
                </UiButton>
              </div>
            )
          }
          return (
            <div className='flex flex-col gap-8'>
              <UserBalances />
              <BorrowOverview />
              <YourBorrows />
            </div>
          )
        }

        if (reconnecting) {
          return (
            <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl p-12 text-center'>
              <Spinner size='md' />
              <p className='text-muted'>Reconnecting your wallet…</p>
            </div>
          )
        }

        return (
          <div className='bg-surface-secondary flex flex-col items-center gap-4 rounded-2xl p-12 text-center'>
            <p className='text-muted'>Connect your wallet to view your borrows.</p>
            <WalletButton />
          </div>
        )
      })()}
    </div>
  )
}
