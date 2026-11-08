//! VIVOLITH market contract: one NEP-245 multi-token ledger for the game.
//!
//! Token ids: `coin` (in-game coin, no monetary value), goods `mango` / `lemon` / `lassi`, and
//! `share:<merchant>` (300 shares per stall). Game moves are zero-deposit methods so players can sign them
//! with function-call keys (which cannot attach the 1 yocto `mt_transfer` needs); every move emits the
//! standard NEP-245 `mt_transfer` / `mt_mint` / `mt_burn` events. Every check runs before the receipt
//! ends, and a panic reverts the whole receipt, so a failed trade never grants goods.
//!
//! The market's rules live here, not in each player's browser: rent is charged per market day and a stall that
//! cannot pay closes (it sells nothing until deliveries restock it), shares trade at exact rational prices
//! ("`price` coins per `per` shares") with a standing buyback, and dividends carry their fractions forward.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, CurveType, PanicOnDefault, PublicKey};

pub const COIN: &str = "coin";
pub const GOODS: [&str; 3] = ["mango", "lemon", "lassi"];
pub const SHARES_PER_STALL: u128 = 300;
/// v1 stalls floated 20 shares; `migrate` splits every holding 15 for 1 (same ownership, same value).
pub const SHARE_SPLIT: u128 = 15;
const OLD_SHARES_PER_STALL: u128 = 20;
/// A shareholder with no trade for this long may be bought out at the stall's posted buyback price, so stalls
/// whose shares all sit with players who left can sell to new partners again (see `redeem_idle`).
pub const IDLE_MS: u64 = 24 * 60 * 60 * 1000;
pub const STARTER_COIN: u128 = 25;
/// Bounded so `settle_day` always fits in gas (one transfer per holder).
pub const MAX_HOLDERS: usize = 64;
pub const MAX_RECEIPTS: usize = 20;
/// Share of a day's goods revenue a stall pays out to its shareholders.
pub const DIVIDEND_BPS: u128 = 5_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Merchant {
    pub id: String,
    pub account_id: AccountId,
    /// Human-readable trading personality (the rules themselves run off-chain in src/economy/pricing.ts).
    pub rule: String,
    /// The merchant's ed25519 key that signs haggled deals (`deal`); same key as its function-call key.
    pub deal_key: PublicKey,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub struct Order {
    pub qty: U128,
    pub price: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Receipt {
    pub kind: String,
    pub token_id: String,
    pub qty: U128,
    pub price: U128,
    pub counterparty: AccountId,
    pub block_height: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Settlement {
    pub day: u32,
    pub merchant: String,
    pub revenue: U128,
    /// Coins set aside for shareholders (DIVIDEND_BPS of revenue, capped by the merchant's coin).
    pub pool: U128,
    pub paid: U128,
}

/// A merchant's standing order for its own stall's shares at an exact rational price: `price` coins buy `per`
/// shares, and quantities move in whole multiples of `per` (so no coin is ever rounded away).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub struct ShareOrder {
    pub qty: U128,
    pub price: U128,
    pub per: U128,
}

#[near(serializers = [json])]
pub struct ShareOfferView {
    pub merchant: String,
    pub side: String,
    pub qty: U128,
    pub price: U128,
    pub per: U128,
}

/// A stall that missed rent: closed until `delivered` reaches `need` mangoes (deliveries only count up).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub struct Closure {
    pub since_day: u32,
    pub need: U128,
    pub delivered: U128,
}

#[near(serializers = [json])]
pub struct StallStatus {
    pub merchant: String,
    pub open: bool,
    pub since_day: Option<u32>,
    pub need: U128,
    pub delivered: U128,
    pub holders: u32,
}

#[near(serializers = [json])]
pub struct OfferView {
    pub merchant: String,
    pub account_id: AccountId,
    pub token_id: String,
    pub side: String,
    pub qty: U128,
    pub price: U128,
}

#[near(serializers = [json])]
pub struct Token {
    pub token_id: String,
    pub owner_id: Option<AccountId>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Market {
    operator: AccountId,
    merchants: Vec<Merchant>,
    balances: LookupMap<(String, AccountId), u128>,
    supply: LookupMap<String, u128>,
    players: LookupSet<AccountId>,
    asks: LookupMap<(AccountId, String), Order>,
    bids: LookupMap<(AccountId, String), Order>,
    holders: LookupMap<String, Vec<AccountId>>,
    revenue: LookupMap<String, u128>,
    settlements: LookupMap<(String, u32), Settlement>,
    receipts: LookupMap<AccountId, Vec<Receipt>>,
    used_deals: LookupSet<(AccountId, u64)>,
    // v2
    share_asks: LookupMap<String, ShareOrder>,
    share_bids: LookupMap<String, ShareOrder>,
    /// Dividend fractions owed per (share token, holder), in 1/SHARES_PER_STALL coin.
    dust: LookupMap<(String, AccountId), u128>,
    closures: LookupMap<String, Closure>,
    rent_days: LookupSet<(String, u32)>,
    last_active: LookupMap<AccountId, u64>,
    /// When v2 began: holders who never traded since count as active from here.
    since_ms: u64,
}

/// The v1 state layout, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct MarketV1 {
    pub operator: AccountId,
    pub merchants: Vec<Merchant>,
    pub balances: LookupMap<(String, AccountId), u128>,
    pub supply: LookupMap<String, u128>,
    pub players: LookupSet<AccountId>,
    pub asks: LookupMap<(AccountId, String), Order>,
    pub bids: LookupMap<(AccountId, String), Order>,
    pub holders: LookupMap<String, Vec<AccountId>>,
    pub revenue: LookupMap<String, u128>,
    pub settlements: LookupMap<(String, u32), Settlement>,
    pub receipts: LookupMap<AccountId, Vec<Receipt>>,
    pub used_deals: LookupSet<(AccountId, u64)>,
}

fn share_token(merchant: &str) -> String {
    format!("share:{merchant}")
}

fn is_good(token: &str) -> bool {
    GOODS.contains(&token)
}

fn valid_id(id: &str) -> bool {
    (2..=16).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase())
}

