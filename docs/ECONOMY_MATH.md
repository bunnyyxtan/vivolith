# VIVOLITH: Economy Math (contract v3, 2026-11-09)

Every rule below runs in `contracts/market/src/lib.rs` on NEAR testnet (`market.bunnyy-nearworld.testnet`), not in
the browser. The offline simulation (`src/economy/sim.ts`) mirrors the same rules for fast-forward forecasts. Coin is
an in-game token with no monetary value.

Anyone can question these numbers: section 7 lists the public views and scripts that check them on live state.

## 1. Units and parameters

| Symbol | Value | Where |
|---|---|---|
| `FLOAT` | 300 shares per stall at launch | `lib.rs` |
| `PACK` | 15 shares; shares only move in whole packs | `lib.rs` |
| `P`, `R` | pack price and pack backing per stall: Pema 5/4, Tomas 10/8, Mira 10/8, Arin 5/4 coins | `sim.ts` `SHARE_PACK`, set once by `add_merchant` |
| `MAX_PACKS` | 20 packs per transaction | `lib.rs` |
| `BPS` | dividend rate 5,000 basis points (50% of revenue) | `DIVIDEND_BPS` |
| `K` | accumulator scale 720,720 × 10^18 | `ACC_SCALE` |
| Starter purse | 40 coins per registered player, once per account | `STARTER_COIN` (contract), `STARTER_COINS` (`state.ts`) |
| Guild fund | 200 coins, minted once at `new` | `handlers.ts` `GUILD_FUND` |
| Market day | 10 real minutes | `MARKET_DAY_MS` |

All arithmetic is integer (`u128`, overflow-checked). Nothing is ever rounded away. Every division's remainder is stored
and carried forward, as shown below.

## 2. Where coin comes from and where it goes

| Source (mint) | Sink (burn) | Transfers (no change in supply) |
|---|---|---|
| Starter purse (registration) | Rent (`charge_rent`) | Trades, haggled deals |
| Street shoppers' payments (`street_sale`) | Harbor freight, 2 c a mango (Tomas) | Investing and selling back |
| Opening tills (`seed_till`, once per merchant before any activity) | Spoilage (`operator_burn`) | Dividends, Guild loans and repayments |
| Guild fund (once, at `new`) | | |

`operator_mint` can create only goods, never coin. The contract refuses to burn shares or the contract's own
custody balance. Coin supply is exactly the mints minus the burns, readable at any time with `mt_supply("coin")`.

### The starter purse

- **Who gets it:** every new account. `register_player` mints `STARTER_COIN` (40 c) on NEAR the first time an account
  joins the market, and never again for that account. A reload, Continue or New Game reuses the account and mints
  nothing (verified on testnet 2026-11-09: coin supply unchanged by repeated `guest`/`register` calls).
- **Why 40 c:** the first day costs about 12 c for three mangoes at the newcomer price (the delivery earns 18 c back),
  9 to 15 c for the haggle purchase, and 5 c for a pack of Pema shares. 40 c covers all of that with room left for a
  pack at a 10 c stall, so a new player never runs dry before their first profit. Accounts registered before the
  change keep their 25 c history; nothing was re-granted.
- **Where it comes from:** the purse is new coin, like street shoppers' payments. It never comes from a merchant till
  or the Guild fund, so onboarding cannot drain either.
- **Abuse limits** (relayer):
  - Only accounts the relayer itself created (`g…`/`s…`) can register.
  - A new account counts against a per-address limit of 5 an hour (repeats and refused attempts do not count).
  - A signed-in account can absorb at most 3 guests' progress per 30 days. Guests cannot transfer coin themselves
    (their keys are limited to buy, sell and deal).
- **Signing in keeps one purse:**
  - A guest that signs in with a new email or Google identity moves into that identity's account in one atomic
    transaction (register, move, burn the new account's own purse). The coin supply is unchanged (checked by
    `scripts/near/link-check.ts`).
  - An identity that already has an account takes in a guest only with the player's explicit consent. The merge then
    burns up to one purse (40 c) of the guest's coin.
- **Ceiling on farming:** 5 accounts × 40 c = 200 c of in-game coin per address per hour, with no monetary value.
  Merging it into one account is capped at 120 c a month.

## 3. Shares: reserve-backed, never sold out

Each stall holds its unsold shares (its *treasury*, `T`). Total supply is `S`. Partners hold `S − T`.

**Buying `n` packs** (`buy`, share token):
- The partner pays `n·P`.
- `n·R` goes to the stall's reserve, which the contract holds.
- `n·(P − R)` goes to the stall's till as working capital, not revenue.
- Shares come from the treasury first. Any shortfall is minted as a *new issue* on the same terms.

