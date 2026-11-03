// What Vmake offers, its prices and the balance, known before Vmake is asked (main keeps them in
// vmake-account.json), and whether there's a token: read as the app starts, so Remove text and
// Dub open ready. A check asks Vmake and keeps what it says.

import type { ServiceError, VmakeAccount } from '../shared/api'

let account: VmakeAccount | null = null
let hasToken: boolean | null = null
window.studio.services
  .vmakeKnown()
  .then((a) => (account ??= a))
  .catch(() => {})
window.studio.services
  .keys()
  .then((k) => (hasToken ??= k.vmake))
  .catch(() => {})

export const vmakeKnown = () => account
export const vmakeHasToken = () => hasToken

/** Asks Vmake for the account (prices, balance, any new model); a rejected token is remembered. */
export async function vmakeCheck(): Promise<VmakeAccount | ServiceError> {
  const r = await window.studio.services.vmakeAccount()
  if ('error' in r) {
    if (r.auth) hasToken = false
  } else {
    account = r
    hasToken = true
  }
  return r
}

export function vmakeTokenSet(set: boolean) {
  hasToken = set
}