/// The exact bytes a merchant signs to agree to a haggled deal (the relayer builds the same string).
#[allow(clippy::too_many_arguments)]
pub fn deal_message(contract: &AccountId, merchant: &str, player: &AccountId, side: &str, token: &str, qty: u128, unit_price: u128, nonce: u64, expires_ms: u64) -> String {
    format!("vivolith-deal|{contract}|{merchant}|{player}|{side}|{token}|{qty}|{unit_price}|{nonce}|{expires_ms}")
}

fn emit(event: &str, data: Value) {
    let ev = json!({ "standard": "nep245", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{ev}"));
}

#[near]
impl Market {
    #[init]
    pub fn new(operator: AccountId) -> Self {
        Self {
            operator,
            merchants: Vec::new(),
            balances: LookupMap::new(b"b"),
            supply: LookupMap::new(b"s"),
            players: LookupSet::new(b"p"),
            asks: LookupMap::new(b"a"),
            bids: LookupMap::new(b"d"),
            holders: LookupMap::new(b"h"),
            revenue: LookupMap::new(b"r"),
            settlements: LookupMap::new(b"t"),
            receipts: LookupMap::new(b"c"),
            used_deals: LookupSet::new(b"u"),
            share_asks: LookupMap::new(b"x"),
            share_bids: LookupMap::new(b"y"),
            dust: LookupMap::new(b"z"),
            closures: LookupMap::new(b"k"),
            rent_days: LookupSet::new(b"n"),
            last_active: LookupMap::new(b"l"),
            since_ms: env::block_timestamp_ms(),
        }
    }

    /// v1 -> v2, run once in the same transaction as the code upgrade (a second call cannot read v1 state and
    /// fails). Every stall's shares split 15 for 1: each holder's balance and the supply are multiplied, so every
    /// ownership percentage is unchanged; the split is minted with NEP-245 events. Refuses to run unless each
    /// stall's holder list adds up exactly to its 20-share supply. Open share asks move to the new share book at
    /// the identical price (old price per share = same price per 15 new shares).
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let v1: MarketV1 = env::state_read().expect("no v1 state");
        let mut m = Self {
            operator: v1.operator,
            merchants: v1.merchants,
            balances: v1.balances,
            supply: v1.supply,
            players: v1.players,
            asks: v1.asks,
            bids: v1.bids,
            holders: v1.holders,
            revenue: v1.revenue,
            settlements: v1.settlements,
            receipts: v1.receipts,
            used_deals: v1.used_deals,
            share_asks: LookupMap::new(b"x"),
            share_bids: LookupMap::new(b"y"),
            dust: LookupMap::new(b"z"),
            closures: LookupMap::new(b"k"),
            rent_days: LookupSet::new(b"n"),
            last_active: LookupMap::new(b"l"),
            since_ms: env::block_timestamp_ms(),
        };
        for merchant in m.merchants.clone() {
            let token = share_token(&merchant.id);
            let holders = m.holders.get(&token).cloned().unwrap_or_default();
            let supply = m.supply.get(&token).copied().unwrap_or(0);
            let sum: u128 = holders.iter().map(|h| m.bal(&token, h)).sum();
            require!(supply == OLD_SHARES_PER_STALL && sum == supply, format!("{token} ledger does not add up; nothing migrated"));
            for h in holders {
                let b = m.bal(&token, &h);
                m.balances.insert((token.clone(), h.clone()), b * SHARE_SPLIT);
                emit("mt_mint", json!({ "owner_id": h, "token_ids": [token], "amounts": [(b * (SHARE_SPLIT - 1)).to_string()], "memo": "15-for-1 share split" }));
            }
            m.supply.insert(token.clone(), supply * SHARE_SPLIT);
            if let Some(o) = m.asks.remove(&(merchant.account_id.clone(), token)) {
                m.share_asks.insert(merchant.id.clone(), ShareOrder { qty: U128(o.qty.0 * SHARE_SPLIT), price: o.price, per: U128(SHARE_SPLIT) });
            }
        }
        m
    }

    // ---------- operator (the game relayer) ----------

    pub fn add_merchant(&mut self, id: String, account_id: AccountId, rule: String, deal_key: PublicKey) {
        self.only_operator();
        require!(valid_id(&id), "bad merchant id");
        require!(deal_key.curve_type() == CurveType::ED25519, "deal key must be ed25519");
        require!(self.merchant(&id).is_none() && self.merchant_of(&account_id).is_none(), "merchant exists");
        self.merchants.push(Merchant { id: id.clone(), account_id: account_id.clone(), rule, deal_key });
        self.players.insert(account_id.clone());
        self.mint(&account_id, &share_token(&id), SHARES_PER_STALL, "stall founded");
    }

    /// Idempotent. Players are registered by the relayer so contract storage only grows through its rate limits.
    pub fn register_player(&mut self, account_id: AccountId) -> bool {
        self.only_operator();
        if !self.players.insert(account_id.clone()) {
            return false;
        }
        self.mint(&account_id, COIN, STARTER_COIN, "starter purse");
        true
    }

    /// Goods enter the economy (harbor shipments) or coin is issued; the reason lands in the event memo.
    pub fn operator_mint(&mut self, account_id: AccountId, token_id: String, amount: U128, reason: String) {
        self.only_operator();
        require!(self.players.contains(&account_id), "unregistered account");
        require!(token_id == COIN || is_good(&token_id), "only coin and goods can be minted");
        self.mint(&account_id, &token_id, amount.0, &reason);
        self.restock(&account_id, &token_id, amount.0);
    }

    /// NPC shoppers bought `qty` goods from a stall at `unit_price`: the goods leave the economy, the coin they
    /// paid enters it, and it counts as the stall's revenue (so it feeds dividends).
    pub fn street_sale(&mut self, merchant: String, token_id: String, qty: U128, unit_price: U128) {
        self.only_operator();
        require!(is_good(&token_id), "street sales are for goods");
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        if self.closures.contains_key(&m.id) {
            return; // shutters down: no shoppers (a no-op, so one closed stall never sinks the operator's batch)
        }
        let cost = unit_price.0.checked_mul(qty.0).expect("overflow");
        self.debit(&m.account_id, &token_id, qty.0);
        let s = self.supply.get(&token_id).copied().unwrap_or(0);
        self.supply.insert(token_id.clone(), s - qty.0);
        emit("mt_burn", json!({ "owner_id": m.account_id, "token_ids": [token_id], "amounts": [qty], "memo": "street shoppers" }));
        if cost > 0 {
            self.mint(&m.account_id, COIN, cost, "street shoppers");
            let r = self.revenue.get(&m.id).copied().unwrap_or(0);
            self.revenue.insert(m.id.clone(), r + cost);
        }
    }

    /// Moves everything a player owns (coin, goods, stall shares) to another registered account, e.g. a guest's
    /// progress into the account they signed in with. The relayer calls it only after the guest proved it holds the
    /// guest key. Returns how many token balances moved.
    pub fn migrate_player(&mut self, from: AccountId, to: AccountId) -> u32 {
        self.only_operator();
        require!(from != to, "same account");
        require!(self.players.contains(&from) && self.players.contains(&to), "both accounts must be registered");
        require!(self.merchant_of(&from).is_none() && self.merchant_of(&to).is_none(), "merchant accounts cannot migrate");
        let mut moved = 0u32;
        for t in self.all_tokens() {
            let b = self.bal(&t, &from);
            if b > 0 {
                self.move_token(&from, &to, &t, b, "account link");
                self.push_receipt(&to, "linked", &t, b, 0, &from);
                moved += 1;
            }
        }
        moved
    }

    /// Spoilage and fees leave the economy.
    pub fn operator_burn(&mut self, account_id: AccountId, token_id: String, amount: U128, reason: String) {
        self.only_operator();
        self.burn(&account_id, &token_id, amount.0, &reason);
    }

    /// Rent for `day` (idempotent per stall and day; closed stalls pay none). A stall that can pay has `rent`
    /// burned from its till; one that cannot closes until `reopen_need` mangoes are delivered to it. Returns
    /// whether the stall is open afterwards.
    pub fn charge_rent(&mut self, day: u32, merchant: String, rent: U128, reopen_need: U128) -> bool {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        if self.closures.contains_key(&m.id) {
            return false;
        }
        if !self.rent_days.insert((m.id.clone(), day)) {
            return true;
        }
        if self.bal(COIN, &m.account_id) >= rent.0 {
            if rent.0 > 0 {
                self.burn(&m.account_id, COIN, rent.0, "rent");
            }
            return true;
        }
        let need = U128(reopen_need.0.max(1));
        self.closures.insert(m.id.clone(), Closure { since_day: day, need, delivered: U128(0) });
        env::log_str(&format!("stall {} closed on day {day}: rent {} unpaid, reopens after {} mangoes", m.id, rent.0, need.0));
        false
    }

    /// Buys out an idle shareholder (no trade for IDLE_MS) at the stall's posted buyback price, rounded up in the
    /// holder's favour, so shares held by players who left return to the stall for new partners.
    pub fn redeem_idle(&mut self, merchant: String, holder: AccountId) -> Receipt {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        require!(self.merchant_of(&holder).is_none(), "merchants are not redeemed");
        let last = self.last_active.get(&holder).copied().unwrap_or(self.since_ms);
        require!(env::block_timestamp_ms().saturating_sub(last) >= IDLE_MS, "holder is still active");
        let bid = self.share_bids.get(&m.id).copied().expect("no buyback price posted");
        let token = share_token(&m.id);
        let qty = self.bal(&token, &holder);
        require!(qty > 0, "holds no shares");
        let pay = (qty * bid.price.0).div_ceil(bid.per.0);
        self.move_token(&m.account_id, &holder, COIN, pay, "share buyback (idle holder)");
        self.move_token(&holder, &m.account_id, &token, qty, "share buyback (idle holder)");
        self.dust.remove(&(token.clone(), holder.clone()));
        self.push_receipt(&m.account_id, "bought back", &token, qty, pay, &holder);
        self.push_receipt(&holder, "redeemed", &token, qty, pay, &m.account_id)
    }

    /// Pays the day's dividend for one stall. Idempotent: a second call for the same day returns the
    /// recorded settlement and moves nothing.
    pub fn settle_day(&mut self, day: u32, merchant: String) -> Settlement {
        self.only_operator();
        if let Some(done) = self.settlements.get(&(merchant.clone(), day)) {
            return done.clone();
        }
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        let revenue = self.revenue.get(&merchant).copied().unwrap_or(0);
        let pool = (revenue * DIVIDEND_BPS / 10_000).min(self.bal(COIN, &m.account_id));
        let share = share_token(&merchant);
        let mut paid = 0u128;
        // Exactly pro rata: each holder's fraction of a coin carries to the next settlement instead of being
        // rounded away. The merchant's own (unsold) shares' cut stays in its till.
        let holders = self.holders.get(&share).cloned().unwrap_or_default();
        for h in holders.iter().filter(|h| **h != m.account_id) {
            let key = (share.clone(), h.clone());
            let units = pool * self.bal(&share, h) + self.dust.get(&key).copied().unwrap_or(0);
            let mut amount = units / SHARES_PER_STALL;
            if amount > self.bal(COIN, &m.account_id) {
                amount = 0; // the till ran dry: it stays owed, carried in full
            }
            let rest = units - amount * SHARES_PER_STALL;
            if rest == 0 {
                self.dust.remove(&key);
            } else {
                self.dust.insert(key, rest);
            }
            if amount > 0 {
                self.move_token(&m.account_id, h, COIN, amount, "dividend");
                self.push_receipt(h, "dividend", COIN, amount, pool, &m.account_id);
                paid += amount;
            }
        }
        self.revenue.insert(merchant.clone(), 0);
        let s = Settlement { day, merchant: merchant.clone(), revenue: U128(revenue), pool: U128(pool), paid: U128(paid) };
        self.settlements.insert((merchant, day), s.clone());
        s
    }

    // ---------- merchants ----------

    /// Sets (qty > 0) or clears (qty = 0) the caller's ask: goods at `price` each, or shares of its own stall at
    /// `price` coins per `per` shares (an exact rational price; `per` defaults to 1).
    pub fn list(&mut self, token_id: String, qty: U128, price: U128, per: Option<U128>) {
        let m = self.caller_merchant();
        if token_id == share_token(&m.id) {
            Self::set_share_order(&mut self.share_asks, m.id, qty, price, per.unwrap_or(U128(1)));
            return;
        }
        require!(is_good(&token_id) && per.is_none_or(|p| p.0 == 1), "cannot list this token");
        Self::set_order(&mut self.asks, m.account_id, token_id, qty, price);
    }

    /// Sets or clears the caller's standing bid: goods, or a buyback of its own stall's shares (`price` per `per`).
    pub fn bid(&mut self, token_id: String, qty: U128, price: U128, per: Option<U128>) {
        let m = self.caller_merchant();
        if token_id == share_token(&m.id) {
            Self::set_share_order(&mut self.share_bids, m.id, qty, price, per.unwrap_or(U128(1)));
            return;
        }
        require!(is_good(&token_id) && per.is_none_or(|p| p.0 == 1), "can only bid for goods");
        Self::set_order(&mut self.bids, m.account_id, token_id, qty, price);
    }

    // ---------- anyone registered (players and merchants) ----------

    /// Buys from a merchant's ask: coin buyer -> seller, token seller -> buyer, in one receipt. For goods
    /// `max_price` caps the unit price; for stall shares (investing) it caps the total cost, and `qty` must be a
    /// whole number of the offer's packs. Share money is capital for the stall, not revenue.
    pub fn buy(&mut self, seller: AccountId, token_id: String, qty: U128, max_price: U128) -> Receipt {
        let buyer = env::predecessor_account_id();
        require!(self.players.contains(&buyer), "register first");
        require!(buyer != seller, "cannot trade with yourself");
        self.touch(&buyer);
        if token_id.starts_with("share:") {
            return self.trade_shares(true, buyer, seller, token_id, qty.0, max_price.0);
        }
        require!(!self.is_closed(&seller), "stall is closed");
        let key = (seller.clone(), token_id.clone());
        let order = self.asks.get(&key).copied().expect("no offer");
        let (qty, price) = (qty.0, order.price.0);
        require!(qty > 0 && qty <= order.qty.0, "quantity not on offer");
        require!(price <= max_price.0, "price moved above your limit");
        let cost = price.checked_mul(qty).expect("overflow");
        self.move_token(&buyer, &seller, COIN, cost, "buy");
        self.move_token(&seller, &buyer, &token_id, qty, "buy");
        Self::shrink(&mut self.asks, key, order, qty);
        self.restock(&buyer, &token_id, qty);
        if is_good(&token_id) {
            if let Some(id) = self.merchant_of(&seller).map(|m| m.id.clone()) {
                let r = self.revenue.get(&id).copied().unwrap_or(0);
                self.revenue.insert(id, r + cost);
            }
        }
        self.push_receipt(&seller, "sold", &token_id, qty, price, &buyer);
        self.push_receipt(&buyer, "bought", &token_id, qty, price, &seller)
    }

    /// Sells goods into a merchant's standing bid (`min_price` per unit), or stall shares back into the stall's
    /// buyback (`min_price` is then the least total payout).
    pub fn sell(&mut self, buyer: AccountId, token_id: String, qty: U128, min_price: U128) -> Receipt {
        let seller = env::predecessor_account_id();
        require!(self.players.contains(&seller), "register first");
        require!(buyer != seller, "cannot trade with yourself");
        self.touch(&seller);
        if token_id.starts_with("share:") {
            return self.trade_shares(false, seller, buyer, token_id, qty.0, min_price.0);
        }
        let key = (buyer.clone(), token_id.clone());
        let order = self.bids.get(&key).copied().expect("no bid");
        let (qty, price) = (qty.0, order.price.0);
        require!(qty > 0 && qty <= order.qty.0, "quantity not wanted");
        require!(price >= min_price.0, "bid dropped below your limit");
        let cost = price.checked_mul(qty).expect("overflow");
        self.move_token(&buyer, &seller, COIN, cost, "sell");
        self.move_token(&seller, &buyer, &token_id, qty, "sell");
        Self::shrink(&mut self.bids, key, order, qty);
        self.restock(&buyer, &token_id, qty);
        self.push_receipt(&buyer, "bought", &token_id, qty, price, &seller);
        self.push_receipt(&seller, "sold", &token_id, qty, price, &buyer)
    }

    /// Settles a haggled deal the merchant signed off-chain: `side` "buy" (player buys goods) or "sell" (player
    /// sells goods). The merchant's signature over `deal_message(...)` proves it agreed to exactly this price;
    /// the nonce makes each signed deal single-use and `expires_ms` bounds how long it stays valid.
    #[allow(clippy::too_many_arguments)]
    pub fn deal(&mut self, merchant: String, side: String, token_id: String, qty: U128, unit_price: U128, nonce: U64, expires_ms: U64, signature: Base64VecU8) -> Receipt {
        let player = env::predecessor_account_id();
        require!(self.players.contains(&player), "register first");
        require!(is_good(&token_id), "deals are for goods");
        require!(side == "buy" || side == "sell", "side must be buy or sell");
        require!(env::block_timestamp_ms() <= expires_ms.0, "deal expired");
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        require!(m.account_id != player, "cannot trade with yourself");
        require!(side == "sell" || !self.closures.contains_key(&m.id), "stall is closed");
        self.touch(&player);
        let msg = deal_message(&env::current_account_id(), &merchant, &player, &side, &token_id, qty.0, unit_price.0, nonce.0, expires_ms.0);
        let sig: [u8; 64] = signature.0.as_slice().try_into().expect("signature must be 64 bytes");
        let pk: [u8; 32] = m.deal_key.as_bytes()[1..].try_into().expect("bad deal key");
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &pk), "merchant did not sign this deal");
        require!(self.used_deals.insert((m.account_id.clone(), nonce.0)), "deal already used");
        let (qty, price) = (qty.0, unit_price.0);
        require!(qty > 0 && price > 0, "empty deal");
        let cost = price.checked_mul(qty).expect("overflow");
        let (buyer, seller) = if side == "buy" { (player.clone(), m.account_id.clone()) } else { (m.account_id.clone(), player.clone()) };
        self.move_token(&buyer, &seller, COIN, cost, "deal");
        self.move_token(&seller, &buyer, &token_id, qty, "deal");
        if side == "buy" {
            let r = self.revenue.get(&m.id).copied().unwrap_or(0);
            self.revenue.insert(m.id.clone(), r + cost);
        } else {
            self.restock(&m.account_id, &token_id, qty);
        }
        self.push_receipt(&m.account_id, if side == "buy" { "sold" } else { "bought" }, &token_id, qty, price, &player);
        self.push_receipt(&player, if side == "buy" { "bought" } else { "sold" }, &token_id, qty, price, &m.account_id)
    }

    /// Standard NEP-245 transfer for full-access callers (requires exactly 1 yocto).
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals not supported");
        require!(self.players.contains(&receiver_id), "receiver not registered");
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "cannot transfer to yourself");
        self.move_token(&sender, &receiver_id, &token_id, amount.0, memo.as_deref().unwrap_or("transfer"));
    }

    // ---------- views ----------

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.bal(&token_id, &account_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|t| U128(self.bal(t, &account_id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|t| self.mt_supply(t)).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Token>> {
        token_ids
            .into_iter()
            .map(|t| self.supply.get(&t).map(|_| Token { token_id: t, owner_id: None }))
            .collect()
    }

    pub fn get_operator(&self) -> AccountId {
        self.operator.clone()
    }

    pub fn get_merchants(&self) -> Vec<Merchant> {
        self.merchants.clone()
    }

    pub fn is_registered(&self, account_id: AccountId) -> bool {
        self.players.contains(&account_id)
    }

    /// Every non-zero balance the account holds, as (token_id, amount).
    pub fn get_balances(&self, account_id: AccountId) -> Vec<(String, U128)> {
        self.all_tokens()
            .into_iter()
            .map(|t| {
                let b = self.bal(&t, &account_id);
                (t, U128(b))
            })
            .filter(|(_, b)| b.0 > 0)
            .collect()
    }

    pub fn get_offers(&self) -> Vec<OfferView> {
        let mut out = Vec::new();
        for m in &self.merchants {
            for t in self.all_tokens() {
                for (side, book) in [("ask", &self.asks), ("bid", &self.bids)] {
                    if let Some(o) = book.get(&(m.account_id.clone(), t.clone())) {
                        out.push(OfferView { merchant: m.id.clone(), account_id: m.account_id.clone(), token_id: t.clone(), side: side.into(), qty: o.qty, price: o.price });
                    }
                }
            }
        }
        out
    }

    pub fn get_share_offers(&self) -> Vec<ShareOfferView> {
        let mut out = Vec::new();
        for m in &self.merchants {
            for (side, book) in [("ask", &self.share_asks), ("bid", &self.share_bids)] {
                if let Some(o) = book.get(&m.id) {
                    out.push(ShareOfferView { merchant: m.id.clone(), side: side.into(), qty: o.qty, price: o.price, per: o.per });
                }
            }
        }
        out
    }

    /// Every stall's open/closed state, reopening progress and shareholder count.
    pub fn get_stalls(&self) -> Vec<StallStatus> {
        self.merchants
            .iter()
            .map(|m| {
                let c = self.closures.get(&m.id).copied();
                let holders = self.holders.get(&share_token(&m.id)).map_or(0, |l| l.len() as u32);
                StallStatus {
                    merchant: m.id.clone(),
                    open: c.is_none(),
                    since_day: c.map(|c| c.since_day),
                    need: c.map_or(U128(0), |c| c.need),
                    delivered: c.map_or(U128(0), |c| c.delivered),
                    holders,
                }
            })
            .collect()
    }

    /// Shareholders of a stall with their balances and last trade time (bounded by MAX_HOLDERS).
    pub fn get_holders(&self, merchant: String) -> Vec<(AccountId, U128, U64)> {
        let token = share_token(&merchant);
        self.holders
            .get(&token)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|h| {
                let b = U128(self.bal(&token, &h));
                let last = U64(self.last_active.get(&h).copied().unwrap_or(self.since_ms));
                (h, b, last)
            })
            .collect()
    }

    /// Dividend fraction owed to a holder for a stall, in 1/SHARES_PER_STALL coin.
    pub fn get_dust(&self, merchant: String, account_id: AccountId) -> U128 {
        U128(self.dust.get(&(share_token(&merchant), account_id)).copied().unwrap_or(0))
    }

    pub fn get_revenue(&self, merchant: String) -> U128 {
        U128(self.revenue.get(&merchant).copied().unwrap_or(0))
    }

    pub fn get_settlements(&self, merchant: String, from_day: u32, limit: u32) -> Vec<Settlement> {
        (from_day..from_day.saturating_add(limit.min(31)))
            .filter_map(|d| self.settlements.get(&(merchant.clone(), d)).cloned())
            .collect()
    }

    pub fn get_receipts(&self, account_id: AccountId) -> Vec<Receipt> {
        self.receipts.get(&account_id).cloned().unwrap_or_default()
    }
}