**Selling `n` packs back** (`sell`): the partner receives exactly `n·R` from the reserve. The shares return to the
treasury and go back on sale.

**Invariant (reserve):** `reserve · PACK = R · (S − T)`.

*Proof.* At founding `S = T = 300` and the reserve is 0. A purchase raises `S − T` by `n·PACK` and the reserve by
`n·R`. A sale lowers both by the same amounts. A new issue raises `S`, not `T`, so it also raises `S − T` by the amount
issued, within the same purchase. Share transfers (`mt_transfer`) move whole packs between partners only: the contract
refuses transfers from or to the issuing stall. Every move therefore preserves the equality. ∎

**Consequences:**
- A sale back can never fail for lack of funds. The till's state, rent and closure do not matter.
- No holder is ever forced out. There is no idle buyout and no holder cap.
- Investing never sells out. The spread `P − R` is the cost of a round trip, and dividends are the return.

## 4. Dividends: revenue-event accrual

Per stall, the contract keeps the day's revenue `V`, the basis-point remainder `ρ`, arrears `A`, the accumulator
`acc`, its remainder `α`, and the vault. Per holder and stall, it keeps a checkpoint `cp` and a carry `c` (owed
fraction, in 1/K coin).

**At every sale** (`accrue`: a street sale, a posted buy, a signed deal or a merchant buying from a merchant), the
coins `r` have just reached the till:
```
units     = r·BPS + ρ
declared  = ⌊units / 10000⌋            ρ ← units mod 10000          V += r
due       = declared + A
funded    = min(due, till)              A ← due − funded
vault    += funded                      (moved from the till to the contract)
acc      += ⌊(funded·K + α) / S⌋        α ← (funded·K + α) mod S     (S = the share supply at that moment)
```
The till has just received `r ≥ declared`, so a sale always funds its own dividend. Arrears exist only from before
this rule (section 9) and are paid first from the next sale.

**Settlement** (`settle_day`, at most once per day per stall) moves no dividend. It retries any arrears and records
the day: revenue `V`, declared `⌊(V·BPS + ρ_start)/10000⌋` (exactly the sum of the per-sale declarations, because
remainders carry), funded, and arrears. Then `V ← 0`.

**What a holder is owed:** `owed = b·(acc − cp) + c` (in 1/K coin), where `b` is the holder's balance. Before *any*
change to `b` (buy, sell, transfer, account link), the contract pays `⌊owed/K⌋` whole coins from the vault, then sets
`cp ← acc` and `c ← owed mod K`. A holder's own trades also claim, and `claim` pays on request.

**Properties:**

1. **A holder earns from exactly the sales made while they held.** `acc` rises only at a sale, and a holder's
   checkpoint is reset before every balance change. So a holder's total is `Σ over sales i of b_i · funded_i / S_i`,
   with `b_i` their balance at sale `i`, in proportion to their actual ownership during the earning period.
   - Buying just before a settlement earns nothing that was sold earlier.
   - Selling just after a sale keeps that sale's share.
   - There is no snapshot to snipe.
2. **No dividend is lost on sale.** A sale of shares changes `b`, so whatever the old balance earned is paid first.
3. **No fraction is lost.**
   - `ρ` carries the declaration's fraction.
   - `α` carries the accumulator's division remainder.
   - `c` carries each holder's sub-coin fraction.
   Because `K = 720720·10^18` is divisible by every supply of the form 15·n where n's prime factors are all ≤ 13 (300,
   315, 330, 360, 450, 4500, ...), an accrual over such a supply is exact. Otherwise the remainder waits in `α` for
   the next sale.
4. **No new holder earns retroactively.** A first credit sets `cp = acc`, so newly issued shares earn only from their
   issue on.
5. **The vault is always solvent.**
   - At each sale, the shares in existence add up to `S`, so all holders together are credited at most
     `⌊(funded·K+α)/S⌋·S ≤ funded·K + α` units.
   - Each payout is the floor of what a holder is owed.
   - So total payouts never exceed `total_funded`, and `vault = total_funded − total_paid ≥ 0`.
   - The leftover is only the sub-coin fractions still owed: at most about one coin per holder.
6. **Constant cost.** A sale touches no holder list, so its gas cost is the same for 1 or 1,000,000 holders. Each
   holder's checkpoint is O(1) storage per stall held. No new state fields were needed for this rule.

The stall's own treasury shares earn like any other holder. That cut returns to the till within the same sale, so only
partners' shares take coin out of the stall.

## 5. Rent, closure, reopening, Guild

