use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn signer(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn near_key(k: &SigningKey) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, k.verifying_key().to_bytes().to_vec()).unwrap()
}

fn as_caller(who: &str) {
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).build());
}

/// Test-only coin for a player (the contract itself mints coin to players only as the starter purse).
fn give(m: &mut Market, who: &str, coin: u128) {
    m.mint(&acc(who), COIN, coin, "test");
}

/// Operator `op`, guild `guild.t` (200 c), merchants pema (5 c a pack, 4 c backing) and tomas (10 / 8),
/// player `kavi` with 25 coin; pema has 5 mangoes listed at 8.
fn market() -> Market {
    as_caller("op");
    let mut m = Market::new(acc("op"), acc("guild.t"), U128(200));
    m.add_merchant("pema".into(), acc("pema.t"), "loyal".into(), near_key(&signer(1)), U128(5), U128(4));
    m.add_merchant("tomas".into(), acc("tomas.t"), "gouger".into(), near_key(&signer(2)), U128(10), U128(8));
    m.register_player(acc("kavi"));
    m.operator_mint(acc("pema.t"), "mango".into(), U128(5), "harbor".into());
    as_caller("pema.t");
    m.list("mango".into(), U128(5), U128(8), None);
    m
}

fn bal(m: &Market, who: &str, t: &str) -> u128 {
    m.mt_balance_of(acc(who), t.into()).0
}

fn stall(m: &Market, id: &str) -> StallView {
    m.get_stalls().into_iter().find(|s| s.merchant == id).unwrap()
}

fn pending(m: &Market, who: &str, id: &str) -> (u128, u128) {
    let p = m.get_pending(acc(who)).into_iter().find(|p| p.merchant == id).unwrap();
    (p.coins.0, p.fraction.0)
}

fn assert_audit(m: &Market) {
    let a = m.audit();
    assert!(a.ok, "audit failed: custody {} ({} held, {} owed), stalls {:?}", a.custody_ok, a.contract_coin.0, a.reserves_and_vaults.0,
        a.stalls.iter().map(|s| (s.merchant.clone(), s.reserve_ok, s.vault_ok)).collect::<Vec<_>>());
}

/// Street shoppers buy `qty` mangoes at `unit` from a stall (minted first so the stall has them).
fn street(m: &mut Market, id: &str, qty: u128, unit: u128) {
    as_caller("op");
    m.operator_mint(acc(&format!("{id}.t")), "mango".into(), U128(qty), "harbor".into());
    m.street_sale(id.into(), "mango".into(), U128(qty), U128(unit));
}

// ---------- goods ----------

#[test]
fn buy_moves_coin_and_goods_and_emits_nep245() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(2), U128(8));
    assert_eq!(bal(&m, "kavi", "coin"), 25 - 16);
    assert_eq!(bal(&m, "kavi", "mango"), 2);
    assert_eq!(bal(&m, "pema.t", "coin"), 16);
    assert_eq!(bal(&m, "pema.t", "mango"), 3);
    let logs = get_logs();
    // coin and goods, then the sale's dividend into the vault and the stall's own shares' cut back to its till
    assert_eq!(logs.iter().filter(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"nep245\"") && l.contains("mt_transfer")).count(), 4);
    assert_eq!(m.get_offers()[0].qty.0, 3);
    assert_eq!(m.get_receipts(acc("kavi"))[0].kind, "bought");
    assert_eq!(m.get_revenue("pema".into()).0, 16);
}

#[test]
#[should_panic(expected = "price moved above your limit")]
fn buy_over_max_price_fails() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(1), U128(7));
}

#[test]
#[should_panic(expected = "quantity not on offer")]
fn buy_more_than_offered_fails() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(6), U128(8));
}

#[test]
#[should_panic(expected = "not enough coin")]
fn buy_without_coin_fails() {
    let mut m = market();
    as_caller("pema.t");
    m.list("mango".into(), U128(5), U128(20), None);
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(2), U128(20));
}

#[test]
#[should_panic(expected = "register first")]
fn unregistered_cannot_buy() {
    let mut m = market();
    as_caller("stranger");
    m.buy(acc("pema.t"), "mango".into(), U128(1), U128(8));
}

#[test]
#[should_panic(expected = "merchants only")]
fn player_cannot_list() {
    let mut m = market();
    as_caller("kavi");
    m.list("mango".into(), U128(1), U128(1), None);
}

#[test]
#[should_panic(expected = "cannot list this token")]
fn merchants_cannot_list_shares() {
    let mut m = market();
    as_caller("pema.t");
    m.list("share:pema".into(), U128(15), U128(1), Some(U128(15)));
}

#[test]
#[should_panic(expected = "operator only")]
fn player_cannot_mint() {
    let mut m = market();
    as_caller("kavi");
    m.operator_mint(acc("kavi"), "mango".into(), U128(1000), "cheat".into());
}

#[test]
#[should_panic(expected = "only goods can be minted")]
fn operator_cannot_mint_coin() {
    let mut m = market();
    as_caller("op");
    m.operator_mint(acc("kavi"), "coin".into(), U128(1000), "cheat".into());
}

