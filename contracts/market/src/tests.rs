use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use ed25519_dalek::{Signer, SigningKey};
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

/// Operator `op`, merchant pema (`pema.t`) with 5 mangoes listed at 8, player `kavi` with 25 coin.
fn market() -> Market {
    as_caller("op");
    let mut m = Market::new(acc("op"));
    m.add_merchant("pema".into(), acc("pema.t"), "loyal".into(), near_key(&signer(1)));
    m.add_merchant("tomas".into(), acc("tomas.t"), "gouger".into(), near_key(&signer(2)));
    m.register_player(acc("kavi"));
    m.operator_mint(acc("pema.t"), "mango".into(), U128(5), "harbor".into());
    as_caller("pema.t");
    m.list("mango".into(), U128(5), U128(8));
    m
}

fn bal(m: &Market, who: &str, t: &str) -> u128 {
    m.mt_balance_of(acc(who), t.into()).0
}

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
    assert_eq!(logs.iter().filter(|l| l.starts_with("EVENT_JSON:") && l.contains("\"standard\":\"nep245\"") && l.contains("mt_transfer")).count(), 2);
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
    m.list("mango".into(), U128(5), U128(20));
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
    m.list("mango".into(), U128(1), U128(1));
}

#[test]
#[should_panic(expected = "operator only")]
fn player_cannot_mint() {
    let mut m = market();
    as_caller("kavi");
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
fn invest_then_settle_pays_dividend_once() {
    let mut m = market();
    // Pema floats 20 shares; Kavi buys 5 (25%) at 1 coin, then buys 5 mangoes (40 coin revenue).
    as_caller("pema.t");
    m.list("share:pema".into(), U128(5), U128(1));
    as_caller("op");
    m.operator_mint(acc("kavi"), "coin".into(), U128(100), "test".into());
    as_caller("kavi");
    m.buy(acc("pema.t"), "share:pema".into(), U128(5), U128(1));
    m.buy(acc("pema.t"), "mango".into(), U128(5), U128(8));
    assert_eq!(m.get_revenue("pema".into()).0, 40, "share sales are capital, not revenue");
    as_caller("op");
    m.operator_mint(acc("pema.t"), "mango".into(), U128(10), "harbor".into());
    m.street_sale("pema".into(), "mango".into(), U128(10), U128(2));
    assert_eq!(m.get_revenue("pema".into()).0, 60);
    let before = bal(&m, "kavi", "coin");
    let s = m.settle_day(1, "pema".into());
    // pool = 60 * 50% = 30; Kavi's 5/20 = 7 (7.5 rounded down); Pema keeps the rest.
    assert_eq!(s.pool.0, 30);
    assert_eq!(s.paid.0, 7);
    assert_eq!(bal(&m, "kavi", "coin"), before + 7);
    let again = m.settle_day(1, "pema".into());
    assert_eq!(again.paid.0, 7);
    assert_eq!(bal(&m, "kavi", "coin"), before + 7, "settling the same day twice pays once");
    assert_eq!(m.get_revenue("pema".into()).0, 0);
    assert_eq!(m.get_settlements("pema".into(), 1, 5).len(), 1);
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
    m.operator_mint(acc("tomas.t"), "coin".into(), U128(50), "seed".into());
    m.operator_mint(acc("kavi"), "lemon".into(), U128(4), "found".into());
    as_caller("tomas.t");
    m.bid("lemon".into(), U128(3), U128(4));
    as_caller("kavi");
    m.sell(acc("tomas.t"), "lemon".into(), U128(3), U128(4));
    assert_eq!(bal(&m, "kavi", "lemon"), 1);
    assert_eq!(bal(&m, "kavi", "coin"), 25 + 12);
    assert_eq!(bal(&m, "tomas.t", "lemon"), 3);
    assert!(m.get_offers().iter().all(|o| o.side != "bid"));
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

/// Pema (signer 1) signs "kavi buys 2 mangoes at 6"; returns the call arguments.
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
    m.operator_mint(acc("pema.t"), "coin".into(), U128(30), "seed".into());
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
#[should_panic(expected = "deal expired")]
fn expired_deal_fails() {
    let mut m = market();
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc("kavi")).block_timestamp(20_000 * 1_000_000).build());
    let (n, e, s) = signed_deal("buy", 1, 6, 1, &signer(1));
    m.deal("pema".into(), "buy".into(), "mango".into(), U128(1), U128(6), n, e, s);
}

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