- **Rent** (`charge_rent(day, …)`): charged at most once per stall per day (`last_rent`, readable in `get_stalls`). If
  the till covers the rent, it is burned. If not, the stall closes with a reopening target of `need` mangoes, fixed at
  closing. A closed stall sells nothing and pays no rent.
- **Reopening:** every mango delivered to a closed stall counts: a player's sale, a signed deal, a merchant purchase or
  a harbor delivery. The stall opens the moment `delivered ≥ need`.
- **Guild:**
  - `guild_lend` moves coin from the fund to a stall and records it as `debt`. It never lends more than the fund holds.
  - `guild_collect` takes repayment first. It then takes dues only while `fund held + all loans outstanding` is below
    200.
  - The Guild never mints after its seed. Its assets cannot grow past 200 through dues.
  - The relayer lends whenever a till is under 18 c (one tutorial delivery), or under a closed stall's whole reopening
    cost, and collects from tills above 80 c.

## 6. Merchant behaviour (relayer, every market turn)

The relayer reads every balance and stall from chain, then runs the shared rules in `src/economy/pricing.ts` (one
readable file, with the reasons shown in game):
- Merchants post asks and bids with their own keys, priced from stock, demand, cash pressure and reputation.
- Merchants fill each other's bids.
- Street shoppers buy at the posted price. Demand is elastic to price.
- The tea kitchen turns 1 mango into 4 lassi.
- The harbor refills Tomas: once a market day when he is below his normal stock, and on any turn he has fewer than 6
  mangoes. He pays 2 c a mango, as far as his till allows.

A player's haggled price must be signed by the merchant, within 55% to 150% of the posted price. Deal nonces only
increase per merchant and player, so a signed deal is single-use with O(1) storage.

## 7. How to check it yourself

| Check | How |
|---|---|
| Custody and reserves, live | `audit()`: `custody_ok` (contract coin = Σ reserves + vaults), `reserve_ok` per stall, `vault_ok` (vault = funded − paid), `ok` |
| Any holder's owed dividends | `get_pending(account_id)`: whole coins plus fraction |
| Stall accounts | `get_stalls()`: supply, treasury, reserve, vault, arrears, debt, lifetime declared/funded/paid, last rent/settlement day |
| Recent settlements | `get_settlements(merchant)` (last 24) |
| Everything above, from public RPC | `node scripts/near/verify.mjs` |
| Every rule, under test | `cargo test --features upgrade` in `contracts/market` (55 tests): buying just before settlement earns nothing already sold; a holder earns exactly the sales made while holding; repeated trades between sales against an exact integer model; a long-term holder receives every declared coin; issuance; 300 holders; a randomized 2,000-move ledger with `audit` after every move; bounded storage; the upgrade's adoption of pending revenue |
| Real transactions | `node scripts/near/e2e.ts`: fresh accounts, refused trades that move nothing, invest/sell back, settle and claim, a sniping attempt (buy before settlement, sell after: spread only, no dividend) next to a long-term holder whose dividend accrued at the sales, `audit` after each step |

## 8. Known limits (stated, not hidden)

- **Arrears** from before section 9 are distributed over the supply at the time they are funded, not when they were
  declared. The rule in section 4 never creates new ones.
- **Guild surplus.** Before dues were bounded by assets, the Guild collected 21 c more than its 200 c size (on
  2026-11-09). It is not lent out beyond its holdings and it stops further dues. It stays in the fund.
- **Storage.** About 0.2 KB to register a player, and at most about 5.1 KB per active player (20 receipts, holdings in
  two stalls), measured in the unit tests. The relayer pays for it from the contract's NEAR balance. Mainnet would
  need a storage deposit per player.

## 9. The switch to revenue-event accrual (2026-11-09, no reset)

Until 2026-11-09 the contract declared dividends at settlement, over whoever held shares at that moment. That let a
player buy just before a settlement and sell just after. The live contract was switched in place by
`scripts/near/upgrade-accrual.ts`, with no new state fields and no reset. ONE transaction from the contract account:

1. Deploy the `--features upgrade` build.
2. Call `adopt_pending_revenue`, which declares and accrues the revenue earned since the last settlement under the old
   rule, once, over the shares held then.
3. Deploy the real build.

The three actions run in one receipt, so either all of them happen or none do, and no sale can land between them.

The script checked:
- the code hash before (`AJpMw5…`) and after;
- that every non-coin balance and every player's coin were unchanged;
- that `audit` held afterwards;
- that every partner was owed at least what the old rule would have paid.

Transaction: https://testnet.nearblocks.io/txns/FSAk796nxz1SC3YcqbmeJiXPLUzCuXUxzyRHAcKmNZLW