#[test]
#[should_panic(expected = "operator only")]
fn player_cannot_settle() {
    let mut m = market();
    as_caller("kavi");
    m.settle_day(1, "pema".into());
}

#[test]
fn register_is_idempotent() {
    let mut m = market();
    as_caller("op");
    assert!(!m.register_player(acc("kavi")));
    assert_eq!(bal(&m, "kavi", "coin"), 25);
}

#[test]
#[should_panic(expected = "not enough mango")]
fn street_sale_cannot_exceed_stock() {
    let mut m = market();
    as_caller("op");
    m.street_sale("pema".into(), "mango".into(), U128(6), U128(2));
}

#[test]
fn sell_into_bid() {
    let mut m = market();
    as_caller("op");
    m.seed_till("tomas".into(), U128(50));
    m.operator_mint(acc("kavi"), "lemon".into(), U128(4), "found".into());
    as_caller("tomas.t");
    m.bid("lemon".into(), U128(3), U128(4), None);
    as_caller("kavi");
    m.sell(acc("tomas.t"), "lemon".into(), U128(3), U128(4));
    assert_eq!(bal(&m, "kavi", "lemon"), 1);
    assert_eq!(bal(&m, "kavi", "coin"), 25 + 12);
    assert_eq!(bal(&m, "tomas.t", "lemon"), 3);
    assert!(m.get_offers().iter().all(|o| o.side != "bid"));
}

#[test]
#[should_panic(expected = "till already opened")]
fn a_till_cannot_be_seeded_after_trading() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(2), U128(8));
    as_caller("op");
    m.operator_burn(acc("pema.t"), "coin".into(), U128(16), "spent".into()); // till back to 0
    m.seed_till("pema".into(), U128(50));
}

#[test]
#[should_panic(expected = "till already opened")]
fn a_till_is_seeded_once() {
    let mut m = market();
    as_caller("op");
    m.seed_till("tomas".into(), U128(50));
    m.seed_till("tomas".into(), U128(50));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn mt_transfer_needs_one_yocto() {
    let mut m = market();
    as_caller("kavi");
    m.mt_transfer(acc("pema.t"), "coin".into(), U128(1), None, None);
}

#[test]
fn mt_transfer_with_one_yocto() {
    let mut m = market();
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc("kavi")).attached_deposit(NearToken::from_yoctonear(1)).build());
    m.mt_transfer(acc("pema.t"), "coin".into(), U128(5), None, None);
    assert_eq!(bal(&m, "kavi", "coin"), 20);
}

// ---------- shares ----------

#[test]
fn investing_splits_the_price_between_reserve_and_till_and_sells_back_at_the_backing() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(30), U128(10)); // 2 packs at 5 c
    assert_eq!(bal(&m, "kavi", "share:pema"), 30);
    assert_eq!(bal(&m, "kavi", "coin"), 15);
    assert_eq!(bal(&m, "pema.t", "coin"), 2, "one coin per pack is working capital");
    let s = stall(&m, "pema");
    assert_eq!((s.reserve.0, s.treasury.0, s.supply.0, s.holders), (8, 270, 300, 1));
    assert_eq!(m.get_revenue("pema".into()).0, 0, "share money is capital, not revenue");
    assert_audit(&m);
    as_caller("kavi");
    m.sell(acc("pema.t"), "share:pema".into(), U128(15), U128(4));
    assert_eq!(bal(&m, "kavi", "coin"), 19);
    assert_eq!(stall(&m, "pema").reserve.0, 4);
    assert_eq!(stall(&m, "pema").treasury.0, 285, "sold shares go back on sale to the next partner");
    assert_audit(&m);
}

#[test]
fn a_partner_can_always_sell_back_even_when_the_till_is_empty_and_the_stall_closed() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(45), U128(15));
    as_caller("op");
    m.operator_burn(acc("pema.t"), "coin".into(), U128(3), "spoilage".into()); // till now 0
    assert!(!m.charge_rent(2, "pema".into(), U128(40), U128(10)));
    as_caller("kavi");
    m.sell(acc("pema.t"), "share:pema".into(), U128(45), U128(12));
    assert_eq!(bal(&m, "kavi", "coin"), 25 - 15 + 12);
    assert_audit(&m);
}

#[test]
fn shares_never_sell_out_new_packs_are_issued_on_the_same_terms() {
    let mut m = market();
    for i in 0..25 {
        let who = format!("p{i}");
        as_caller("op");
        m.register_player(acc(&who));
        as_caller(&who);
        m.buy(acc("pema.t"), "share:pema".into(), U128(15), U128(5));
    }
    let s = stall(&m, "pema");
    assert_eq!(s.supply.0, 375, "300 floated + 75 issued");
    assert_eq!(s.treasury.0, 0);
    assert_eq!(s.holders, 25);
    assert_eq!(s.reserve.0, 25 * 4);
    assert_audit(&m);
}

#[test]
#[should_panic(expected = "shares trade in packs of 15")]
fn shares_trade_in_whole_packs() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(10), U128(5));
}

#[test]
#[should_panic(expected = "share price moved above your limit")]
fn share_price_limit_holds() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(15), U128(4));
}