// ---------- internals ----------
impl Market {
    fn only_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "operator only");
    }

    fn merchant(&self, id: &str) -> Option<&Merchant> {
        self.merchants.iter().find(|m| m.id == id)
    }

    fn merchant_of(&self, account: &AccountId) -> Option<&Merchant> {
        self.merchants.iter().find(|m| &m.account_id == account)
    }

    fn caller_merchant(&self) -> Merchant {
        self.merchant_of(&env::predecessor_account_id()).cloned().expect("merchants only")
    }

    fn all_tokens(&self) -> Vec<String> {
        let mut t: Vec<String> = std::iter::once(COIN).chain(GOODS).map(String::from).collect();
        t.extend(self.merchants.iter().map(|m| share_token(&m.id)));
        t
    }

    fn bal(&self, token: &str, account: &AccountId) -> u128 {
        self.balances.get(&(token.to_string(), account.clone())).copied().unwrap_or(0)
    }

    fn credit(&mut self, account: &AccountId, token: &str, amount: u128) {
        let b = self.bal(token, account).checked_add(amount).expect("overflow");
        self.balances.insert((token.to_string(), account.clone()), b);
        if token.starts_with("share:") {
            let list = self.holders.entry(token.to_string()).or_default();
            if !list.contains(account) {
                require!(list.len() < MAX_HOLDERS, "stall has too many shareholders");
                list.push(account.clone());
            }
        }
    }

    fn debit(&mut self, account: &AccountId, token: &str, amount: u128) {
        let b = self.bal(token, account);
        require!(b >= amount, format!("not enough {token}"));
        let key = (token.to_string(), account.clone());
        if b == amount {
            self.balances.remove(&key);
            if let Some(list) = self.holders.get_mut(token) {
                list.retain(|a| a != account);
            }
        } else {
            self.balances.insert(key, b - amount);
        }
    }

    fn move_token(&mut self, from: &AccountId, to: &AccountId, token: &str, amount: u128, memo: &str) {
        require!(amount > 0, "zero amount");
        self.debit(from, token, amount);
        self.credit(to, token, amount);
        emit("mt_transfer", json!({ "old_owner_id": from, "new_owner_id": to, "token_ids": [token], "amounts": [amount.to_string()], "memo": memo }));
    }

    fn mint(&mut self, to: &AccountId, token: &str, amount: u128, memo: &str) {
        require!(amount > 0, "zero amount");
        self.credit(to, token, amount);
        let s = self.supply.get(token).copied().unwrap_or(0).checked_add(amount).expect("overflow");
        self.supply.insert(token.to_string(), s);
        emit("mt_mint", json!({ "owner_id": to, "token_ids": [token], "amounts": [amount.to_string()], "memo": memo }));
    }

    fn is_closed(&self, account: &AccountId) -> bool {
        self.merchant_of(account).is_some_and(|m| self.closures.contains_key(&m.id))
    }

    fn touch(&mut self, account: &AccountId) {
        if self.merchant_of(account).is_none() {
            self.last_active.insert(account.clone(), env::block_timestamp_ms());
        }
    }

    /// Mangoes reaching a closed stall count toward its reopening; it opens the moment they cover the need.
    fn restock(&mut self, account: &AccountId, token: &str, qty: u128) {
        if token != "mango" {
            return;
        }
        let Some(id) = self.merchant_of(account).map(|m| m.id.clone()) else { return };
        let Some(mut c) = self.closures.get(&id).copied() else { return };
        c.delivered = U128(c.delivered.0 + qty);
        if c.delivered.0 >= c.need.0 {
            self.closures.remove(&id);
            env::log_str(&format!("stall {id} reopened: {} of {} mangoes delivered", c.delivered.0, c.need.0));
        } else {
            self.closures.insert(id, c);
        }
    }

    fn burn(&mut self, account: &AccountId, token: &str, amount: u128, memo: &str) {
        self.debit(account, token, amount);
        let s = self.supply.get(token).copied().unwrap_or(0);
        self.supply.insert(token.to_string(), s - amount);
        emit("mt_burn", json!({ "owner_id": account, "token_ids": [token], "amounts": [amount.to_string()], "memo": memo }));
    }

    /// A player invests (`buying`) or cashes out with the stall that `merchant_acct` runs. `limit` is the most the
    /// player pays, or the least they accept, in total coins.
    fn trade_shares(&mut self, buying: bool, player: AccountId, merchant_acct: AccountId, token: String, qty: u128, limit: u128) -> Receipt {
        let m = self.merchant_of(&merchant_acct).cloned().expect("shares trade with their stall");
        require!(token == share_token(&m.id), "shares trade with their own stall");
        let book = if buying { &self.share_asks } else { &self.share_bids };
        let order = book.get(&m.id).copied().unwrap_or_else(|| env::panic_str(if buying { "no shares on offer" } else { "the stall is not buying shares back" }));
        let total = Self::share_cost(&order, qty);
        if buying {
            require!(total <= limit, "share price moved above your limit");
            self.move_token(&player, &m.account_id, COIN, total, "invest");
            self.move_token(&m.account_id, &player, &token, qty, "invest");
            Self::shrink_share(&mut self.share_asks, m.id.clone(), order, qty);
            self.push_receipt(&m.account_id, "sold shares", &token, qty, total, &player);
            self.push_receipt(&player, "invested", &token, qty, total, &m.account_id)
        } else {
            require!(total >= limit, "buyback price dropped below your limit");
            self.move_token(&m.account_id, &player, COIN, total, "share buyback");
            self.move_token(&player, &m.account_id, &token, qty, "share buyback");
            Self::shrink_share(&mut self.share_bids, m.id.clone(), order, qty);
            self.push_receipt(&m.account_id, "bought back", &token, qty, total, &player);
            self.push_receipt(&player, "cashed out", &token, qty, total, &m.account_id)
        }
    }

    fn share_cost(order: &ShareOrder, qty: u128) -> u128 {
        require!(qty > 0 && qty <= order.qty.0, "shares not on offer");
        require!(qty % order.per.0 == 0, format!("shares trade in packs of {}", order.per.0));
        qty / order.per.0 * order.price.0
    }

    fn set_share_order(book: &mut LookupMap<String, ShareOrder>, id: String, qty: U128, price: U128, per: U128) {
        if qty.0 == 0 {
            book.remove(&id);
        } else {
            require!(price.0 > 0 && per.0 > 0 && qty.0 % per.0 == 0, "bad share order");
            book.insert(id, ShareOrder { qty, price, per });
        }
    }

    fn shrink_share(book: &mut LookupMap<String, ShareOrder>, id: String, order: ShareOrder, qty: u128) {
        let left = order.qty.0 - qty;
        if left == 0 {
            book.remove(&id);
        } else {
            book.insert(id, ShareOrder { qty: U128(left), ..order });
        }
    }

    fn set_order(book: &mut LookupMap<(AccountId, String), Order>, account: AccountId, token: String, qty: U128, price: U128) {
        if qty.0 == 0 {
            book.remove(&(account, token));
        } else {
            require!(price.0 > 0, "price must be positive");
            book.insert((account, token), Order { qty, price });
        }
    }

    fn shrink(book: &mut LookupMap<(AccountId, String), Order>, key: (AccountId, String), order: Order, qty: u128) {
        let left = order.qty.0 - qty;
        if left == 0 {
            book.remove(&key);
        } else {
            book.insert(key, Order { qty: U128(left), price: order.price });
        }
    }

    fn push_receipt(&mut self, account: &AccountId, kind: &str, token: &str, qty: u128, price: u128, counterparty: &AccountId) -> Receipt {
        let r = Receipt { kind: kind.into(), token_id: token.into(), qty: U128(qty), price: U128(price), counterparty: counterparty.clone(), block_height: env::block_height() };
        let list = self.receipts.entry(account.clone()).or_default();
        if list.len() >= MAX_RECEIPTS {
            list.remove(0);
        }
        list.push(r.clone());
        r
    }
}

#[cfg(test)]
mod tests;
