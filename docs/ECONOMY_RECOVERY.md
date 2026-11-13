# Economic recovery: why the market deadlocked and how it recovers

Measured with `node src/economy/recovery.check.ts` (the market model `src/economy/turn.ts` replays the relayer's market
turn step for step; every run checks that coins now = coins at start + minted − burned). Complements ECONOMY_MATH.md.

## Where coin comes from and where it goes (contract `contracts/market`)

| Flow | Kind |
|---|---|
| Street shoppers (`street_sale`) | **enters** (minted to the stall) |
| Starter purse per new player, a stall's opening till (once) | **enters** |
| Rent (`charge_rent`), harbor freight (`operator_burn`) | **leaves** (burned) |
| Trades, deals, residents' sales and meals, Guild loans and repayments, dividends, share purchases and buybacks | moves between accounts |

`operator_mint` can create goods only, never coin.

## What failed (testnet, 2026-11-13: Pema, Tomas, Mira closed, Guild 0 c)

1. **Street shoppers bought no fruit on chain.** Each turn sold `floor(demand per turn)`; a fruit stall's demand per
   turn is under one unit, so it rounded to 0 every time. Six healthy market days, old rules: **0** fruit, 183 lassi
   sold to shoppers. Only Arin earned; the fruit stalls paid rent from nothing and closed.
2. **The Guild could never refill.** Dues are capped at `fill_to − (fund + loans)`. Loans to stalls that then closed
   still counted, so once 221 c were out the fund stayed at 0 even while Arin held 400 c.
3. **Repayment only above 80 c.** Tills that pay 30–40 c rent every two market days rarely get there.
4. **No limit on rescue loans per stall** (Pema owes 163 c).
5. **A reopened stall met rent at once** with an empty till and closed again.
6. **Residents never sold to a closed stall**, although the contract lets anyone sell into its reopen bid (that is how
   deliveries reopen it), and a closed stall bid more than it could pay (Pema: 5 c with 1 c).

Inactivity is not a cause: with nobody playing no turn runs, so no rent is charged and nothing compounds.

## The recovery rules (`src/economy/recovery.ts`, used by the relayer and the model)

| Rule | Bound |
|---|---|
| Shoppers' fractional demand carries between turns | an empty shelf keeps at most one pending buyer |
| A closed stall bids only what its till can pay (`pricing.ts`) | no bid at all with an empty till |
| Residents may sell into a closed stall's funded bid (`residents.ts`) | only funded quantities |
| Repayment from any till above rent + 10 c | at most 10 c per stall per market day, once a day |
| No new loan once a stall owes 120 c | the Guild never lends more than it holds (contract) |
| Dues may rebuild the fund past loans owed by closed stalls (`fill_to` = 200 + those loans) | those loans stay on the books; nothing is written off |
| One rent waived after a reopening, if the till cannot pay | once per reopening, within 2 market days |

No new coin source was added: recovery comes from shoppers' real demand reaching the fruit stalls again, and from
players, residents and the Guild moving existing coin.

## Measured outcomes (10 turns per market day)

- Live deadlock, old rules, 8 days: nobody reopens; Arin closes too. New rules: Arin reopens (one rent grace) and earns;
  the Guild refills from his dues (0 → 31 c) and lends to Tomas and Mira, who stay one delivery short because Lin sells
  to the best bid (Arin's).
- Same deadlock with little play (2 turns a day), 10 days: all four reopen at some point, and Pema, Tomas and Mira each
  close again once; the market fails and recovers on its own.
- The player's choice on the live deadlock: delivering 1 mango to Pema at the only price she can pay (1 c) gives her a
  funded bid within 5 turns, and after 6 days all four stalls are open, Pema's debt is 142 c (from 163) and the Guild
  holds 19 c. Selling to Arin for 6 c instead leaves Pema, Tomas and Arin closed. Profit pays the player 5 c more now.
- Pema with 0 c and an empty Guild: nothing happens without help. A player who invests 25 c (5 packs: 20 c into her
  share reserve, 5 c working capital) reopens her; she closes again 6 days later with 17 c: recovery is possible, not
  guaranteed.
- A 60 c debt is repaid at most 10 c a day while she earns, and she borrows again (up to 120 c) when her till runs low.
- Dev (porter) earns nothing: nobody posts a lemon bid when Pema is closed. Limited purchasing power is real.

## Consignment: why it is not in this version

Consignment needs two legs: goods to the stall now, coin to the player later. The first is possible today (the
operator burns the player's goods and mints them to the stall in one transaction, which also counts toward reopening).
The second is not: the contract has no operator path that moves coin from a stall to a player (only trades, dividends,
share buybacks and the Guild), and `operator_mint` cannot create coin. Paying a consignor would need a contract upgrade,
for example operator-only `consign_in(merchant, player, token, qty, unit)` that moves the goods and records the amount
owed on chain, and `consign_pay(merchant, player, amount)` that pays at most the amount owed and only from a till above
its rent. The contract toolchain on this machine does not build at the moment (`near_sdk` unresolved), so that upgrade
cannot be built or tested here.

The executable alternative uses what the contract already has:

- **Delivering at the broke stall's affordable bid** (1 c for Pema): the player gives up the better price elsewhere.
- **Investing** (shares): the price goes to the stall, the backing into its reserve, and the player is repaid from real
  revenue as dividends, with the backing refundable on demand. This is equity, not consignment: the return depends on
  the business, and the player's loss is bounded by the share price above its backing.