#[test]
#[should_panic(expected = "not enough share:pema")]
fn cannot_sell_shares_you_do_not_own() {
    let mut m = market();
    as_caller("kavi");
    m.sell(acc("pema.t"), "share:pema".into(), U128(15), U128(4));
}

#[test]
#[should_panic(expected = "stall shares are bought from and sold to the stall")]
fn shares_cannot_be_gifted_back_to_the_stall() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(15), U128(5));
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc("kavi")).attached_deposit(NearToken::from_yoctonear(1)).build());
    m.mt_transfer(acc("pema.t"), "share:pema".into(), U128(15), None, None);
}

// ---------- dividends ----------

#[test]
fn dividends_are_exact_and_fractions_carry() {
    let mut m = market();
    give(&mut m, "kavi", 100);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(75), U128(25)); // 25% of 300
    street(&mut m, "pema", 30, 2); // 60 revenue -> 30 declared -> 7.5 to kavi
    let before = bal(&m, "kavi", "coin");
    as_caller("op");
    let s = m.settle_day(1, "pema".into());
    assert_eq!((s.revenue.0, s.declared.0, s.funded.0, s.arrears.0), (60, 30, 30, 0));
    assert_eq!(pending(&m, "kavi", "pema"), (7, ACC_SCALE / 2), "7 coins and exactly half a coin owed");
    assert_eq!(bal(&m, "kavi", "coin"), before, "dividends are paid on the holder's next move or claim");
    assert_eq!(m.settle_day(1, "pema".into()).funded.0, 30, "settling a day twice returns the record");
    street(&mut m, "pema", 30, 2);
    as_caller("op");
    m.settle_day(2, "pema".into());
    assert_eq!(m.claim(acc("kavi")).0, 15, "7.5 + 7.5 = 15 exactly, nothing rounded away");
    assert_eq!(pending(&m, "kavi", "pema"), (0, 0));
    assert_eq!(bal(&m, "kavi", "coin"), before + 15);
    assert_audit(&m);
}

#[test]
fn the_basis_point_remainder_of_revenue_carries_to_the_next_day() {
    let mut m = market();
    street(&mut m, "pema", 1, 3); // 3 revenue -> 1.5 declared
    as_caller("op");
    assert_eq!(m.settle_day(1, "pema".into()).declared.0, 1);
    street(&mut m, "pema", 1, 3);
    as_caller("op");
    assert_eq!(m.settle_day(2, "pema".into()).declared.0, 2, "1.5 + 1.5 = 3 over two days");
}

#[test]
fn selling_shares_pays_the_dividend_earned_first() {
    let mut m = market();
    give(&mut m, "kavi", 100);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(150), U128(50)); // half the stall
    street(&mut m, "pema", 20, 3); // 60 revenue -> 30 declared -> 15 to kavi
    as_caller("op");
    m.settle_day(1, "pema".into());
    let before = bal(&m, "kavi", "coin");
    as_caller("kavi");
    m.sell(acc("pema.t"), "share:pema".into(), U128(150), U128(40));
    assert_eq!(bal(&m, "kavi", "coin"), before + 15 + 40, "dividend and buyback both paid");
    street(&mut m, "pema", 20, 3); // the next day's dividend belongs to whoever holds the shares then
    as_caller("op");
    m.settle_day(2, "pema".into());
    assert_eq!(pending(&m, "kavi", "pema"), (0, 0));
    assert_audit(&m);
}

#[test]
fn a_dividend_is_funded_at_the_sale_so_a_later_empty_till_cannot_strand_it() {
    let mut m = market();
    give(&mut m, "kavi", 300);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(300), U128(100)); // all of it; 20 c to the till
    street(&mut m, "pema", 20, 3); // 60 revenue: 30 c moves to the vault at the sale
    as_caller("op");
    let till = bal(&m, "pema.t", "coin");
    m.operator_burn(acc("pema.t"), "coin".into(), U128(till), "a bad week".into()); // till 0
    let s = m.settle_day(1, "pema".into());
    assert_eq!((s.revenue.0, s.declared.0, s.funded.0, s.arrears.0), (60, 30, 30, 0));
    assert_eq!(m.claim(acc("kavi")).0, 30, "every declared coin reached the only partner");
    assert_audit(&m);
}

#[test]
fn legacy_arrears_are_paid_first_from_the_next_sale() {
    let mut m = market();
    give(&mut m, "kavi", 300);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(300), U128(100));
    // arrears left by the old settlement rule (declared but unfunded): the next sale funds them first
    let mut st = m.stall("pema");
    st.arrears = 20;
    st.total_declared += 20;
    m.stalls.insert("pema".into(), st);
    as_caller("op");
    m.settle_day(1, "pema".into()); // the till (20 c from the investment) pays them now
    street(&mut m, "pema", 10, 3); // 30 revenue -> 15 declared
    as_caller("op");
    let s = m.settle_day(2, "pema".into());
    assert_eq!((s.declared.0, s.funded.0, s.arrears.0), (15, 15, 0));
    assert_eq!(m.claim(acc("kavi")).0, 35);
    assert_audit(&m);
}

