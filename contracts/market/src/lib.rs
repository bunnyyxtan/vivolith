//! VIVOLITH market contract: one NEP-245 multi-token ledger for the game.
//!
//! Token ids: `coin` (in-game coin, no monetary value), goods `mango` / `lemon` / `lassi`, and
//! `share:<merchant>` (20 shares per stall). Game moves are zero-deposit methods so players can sign them
//! with function-call keys (which cannot attach the 1 yocto `mt_transfer` needs); every move emits the
//! standard NEP-245 `mt_transfer` / `mt_mint` / `mt_burn` events. Every check runs before the receipt
//! ends, and a panic reverts the whole receipt, so a failed trade never grants goods.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, CurveType, PanicOnDefault, PublicKey};

pub const COIN: &str = "coin";
pub const GOODS: [&str; 3] = ["mango", "lemon", "lassi"];
pub const SHARES_PER_STALL: u128 = 20;
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
        }
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
    }

    /// NPC shoppers bought `qty` goods from a stall at `unit_price`: the goods leave the economy, the coin they
    /// paid enters it, and it counts as the stall's revenue (so it feeds dividends).
    pub fn street_sale(&mut self, merchant: String, token_id: String, qty: U128, unit_price: U128) {
        self.only_operator();
        require!(is_good(&token_id), "street sales are for goods");
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
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
        self.debit(&account_id, &token_id, amount.0);
        let s = self.supply.get(&token_id).copied().unwrap_or(0);
        self.supply.insert(token_id.clone(), s - amount.0);
        emit("mt_burn", json!({ "owner_id": account_id, "token_ids": [token_id], "amounts": [amount], "memo": reason }));
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
        // Pro rata, rounded down per holder; the remainder stays with the merchant.
        let holders = self.holders.get(&share).cloned().unwrap_or_default();
        for h in holders.iter().filter(|h| **h != m.account_id) {
            let amount = pool * self.bal(&share, h) / SHARES_PER_STALL;
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

    /// Sets (qty > 0) or clears (qty = 0) the caller's ask: goods, or shares of its own stall.
    pub fn list(&mut self, token_id: String, qty: U128, price: U128) {
        let m = self.caller_merchant();
        require!(is_good(&token_id) || token_id == share_token(&m.id), "cannot list this token");
        Self::set_order(&mut self.asks, m.account_id, token_id, qty, price);
    }

    /// Sets or clears the caller's standing bid for goods.
    pub fn bid(&mut self, token_id: String, qty: U128, price: U128) {
        let m = self.caller_merchant();
        require!(is_good(&token_id), "can only bid for goods");
        Self::set_order(&mut self.bids, m.account_id, token_id, qty, price);
    }

    // ---------- anyone registered (players and merchants) ----------

    /// Buys from a merchant's ask: coin buyer -> seller, token seller -> buyer, in one receipt.
    pub fn buy(&mut self, seller: AccountId, token_id: String, qty: U128, max_price: U128) -> Receipt {
        let buyer = env::predecessor_account_id();
        require!(self.players.contains(&buyer), "register first");
        require!(buyer != seller, "cannot trade with yourself");
        let key = (seller.clone(), token_id.clone());
        let order = self.asks.get(&key).copied().expect("no offer");
        let (qty, price) = (qty.0, order.price.0);
        require!(qty > 0 && qty <= order.qty.0, "quantity not on offer");
        require!(price <= max_price.0, "price moved above your limit");
        let cost = price.checked_mul(qty).expect("overflow");
        self.move_token(&buyer, &seller, COIN, cost, "buy");
        self.move_token(&seller, &buyer, &token_id, qty, "buy");
        Self::shrink(&mut self.asks, key, order, qty);
        if is_good(&token_id) {
            if let Some(id) = self.merchant_of(&seller).map(|m| m.id.clone()) {
                let r = self.revenue.get(&id).copied().unwrap_or(0);
                self.revenue.insert(id, r + cost);
            }
        }
        self.push_receipt(&seller, "sold", &token_id, qty, price, &buyer);
        self.push_receipt(&buyer, "bought", &token_id, qty, price, &seller)
    }

    /// Sells goods into a merchant's standing bid.
    pub fn sell(&mut self, buyer: AccountId, token_id: String, qty: U128, min_price: U128) -> Receipt {
        let seller = env::predecessor_account_id();
        require!(self.players.contains(&seller), "register first");
        require!(buyer != seller, "cannot trade with yourself");
        let key = (buyer.clone(), token_id.clone());
        let order = self.bids.get(&key).copied().expect("no bid");
        let (qty, price) = (qty.0, order.price.0);
        require!(qty > 0 && qty <= order.qty.0, "quantity not wanted");
        require!(price >= min_price.0, "bid dropped below your limit");
        let cost = price.checked_mul(qty).expect("overflow");
        self.move_token(&buyer, &seller, COIN, cost, "sell");
        self.move_token(&seller, &buyer, &token_id, qty, "sell");
        Self::shrink(&mut self.bids, key, order, qty);
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
