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
| Starter purse | 25 coins per registered player | `STARTER_COIN` |
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

## 4. Dividends: exact accumulator

Per stall, the contract keeps revenue `V`, the basis-point remainder `ρ`, arrears `A`, the accumulator `acc`, its
remainder `α`, and the vault. Per holder and stall, it keeps a checkpoint `cp` and a carry `c` (owed fraction, in 1/K
coin).

**Settlement for a day** (`settle_day`, at most once per day per stall):
```
units     = V·BPS + ρ
declared  = ⌊units / 10000⌋            ρ ← units mod 10000          V ← 0
due       = declared + A
funded    = min(due, till)              A ← due − funded            (arrears are paid first next time)
vault    += funded                      (moved from the till to the contract)
acc      += ⌊(funded·K + α) / S⌋        α ← (funded·K + α) mod S
```

**What a holder is owed:** `owed = b·(acc − cp) + c` (in 1/K coin), where `b` is the holder's balance. Before *any*
change to `b` (buy, sell, transfer, account link), the contract pays `⌊owed/K⌋` whole coins from the vault, then sets
`cp ← acc` and `c ← owed mod K`. A holder's own trades also claim, and `claim` pays on request.

**Properties:**

1. **No dividend is lost on sale.** A sale changes `b`, so whatever the old balance earned is paid first.
2. **No fraction is lost.**
   - `ρ` carries the declaration's fraction.
   - `α` carries the accumulator's division remainder.
   - `c` carries each holder's sub-coin fraction.
   - Arrears carry anything the till could not fund.
   Because `K = 720720·10^18` is divisible by every supply of the form 15·n where n's prime factors are all ≤ 13 (300,
   315, 330, 360, 450, 4500, ...), a settlement over such a supply is exact. Otherwise the remainder waits in `α` and
   is distributed at a later settlement.
3. **No new holder earns retroactively.** A first credit sets `cp = acc`, so newly issued shares earn only from their
   issue on.
4. **The vault is always solvent.**
   - The shares in existence at a settlement add up to `S`, so all holders together are credited at most
     `⌊(funded·K+α)/S⌋·S ≤ funded·K + α` units. The undistributed remainder `α` is carried and never credited twice.
   - Each payout is the floor of what a holder is owed. The fraction stays in the vault as that holder's carry.
   - So total payouts never exceed `total_funded`, and `vault = total_funded − total_paid ≥ 0`.
   - The leftover is only the sub-coin fractions still owed: at most about one coin per holder.
5. **Constant cost.** Settlement touches no holder list, so its gas cost is the same for 1 or 1,000,000 holders. Each
   holder's checkpoint is O(1) storage per stall held.

The stall's own treasury shares earn like any other holder. That cut is returned to the till immediately, so only
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
| Every rule, under test | `cargo test` in `contracts/market` (49 tests): exact pro rata with integer model, arrears, issuance, 300 holders, a randomized 2,000-move ledger with `audit` after every move, bounded storage |
| Real transactions | `node scripts/near/e2e.ts`: fresh accounts, refused trades that move nothing, invest/sell back, settle and claim, `audit` after each step |

## 8. Known limits (stated, not hidden)

- **Snapshot dividends.** A day's dividend goes to whoever holds at settlement time. Buying `N` shares just before and
  selling them just after costs the spread `(P − R)·N/15` and earns `pool·N/(S+N)`. The round trip pays only when
  `pool > (P − R)·(S + N)/15`.
  - Pema and Arin have a 1 c spread, so the break-even pool is above 20 c at S = 300.
  - Tomas and Mira have a 2 c spread, so it is above 40 c.
  - Measured live on 2026-11-09 (`verify.mjs`, last settlements): pools of Pema 17, Tomas 30, Mira 21 and Arin 32 c a
    market day.
  - So only Arin is above break-even. The best case there is about +1.4 c a market day: 75 shares earn 6.4 c and
    cost 5 c of spread.
  - Time-weighted dividends would remove the gap, at the cost of per-holder history. A 2 c spread at Arin would also
    close it, but pack terms are fixed when a stall is founded.
- **Arrears** are distributed over the supply at the time they are funded, not when they were declared.
- **Guild surplus.** Before dues were bounded by assets, the Guild collected 21 c more than its 200 c size (on
  2026-11-09). It is not lent out beyond its holdings and it stops further dues. It stays in the fund.
- **Storage.** About 0.2 KB to register a player, and at most about 5.1 KB per active player (20 receipts, holdings in
  two stalls), measured in the unit tests. The relayer pays for it from the contract's NEAR balance. Mainnet would
  need a storage deposit per player.