// ---------- dividend sniping (revenue-event accrual) ----------

/// Kavi holds a quarter of Pema from the start; Rin buys most of the stall just before the day's settlement and sells
/// right after. Under revenue-event accrual Rin earned none of the day's sales: everything went to who held at each sale.
#[test]
fn buying_just_before_settlement_earns_nothing_already_sold() {
    let mut m = market();
    as_caller("op");
    m.register_player(acc("rin"));
    give(&mut m, "kavi", 100);
    give(&mut m, "rin", 1000);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(75), U128(25)); // 75 of 300
    street(&mut m, "pema", 30, 2); // 60 revenue -> 30 declared -> 7.5 to kavi
    let rin0 = bal(&m, "rin", "coin");
    as_caller("rin");
    m.buy(acc("pema.t"), "share:pema".into(), U128(225), U128(75)); // the rest of the float, right before settling
    as_caller("op");
    m.settle_day(1, "pema".into());
    as_caller("rin");
    m.sell(acc("pema.t"), "share:pema".into(), U128(225), U128(60));
    assert_eq!(bal(&m, "rin", "coin"), rin0 - 75 + 60, "the round trip costs the spread and earns no dividend");
    assert_eq!(pending(&m, "rin", "pema"), (0, 0));
    assert_eq!(pending(&m, "kavi", "pema"), (7, ACC_SCALE / 2), "kavi keeps the whole of what the stall earned");
    assert_audit(&m);
}

/// A holder who buys before a sale and sells right after earns exactly their share of that sale and nothing else.
#[test]
fn a_holder_earns_exactly_the_sales_made_while_holding() {
    let mut m = market();
    as_caller("op");
    m.register_player(acc("rin"));
    give(&mut m, "rin", 1000);
    street(&mut m, "pema", 10, 3); // 30 revenue before rin buys: none of it is rin's
    as_caller("rin");
    m.buy(acc("pema.t"), "share:pema".into(), U128(150), U128(50)); // half the stall
    let c0 = bal(&m, "rin", "coin");
    street(&mut m, "pema", 20, 2); // 40 revenue -> 20 declared -> 10 to rin
    as_caller("rin");
    m.sell(acc("pema.t"), "share:pema".into(), U128(150), U128(40));
    assert_eq!(bal(&m, "rin", "coin") - c0, 10 + 40, "half of that sale's 20 c, plus the 40 c backing");
    street(&mut m, "pema", 20, 2); // after selling: none of it is rin's
    as_caller("op");
    m.settle_day(1, "pema".into());
    assert_eq!(pending(&m, "rin", "pema"), (0, 0));
    assert_audit(&m);
}

/// Three holders, repeated buys and sells interleaved with sales over several days, against an exact integer model:
/// each holder is owed the sum over sales of floor(funded * K / supply) * balance at that sale.
#[test]
fn repeated_trades_between_sales_match_an_exact_model() {
    let mut m = market();
    let players = ["xx", "yy", "zz"];
    as_caller("op");
    for p in players {
        m.register_player(acc(p));
        give(&mut m, p, 2000);
    }
    let mut exact = [0u128; 3];
    let mut divs = [0u128; 3];
    // (who, packs: + buy / - sell, revenue units sold right after the trade)
    let plan: [(usize, i32, u128); 14] = [(0, 4, 7), (1, 2, 0), (2, 1, 9), (0, -2, 3), (1, 3, 11), (2, 2, 0), (0, 1, 5),
        (1, -5, 8), (2, -3, 13), (0, 6, 2), (1, 1, 17), (2, 4, 1), (0, -9, 6), (1, 2, 21)];
    for (k, (who, packs, sold)) in plan.iter().enumerate() {
        let p = players[*who];
        let before = bal(&m, p, COIN);
        as_caller(p);
        if *packs > 0 {
            let n = *packs as u128;
            m.buy(acc("pema.t"), "share:pema".into(), U128(n * PACK), U128(1000));
            divs[*who] += bal(&m, p, COIN) + n * 5 - before;
        } else {
            let n = (-*packs) as u128;
            m.sell(acc("pema.t"), "share:pema".into(), U128(n * PACK), U128(0));
            divs[*who] += bal(&m, p, COIN) - n * 4 - before;
        }
        if *sold > 0 {
            let funded0 = stall(&m, "pema").total_funded.0;
            let supply = stall(&m, "pema").supply.0;
            street(&mut m, "pema", *sold, 3);
            let funded = stall(&m, "pema").total_funded.0 - funded0;
            for (i, q) in players.iter().enumerate() {
                exact[i] += funded * ACC_SCALE * bal(&m, q, "share:pema") / supply;
            }
        }
        if k % 4 == 3 {
            as_caller("op");
            m.settle_day(k as u32, "pema".into());
        }
        assert_audit(&m);
    }
    for (i, p) in players.iter().enumerate() {
        let before = bal(&m, p, COIN);
        as_caller("op");
        m.claim(acc(p));
        divs[i] += bal(&m, p, COIN) - before;
        let (c, f) = pending(&m, p, "pema");
        assert_eq!(c, 0);
        let got = divs[i] * ACC_SCALE + f;
        let err = exact[i].abs_diff(got);
        assert!(err <= 14 * 1000, "holder {p}: got {got}, exact {}, diff {err} units of 1/K coin", exact[i]);
    }
}

/// A long-term holder of every share earns every declared coin of every sale, across days and a supply change.
#[test]
fn a_long_term_holder_earns_every_declared_coin() {
    let mut m = market();
    give(&mut m, "kavi", 1000);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(300), U128(100));
    let c0 = bal(&m, "kavi", "coin");
    for day in 1..=5u32 {
        street(&mut m, "pema", 7, 3); // 21 revenue a day -> 10.5 declared
        as_caller("op");
        m.settle_day(day, "pema".into());
    }
    as_caller("op");
    m.claim(acc("kavi"));
    let declared = stall(&m, "pema").total_declared.0;
    assert_eq!(declared, 52, "5 x 10.5 = 52.5: 52 declared, the half carried in basis points");
    assert_eq!(bal(&m, "kavi", "coin") - c0, 52, "the only partner received every declared coin");
    assert_audit(&m);
}

#[test]
fn issued_shares_earn_only_from_their_issue_on() {
    let mut m = market();
    as_caller("op");
    m.register_player(acc("aa"));
    m.register_player(acc("bb"));
    give(&mut m, "aa", 200);
    give(&mut m, "bb", 200);
    as_caller("aa");
    m.buy(acc("pema.t"), "share:pema".into(), U128(300), U128(100));
    street(&mut m, "pema", 30, 2); // 30 declared to a's 300 of 300
    as_caller("op");
    m.settle_day(1, "pema".into());
    as_caller("bb");
    m.buy(acc("pema.t"), "share:pema".into(), U128(300), U128(100)); // issued: supply 600
    street(&mut m, "pema", 30, 2); // 30 declared over 600: 15 each
    as_caller("op");
    m.settle_day(2, "pema".into());
    assert_eq!(m.claim(acc("aa")).0, 45);
    assert_eq!(m.claim(acc("bb")).0, 15);
    assert_audit(&m);
}

#[test]
fn there_is_no_shareholder_limit() {
    let mut m = market();
    for i in 0..300 {
        let who = format!("h{i}");
        as_caller("op");
        m.register_player(acc(&who));
        as_caller(&who);
        m.buy(acc("tomas.t"), "share:tomas".into(), U128(15), U128(10));
    }
    assert_eq!(stall(&m, "tomas").holders, 300);
    assert_eq!(stall(&m, "tomas").supply.0, 4500);
    street(&mut m, "tomas", 45, 2); // 90 revenue -> 45 declared over 4500 shares = 0.15 c per holder
    as_caller("op");
    m.settle_day(1, "tomas".into());
    assert_eq!(pending(&m, "h7", "tomas"), (0, ACC_SCALE * 15 / 100));
    assert_audit(&m);
}

#[test]
fn migration_carries_coins_shares_and_owed_fractions() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(15), U128(5)); // 1/20 of the stall
    street(&mut m, "pema", 10, 2); // 10 declared -> 0.5 owed
    as_caller("op");
    m.settle_day(1, "pema".into());
    m.register_player(acc("kavi.social"));
    m.migrate_player(acc("kavi"), acc("kavi.social"));
    assert_eq!(bal(&m, "kavi.social", "share:pema"), 15);
    assert_eq!(pending(&m, "kavi.social", "pema"), (0, ACC_SCALE / 2));
    assert_eq!(pending(&m, "kavi", "pema"), (0, 0));
    street(&mut m, "pema", 10, 2);
    as_caller("op");
    m.settle_day(2, "pema".into());
    assert_eq!(m.claim(acc("kavi.social")).0, 1, "the carried half plus the new half");
    assert_audit(&m);
}

/// Exact model in integers: every holder's dividends (paid coins * ACC_SCALE + carried fraction) equal the sum over
/// settlements of floor(funded * ACC_SCALE / supply) * balance, plus the accumulator's carried remainder, which is
/// worth less than one unit (1e-18 coin) per share per settlement.
#[test]
fn per_holder_dividends_equal_the_exact_pro_rata_share() {
    let mut m = market();
    let players = ["xx", "yy", "zz"];
    as_caller("op");
    for p in players {
        m.register_player(acc(p));
        give(&mut m, p, 1000);
    }
    let mut exact = [0u128; 3]; // in 1/ACC_SCALE coin, using exact rational funded * bal / supply (floored once)
    let mut divs = [0u128; 3];
    let plan: [(usize, i32); 9] = [(0, 4), (1, 2), (2, 1), (0, -2), (1, 3), (2, 2), (0, 1), (1, -5), (2, -3)];
    for (day, (who, packs)) in plan.iter().enumerate() {
        let p = players[*who];
        let before = bal(&m, p, COIN);
        as_caller(p);
        if *packs > 0 {
            let n = *packs as u128;
            m.buy(acc("pema.t"), "share:pema".into(), U128(n * PACK), U128(1000));
            divs[*who] += bal(&m, p, COIN) + n * 5 - before;
        } else {
            let n = (-*packs) as u128;
            m.sell(acc("pema.t"), "share:pema".into(), U128(n * PACK), U128(0));
            divs[*who] += bal(&m, p, COIN) - n * 4 - before;
        }
        street(&mut m, "pema", 7, 3); // 21 revenue
        let supply = stall(&m, "pema").supply.0;
        as_caller("op");
        let funded = m.settle_day(day as u32 + 1, "pema".into()).funded.0;
        for (i, q) in players.iter().enumerate() {
            exact[i] += funded * ACC_SCALE * bal(&m, q, "share:pema") / supply;
        }
    }
    for (i, p) in players.iter().enumerate() {
        let before = bal(&m, p, COIN);
        as_caller("op");
        m.claim(acc(p));
        divs[i] += bal(&m, p, COIN) - before;
        let (c, f) = pending(&m, p, "pema");
        assert_eq!(c, 0);
        let got = divs[i] * ACC_SCALE + f;
        let max_share = 600; // no holder ever had more shares than this
        let err = exact[i].abs_diff(got);
        assert!(err <= 9 * (max_share + 1), "holder {p}: got {got}, exact {}, diff {err} units of 1e-18 coin", exact[i]);
        assert!(divs[i] > 0, "every holder earned something");
    }
    assert_audit(&m);
}

/// Randomised accounting check: 2000 mixed moves (invest, sell back, street sales, settlements, rent) by 12
/// players over two stalls. After every move the audit holds (custody, reserves, vaults), and at the end the coin
/// supply equals all balances plus what the stalls burned in rent.
#[test]
fn randomised_ledger_keeps_every_invariant() {
    let mut m = market();
    let players: Vec<String> = (0..12).map(|i| format!("r{i}")).collect();
    as_caller("op");
    for p in &players {
        m.register_player(acc(p));
        give(&mut m, p, 500);
    }
    let mut seed: u64 = 0x5eed;
    let mut next = |n: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % n
    };
    let stalls = ["pema", "tomas"];
    let mut day = 0u32;
    for _ in 0..2000 {
        let p = players[next(players.len() as u64) as usize].clone();
        let id = stalls[next(2) as usize];
        let issuer = format!("{id}.t");
        let token = format!("share:{id}");
        match next(5) {
            0 => {
                let packs = next(3) as u128 + 1;
                let price = if id == "pema" { 5 } else { 10 } * packs;
                if bal(&m, &p, COIN) >= price {
                    as_caller(&p);
                    m.buy(acc(&issuer), token, U128(packs * PACK), U128(price));
                }
            }
            1 => {
                let own = bal(&m, &p, &token);
                if own >= PACK {
                    as_caller(&p);
                    m.sell(acc(&issuer), token, U128((next((own / PACK) as u64) as u128 + 1) * PACK), U128(0));
                }
            }
            2 => street(&mut m, id, next(20) as u128 + 1, next(5) as u128 + 1),
            3 => {
                as_caller("op");
                m.charge_rent(day, id.into(), U128(next(30) as u128), U128(3));
                if !stall(&m, id).open {
                    m.operator_mint(acc(&issuer), "mango".into(), U128(3), "harbor".into());
                }
            }
            _ => {
                day += 1;
                as_caller("op");
                for sid in stalls {
                    m.settle_day(day, sid.into());
                }
            }
        }
        assert_audit(&m);
    }
    as_caller("op");
    for p in &players {
        m.claim(acc(p));
    }
    for id in stalls {
        let s = stall(&m, id);
        assert!(s.vault.0 <= players.len() as u128 + 1, "the vault keeps only sub-coin fractions: {} left", s.vault.0);
        assert!(s.total_paid.0 > 0);
    }
    assert_audit(&m);
}

// ---------- rent, closures, guild ----------

#[test]
fn rent_is_burned_once_per_day() {
    let mut m = market();
    as_caller("op");
    m.seed_till("tomas".into(), U128(100));
    assert!(m.charge_rent(2, "tomas".into(), U128(40), U128(10)));
    assert!(m.charge_rent(2, "tomas".into(), U128(40), U128(10)));
    assert_eq!(bal(&m, "tomas.t", "coin"), 60);
    assert_eq!(m.mt_supply("coin".into()).unwrap().0, 200 + 25 + 60);
    assert_eq!(stall(&m, "tomas").last_rent, Some(2), "the relayer can see a day was charged");
    assert!(m.charge_rent(1, "tomas".into(), U128(40), U128(10)), "an older day is never charged after a newer one");
    assert_eq!(bal(&m, "tomas.t", "coin"), 60);
}

#[test]
fn unpaid_rent_closes_the_stall_until_deliveries_reopen_it() {
    let mut m = market();
    as_caller("op");
    assert!(!m.charge_rent(2, "pema".into(), U128(40), U128(4)));
    assert!(!stall(&m, "pema").open);
    m.operator_mint(acc("pema.t"), "mango".into(), U128(3), "harbor".into());
    assert!(!stall(&m, "pema").open);
    m.operator_mint(acc("pema.t"), "mango".into(), U128(1), "harbor".into());
    assert!(stall(&m, "pema").open, "reopened after 4 mangoes");
}

#[test]
#[should_panic(expected = "stall is closed")]
fn a_closed_stall_sells_nothing() {
    let mut m = market();
    as_caller("op");
    m.charge_rent(2, "pema".into(), U128(40), U128(4));
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(1), U128(8));
}

#[test]
fn the_guild_lends_only_what_it_holds_and_is_repaid_before_dues() {
    let mut m = market();
    as_caller("op");
    assert_eq!(m.guild_lend("pema".into(), U128(150)).0, 150);
    assert_eq!(m.guild_lend("tomas".into(), U128(150)).0, 50, "the fund only lends what it has");
    assert_eq!(m.guild_lend("tomas".into(), U128(10)).0, 0);
    assert_eq!(stall(&m, "pema").debt.0, 150);
    assert_eq!(m.audit().guild_lent.0, 200);
    let (repaid, dues) = m.guild_collect("pema".into(), U128(160), U128(200));
    assert_eq!((repaid.0, dues.0), (150, 0), "repayment first; dues only while the fund is below 200");
    assert_eq!(stall(&m, "pema").debt.0, 0);
    assert_eq!(bal(&m, "guild.t", "coin"), 150);
    let (repaid, dues) = m.guild_collect("tomas".into(), U128(80), U128(200));
    assert_eq!((repaid.0, dues.0), (50, 0));
    assert_eq!(m.mt_supply("coin".into()).unwrap().0, 200 + 25, "loans move coin, they never create it");
    // a fund that lost coin (e.g. a stall that never repays) is refilled by dues only up to its size, loans included
    m.guild_lend("pema".into(), U128(30));
    m.operator_burn(acc("guild.t"), "coin".into(), U128(20), "test loss".into()); // assets 150 + 30 = 180
    street(&mut m, "tomas", 50, 2); // tomas earns 100 c
    as_caller("op");
    let (repaid, dues) = m.guild_collect("tomas".into(), U128(50), U128(200));
    assert_eq!((repaid.0, dues.0), (0, 20), "dues stop where held + lent reaches 200");
    let (_, dues) = m.guild_collect("tomas".into(), U128(50), U128(200));
    assert_eq!(dues.0, 0);
}

// ---------- haggled deals ----------

/// Pema (signer 1) signs "kavi buys/sells `qty` mangoes at `price`"; returns the call arguments.
fn signed_deal(side: &str, qty: u128, price: u128, nonce: u64, key: &SigningKey) -> (U64, U64, Base64VecU8) {
    let expires = 10_000u64;
    let msg = deal_message(&env::current_account_id(), "pema", &acc("kavi"), side, "mango", qty, price, nonce, expires);
    (U64(nonce), U64(expires), Base64VecU8(key.sign(msg.as_bytes()).to_bytes().to_vec()))
}

#[test]
fn signed_deal_settles_at_haggled_price() {
    let mut m = market();
    as_caller("kavi");
    let (n, e, s) = signed_deal("buy", 2, 6, 1, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(2), U128(6), n, e, s);
    assert_eq!(bal(&m, "kavi", "coin"), 13);
    assert_eq!(bal(&m, "kavi", "mango"), 2);
    assert_eq!(bal(&m, "pema.t", "coin"), 12);
    assert_eq!(m.get_revenue("pema".into()).0, 12);
}

#[test]
fn player_sells_into_signed_deal() {
    let mut m = market();
    as_caller("op");
    m.seed_till("pema".into(), U128(30));
    m.operator_mint(acc("kavi"), "mango".into(), U128(4), "found".into());
    as_caller("kavi");
    let (n, e, s) = signed_deal("sell", 4, 5, 2, &signer(1));
    m.deal("pema".into(), "sell".into(), "mango".into(), U128(4), U128(5), n, e, s);
    assert_eq!(bal(&m, "kavi", "coin"), 45);
    assert_eq!(bal(&m, "pema.t", "mango"), 9);
}

#[test]
#[should_panic(expected = "merchant did not sign this deal")]
fn deal_with_wrong_signer_fails() {
    let mut m = market();
    as_caller("kavi");
    let (n, e, s) = signed_deal("buy", 2, 6, 1, &signer(9));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(2), U128(6), n, e, s);
}

#[test]
#[should_panic(expected = "merchant did not sign this deal")]
fn deal_with_changed_price_fails() {
    let mut m = market();
    as_caller("kavi");
    let (n, e, s) = signed_deal("buy", 2, 6, 1, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(2), U128(1), n, e, s);
}

#[test]
#[should_panic(expected = "deal already used")]
fn deal_cannot_be_replayed() {
    let mut m = market();
    as_caller("kavi");
    let (n, e, s) = signed_deal("buy", 1, 6, 7, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n, e, s.clone());
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n, e, s);
}

#[test]
#[should_panic(expected = "deal already used")]
fn an_older_deal_cannot_land_after_a_newer_one() {
    let mut m = market();
    as_caller("kavi");
    let (n2, e2, s2) = signed_deal("buy", 1, 6, 9, &signer(1));
    let (n1, e1, s1) = signed_deal("buy", 1, 6, 8, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n2, e2, s2);
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n1, e1, s1);
}

#[test]
#[should_panic(expected = "deal expired")]
fn expired_deal_fails() {
    let mut m = market();
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc("kavi")).block_timestamp(20_000 * 1_000_000).build());
    let (n, e, s) = signed_deal("buy", 1, 6, 1, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n, e, s);
}

#[test]
#[should_panic(expected = "stall is closed")]
fn a_closed_stall_signs_no_sales() {
    let mut m = market();
    as_caller("op");
    m.charge_rent(2, "pema".into(), U128(40), U128(4));
    as_caller("kavi");
    let (n, e, s) = signed_deal("buy", 1, 6, 1, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n, e, s);
}

// ---------- accounts ----------

#[test]
fn migrate_moves_everything_once() {
    let mut m = market();
    as_caller("kavi");
    m.buy(acc("pema.t"), "mango".into(), U128(2), U128(8));
    as_caller("op");
    m.register_player(acc("kavi.social"));
    assert_eq!(m.migrate_player(acc("kavi"), acc("kavi.social")), 2);
    assert_eq!(bal(&m, "kavi", "coin"), 0);
    assert_eq!(bal(&m, "kavi", "mango"), 0);
    assert_eq!(bal(&m, "kavi.social", "coin"), 25 + 9);
    assert_eq!(bal(&m, "kavi.social", "mango"), 2);
    assert_eq!(m.migrate_player(acc("kavi"), acc("kavi.social")), 0, "nothing left to move");
}

#[test]
#[should_panic(expected = "operator only")]
fn player_cannot_migrate_others() {
    let mut m = market();
    as_caller("kavi");
    m.migrate_player(acc("pema.t"), acc("kavi"));
}

#[test]
#[should_panic(expected = "merchant accounts cannot migrate")]
fn merchants_cannot_be_migrated() {
    let mut m = market();
    as_caller("op");
    m.migrate_player(acc("pema.t"), acc("kavi"));
}

#[test]
fn per_player_storage_is_bounded() {
    // A fresh context resets the mock's storage counter, so carry it across contexts; and near_sdk::store caches
    // writes until flushed, so flush before every reading.
    let mut usage = 0u64;
    let ctx = |who: &str, usage: u64| testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).storage_usage(usage).build());
    let flush = |m: &mut Market| {
        m.balances.flush();
        m.supply.flush();
        m.receipts.flush();
        m.deal_nonces.flush();
        m.stalls.flush();
        m.positions.flush();
    };
    let mut m = market();
    let who = "s0000000000000000.bunnyy-nearworld.testnet";
    ctx("op", usage);
    flush(&mut m);
    usage = env::storage_usage();
    m.register_player(acc(who));
    flush(&mut m);
    let registered = env::storage_usage() - usage;
    give(&mut m, who, 1000);
    flush(&mut m);
    usage = env::storage_usage();
    let start = usage - registered;
    let mut after_20 = 0;
    for i in 0..40 {
        ctx(who, usage);
        m.buy(acc("pema.t"), "share:pema".into(), U128(15), U128(5));
        m.sell(acc("pema.t"), "share:pema".into(), U128(15), U128(4));
        flush(&mut m);
        usage = env::storage_usage();
        if i == 9 {
            after_20 = usage - start;
        }
    }
    ctx(who, usage);
    m.buy(acc("pema.t"), "share:pema".into(), U128(15), U128(5));
    m.buy(acc("tomas.t"), "share:tomas".into(), U128(15), U128(10));
    flush(&mut m);
    let total = env::storage_usage() - start;
    println!("storage per player: {registered} B registered, {after_20} B after 20 trades, {total} B after 82 trades in two stalls");
    // after the log is full, only the second stall's holding (balance + checkpoint) is new
    assert!(total <= after_20 + 1_000, "storage stops growing once the receipt log is full (receipts capped at {MAX_RECEIPTS})");
    assert!(total < 6_000, "per-player storage must stay bounded, got {total}");
}

/// The one-off upgrade (`--features upgrade`): revenue earned under the old rule (declared only at settlement) is
/// declared and accrued once, so no coin a holder already earned is lost in the switch.
#[cfg(feature = "upgrade")]
#[test]
fn upgrade_adopts_revenue_earned_before_the_switch() {
    let mut m = market();
    give(&mut m, "kavi", 100);
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(150), U128(50)); // half
    // simulate the old contract: 40 c of revenue in the till, recorded but not declared yet
    m.mint(&acc("pema.t"), COIN, 40, "old sales");
    let mut st = m.stall("pema");
    st.revenue = 40;
    m.stalls.insert("pema".into(), st);
    testing_env!(VMContextBuilder::new().predecessor_account_id(env::current_account_id()).build());
    let adopted = m.adopt_pending_revenue();
    assert_eq!(adopted.iter().find(|(id, _)| id == "pema").unwrap().1 .0, 40);
    assert_eq!(pending(&m, "kavi", "pema"), (10, 0), "half of the 20 c declared");
    as_caller("op");
    let s = m.settle_day(1, "pema".into());
    assert_eq!((s.revenue.0, s.declared.0, s.funded.0), (40, 20, 20), "the day's record still shows it");
    assert_audit(&m);
}
