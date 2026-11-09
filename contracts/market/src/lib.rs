//! VIVOLITH market contract (v3): one NEP-245 multi-token ledger for the game, with its accounting rules on chain.
//!
//! Token ids: `coin` (in-game coin, no monetary value), goods `mango` / `lemon` / `lassi`, and `share:<merchant>`.
//! Game moves are zero-deposit methods so players can sign them with function-call keys (which cannot attach the
//! 1 yocto `mt_transfer` needs); every move emits the standard NEP-245 `mt_transfer` / `mt_mint` / `mt_burn` events.
//! A panic reverts the whole receipt, so a failed trade never grants goods.
//!
//! The economy's math, in full (see docs/ECONOMY_MATH.md for the proofs):
//! * **Shares.** Every stall floats `FLOAT` shares at launch, sold in packs of `PACK` at a fixed `pack_price`.
//!   `pack_backing` of each pack's price goes into the stall's reserve, the rest into its till as working capital.
//!   A partner can always sell a pack back for exactly `pack_backing`, paid from the reserve. When the stall's own
//!   unsold shares run out it issues new ones on the same terms, so investing never sells out and nobody's shares
//!   are ever taken. Invariant: `reserve * PACK == pack_backing * (supply - treasury)`.
//! * **Dividends.** At each settlement `DIVIDEND_BPS` of the stall's revenue is declared (the basis-point remainder
//!   carries to the next day). The till pays what it can into the dividend vault; the rest is recorded as arrears
//!   and paid first next time. Funded coin raises a per-share accumulator `acc` (scaled by `ACC_SCALE`, with the
//!   division remainder carried), and each holder is owed `balance * (acc - checkpoint)`. Payouts happen before
//!   any change to a holder's balance, so selling never forfeits a dividend, and the sub-coin fraction is kept per
//!   holder. Settling costs the same for 1 or 1,000,000 shareholders: there is no holder list and no holder limit.
//!   Invariant: the vault always holds at least what every holder is owed.
//! * **Custody.** The contract's own coin balance is exactly the sum of every stall's reserve and vault.
//! * **Guild.** A fixed fund lends to stalls (recorded as debt) and is repaid first from healthy tills.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, CurveType, PanicOnDefault, PublicKey};

pub const COIN: &str = "coin";
pub const GOODS: [&str; 3] = ["mango", "lemon", "lassi"];
/// Shares each stall floats at launch (its treasury); more are issued on the same terms only when these are gone.
pub const FLOAT: u128 = 300;
/// Shares move in whole packs, so every price is an exact integer number of coins.
pub const PACK: u128 = 15;
/// Most packs one transaction may buy or sell (bounds each issue).
pub const MAX_PACKS: u128 = 20;
/// Fixed-point scale of the dividend accumulator (coin per share): 10^18 times lcm(1..16) = 720720, so dividing by
/// any share supply of 15 * n (n built from primes up to 13, e.g. 300, 315, 330, 360, 450, 4500) is exact. Any
/// other remainder is carried in the stall (`acc_rem`) and per holder (`carry`): deferred, never lost. Headroom:
/// u128 holds balance * accumulated dividend up to 4.7e14 coins between two checkpoints of one holder.
pub const ACC_SCALE: u128 = 720_720 * 1_000_000_000_000_000_000;
pub const STARTER_COIN: u128 = 25;
pub const MAX_RECEIPTS: usize = 20;
/// Settlements kept per stall for the views (older ones are summarised in the stall's lifetime totals).
pub const MAX_HISTORY: usize = 24;
/// Share of each day's goods revenue a stall declares for its shareholders, in basis points.
pub const DIVIDEND_BPS: u128 = 5_000;
const BPS: u128 = 10_000;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Merchant {
    pub id: String,
    pub account_id: AccountId,
    /// Human-readable trading personality (the rules themselves run off-chain in src/economy/pricing.ts).
    pub rule: String,
    /// The merchant's ed25519 key that signs haggled deals (`deal`); same key as its function-call key.
    pub deal_key: PublicKey,
    /// Coins for one pack of `PACK` shares, and the part of it held in reserve (paid back on a sale).
    pub pack_price: U128,
    pub pack_backing: U128,
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
    /// DIVIDEND_BPS of revenue (plus the carried basis-point remainder), in whole coins.
    pub declared: U128,
    /// Coins the till moved into the dividend vault (declared + earlier arrears, as far as the till allowed).
    pub funded: U128,
    /// Declared but not yet funded after this settlement; paid first at the next one.
    pub arrears: U128,
    /// Share supply the funded coins were divided over.
    pub supply: U128,
}

/// A stall that missed rent: closed until `delivered` reaches `need` mangoes (deliveries only count up).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy)]
pub struct Closure {
    pub since_day: u32,
    pub need: U128,
    pub delivered: U128,
}

/// Everything the contract tracks per stall besides token balances.
#[near(serializers = [borsh])]
#[derive(Clone, Default)]
pub struct Stall {
    /// Coins (held by the contract) backing the shares partners hold.
    reserve: u128,
    /// Funded dividends not yet paid out (held by the contract).
    vault: u128,
    /// Cumulative funded dividend per share, times ACC_SCALE, and the remainder of that division.
    acc: u128,
    acc_rem: u128,
    /// Goods revenue since the last settlement, and the basis-point remainder of the last declaration.
    revenue: u128,
    rev_rem: u128,
    arrears: u128,
    last_settled: Option<u32>,
    last_rent: Option<u32>,
    closure: Option<Closure>,
    /// Accounts other than the stall itself holding at least one share.
    holders: u32,
    /// Coins owed to the Market Guild.
    debt: u128,
    /// Lifetime totals (monotonic): coins declared, funded into the vault, and paid out to holders.
    total_declared: u128,
    total_funded: u128,
    total_paid: u128,
    history: Vec<Settlement>,
}

/// A holder's dividend checkpoint for one stall: the accumulator value already accounted for, and the owed
/// fraction of a coin (in 1/ACC_SCALE coin) carried until it adds up to a whole coin.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub struct Position {
    cp: u128,
    carry: u128,
}

#[near(serializers = [json])]
pub struct StallView {
    pub merchant: String,
    pub open: bool,
    pub since_day: Option<u32>,
    pub need: U128,
    pub delivered: U128,
    pub holders: u32,
    pub supply: U128,
    /// Unsold shares the stall still holds; past these, new packs are issued on the same terms.
    pub treasury: U128,
    pub pack: U128,
    pub pack_price: U128,
    pub pack_backing: U128,
    pub reserve: U128,
    pub vault: U128,
    pub revenue: U128,
    pub arrears: U128,
    pub debt: U128,
    pub last_settled: Option<u32>,
    /// Last market day rent was charged (or found closed): the relayer reads it to never send a day twice.
    pub last_rent: Option<u32>,
    pub total_declared: U128,
    pub total_funded: U128,
    pub total_paid: U128,
}

#[near(serializers = [json])]
pub struct PendingView {
    pub merchant: String,
    pub shares: U128,
    /// Whole coins owed now (paid automatically on the holder's next trade, or by `claim`).
    pub coins: U128,
    /// Owed fraction of a coin, in 1/ACC_SCALE coin.
    pub fraction: U128,
}

#[near(serializers = [json])]
pub struct StallAudit {
    pub merchant: String,
    pub reserve: U128,
    /// pack_backing * (supply - treasury) / PACK: what the reserve must hold.
    pub reserve_required: U128,
    pub reserve_ok: bool,
    pub vault: U128,
    /// vault == total_funded - total_paid.
    pub vault_ok: bool,
    pub share_supply: U128,
}

#[near(serializers = [json])]
pub struct Audit {
    pub coin_supply: U128,
    pub contract_coin: U128,
    pub reserves_and_vaults: U128,
    pub custody_ok: bool,
    pub guild: AccountId,
    pub guild_coin: U128,
    pub guild_lent: U128,
    pub stalls: Vec<StallAudit>,
    pub ok: bool,
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
    guild: AccountId,
    merchants: Vec<Merchant>,
    balances: LookupMap<(String, AccountId), u128>,
    supply: LookupMap<String, u128>,
    players: LookupSet<AccountId>,
    asks: LookupMap<(AccountId, String), Order>,
    bids: LookupMap<(AccountId, String), Order>,
    receipts: LookupMap<AccountId, Vec<Receipt>>,
    /// Highest deal nonce settled per (merchant account, player): signed deals are single-use with O(1) storage.
    deal_nonces: LookupMap<(AccountId, AccountId), u64>,
    stalls: LookupMap<String, Stall>,
    positions: LookupMap<(String, AccountId), Position>,
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
    /// Opens the market with the Market Guild's fixed fund (`guild_fund` coins, minted once, never again).
    #[init]
    pub fn new(operator: AccountId, guild: AccountId, guild_fund: U128) -> Self {
        let mut m = Self {
            operator,
            guild: guild.clone(),
            merchants: Vec::new(),
            balances: LookupMap::new(b"b"),
            supply: LookupMap::new(b"s"),
            players: LookupSet::new(b"p"),
            asks: LookupMap::new(b"a"),
            bids: LookupMap::new(b"d"),
            receipts: LookupMap::new(b"c"),
            deal_nonces: LookupMap::new(b"u"),
            stalls: LookupMap::new(b"k"),
            positions: LookupMap::new(b"q"),
        };
        m.players.insert(guild.clone());
        if guild_fund.0 > 0 {
            m.mint(&guild, COIN, guild_fund.0, "market guild fund");
        }
        m
    }

    // ---------- operator (the game relayer) ----------

    #[allow(clippy::too_many_arguments)]
    pub fn add_merchant(&mut self, id: String, account_id: AccountId, rule: String, deal_key: PublicKey, pack_price: U128, pack_backing: U128) {
        self.only_operator();
        require!(valid_id(&id), "bad merchant id");
        require!(deal_key.curve_type() == CurveType::ED25519, "deal key must be ed25519");
        require!(self.merchant(&id).is_none() && self.merchant_of(&account_id).is_none(), "merchant exists");
        require!(!self.players.contains(&account_id), "account already plays");
        require!(pack_backing.0 > 0 && pack_backing.0 < pack_price.0, "backing must be between 0 and the pack price");
        self.merchants.push(Merchant { id: id.clone(), account_id: account_id.clone(), rule, deal_key, pack_price, pack_backing });
        self.stalls.insert(id.clone(), Stall::default());
        self.players.insert(account_id.clone());
        self.mint(&account_id, &share_token(&id), FLOAT, "stall founded");
    }

    /// Idempotent. Players are registered by the relayer so contract storage only grows through its rate limits.
    pub fn register_player(&mut self, account_id: AccountId) -> bool {
        self.only_operator();
        require!(account_id != env::current_account_id(), "the contract does not play");
        if !self.players.insert(account_id.clone()) {
            return false;
        }
        self.mint(&account_id, COIN, STARTER_COIN, "starter purse");
        true
    }

    /// Goods enter the economy (harbor shipments, the tea kitchen); the reason lands in the event memo. Coin only
    /// enters through starter purses, street shoppers' payments and a merchant's opening till (`seed_till`).
    pub fn operator_mint(&mut self, account_id: AccountId, token_id: String, amount: U128, reason: String) {
        self.only_operator();
        require!(self.players.contains(&account_id), "unregistered account");
        require!(is_good(&token_id), "only goods can be minted");
        self.mint(&account_id, &token_id, amount.0, &reason);
        self.restock(&account_id, &token_id, amount.0);
    }

    /// A merchant's opening till, once, before it has ever traded, paid rent or settled (so it can never be used to
    /// mint coin later).
    pub fn seed_till(&mut self, merchant: String, amount: U128) {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        let st = self.stall(&m.id);
        let untouched = self.receipts.get(&m.account_id).is_none() && st.last_settled.is_none() && st.last_rent.is_none();
        require!(self.bal(COIN, &m.account_id) == 0 && untouched, "till already opened");
        self.mint(&m.account_id, COIN, amount.0, "opening till");
    }

    /// Spoilage, the kitchen's ingredients and harbor freight leave the economy (coin or goods; never shares).
    pub fn operator_burn(&mut self, account_id: AccountId, token_id: String, amount: U128, reason: String) {
        self.only_operator();
        require!(token_id == COIN || is_good(&token_id), "only coin and goods can be burned");
        require!(account_id != env::current_account_id(), "reserves and vaults cannot be burned");
        self.burn(&account_id, &token_id, amount.0, &reason);
    }

    /// NPC shoppers bought `qty` goods from a stall at `unit_price`: the goods leave the economy, the coin they
    /// paid enters it, and it counts as the stall's revenue (so it feeds dividends).
    pub fn street_sale(&mut self, merchant: String, token_id: String, qty: U128, unit_price: U128) {
        self.only_operator();
        require!(is_good(&token_id), "street sales are for goods");
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        if self.stall(&m.id).closure.is_some() {
            return; // shutters down: no shoppers (a no-op, so one closed stall never sinks the operator's batch)
        }
        let cost = unit_price.0.checked_mul(qty.0).expect("overflow");
        self.burn(&m.account_id, &token_id, qty.0, "street shoppers");
        if cost > 0 {
            self.mint(&m.account_id, COIN, cost, "street shoppers");
            self.add_revenue(&m.id, cost);
        }
    }

    /// Moves everything a player owns (coin, goods, stall shares, owed dividend fractions) to another registered
    /// account, e.g. a guest's progress into the account they signed in with. The relayer calls it only after the
    /// guest proved it holds the guest key. Returns how many token balances moved.
    pub fn migrate_player(&mut self, from: AccountId, to: AccountId) -> u32 {
        self.only_operator();
        require!(from != to, "same account");
        require!(self.players.contains(&from) && self.players.contains(&to), "both accounts must be registered");
        require!(self.merchant_of(&from).is_none() && self.merchant_of(&to).is_none(), "merchant accounts cannot migrate");
        require!(from != self.guild && to != self.guild, "the guild cannot migrate");
        self.claim_all(&from);
        let mut moved = 0u32;
        for t in self.all_tokens() {
            let b = self.bal(&t, &from);
            if b > 0 {
                self.move_token(&from, &to, &t, b, "account link");
                self.push_receipt(&to, "linked", &t, b, 0, &from);
                moved += 1;
            }
        }
        for id in self.merchant_ids() {
            if let Some(p) = self.positions.remove(&(share_token(&id), from.clone())) {
                self.add_carry(&id, &to, p.carry);
            }
        }
        moved
    }

    /// Pays an account every whole coin of dividends it is owed (this also happens on its own trades). It can
    /// only ever pay an account what it is owed. Returns the coins paid.
    pub fn claim(&mut self, account_id: AccountId) -> U128 {
        self.only_operator();
        U128(self.claim_all(&account_id))
    }

    /// Rent for `day` (once per stall and day; closed stalls pay none). A stall that can pay has `rent` burned from
    /// its till; one that cannot closes until `reopen_need` mangoes are delivered to it. Returns whether it is open.
    pub fn charge_rent(&mut self, day: u32, merchant: String, rent: U128, reopen_need: U128) -> bool {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        let mut s = self.stall(&m.id);
        if s.closure.is_some() {
            return false;
        }
        if s.last_rent.is_some_and(|d| d >= day) {
            return true;
        }
        s.last_rent = Some(day);
        let open = self.bal(COIN, &m.account_id) >= rent.0;
        if !open {
            let need = U128(reopen_need.0.max(1));
            s.closure = Some(Closure { since_day: day, need, delivered: U128(0) });
            env::log_str(&format!("stall {} closed on day {day}: rent {} unpaid, reopens after {} mangoes", m.id, rent.0, need.0));
        }
        self.stalls.insert(m.id.clone(), s);
        if open && rent.0 > 0 {
            self.burn(&m.account_id, COIN, rent.0, "rent");
        }
        open
    }

    /// Settles a stall's dividends up to `day` (each day at most once; a later day includes any day nobody
    /// settled). Declares DIVIDEND_BPS of revenue, funds it and any arrears from the till into the vault, and
    /// raises the per-share accumulator. Costs the same whatever the number of shareholders.
    pub fn settle_day(&mut self, day: u32, merchant: String) -> Settlement {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        let mut s = self.stall(&m.id);
        if s.last_settled.is_some_and(|d| d >= day) {
            return s.history.iter().rev().find(|h| h.day == day).cloned().unwrap_or_else(|| env::panic_str("day already settled"));
        }
        let supply = self.supply.get(&share_token(&m.id)).copied().unwrap_or(0);
        let units = s.revenue.checked_mul(DIVIDEND_BPS).expect("overflow") + s.rev_rem;
        let declared = units / BPS;
        s.rev_rem = units % BPS;
        let revenue = s.revenue;
        s.revenue = 0;
        let due = declared + s.arrears;
        let funded = due.min(self.bal(COIN, &m.account_id));
        s.arrears = due - funded;
        s.total_declared += declared;
        s.total_funded += funded;
        s.last_settled = Some(day);
        if funded > 0 {
            let total = funded.checked_mul(ACC_SCALE).expect("overflow") + s.acc_rem;
            s.acc = s.acc.checked_add(total / supply).expect("overflow");
            s.acc_rem = total % supply;
            s.vault += funded;
        }
        let row = Settlement { day, merchant: m.id.clone(), revenue: U128(revenue), declared: U128(declared), funded: U128(funded), arrears: U128(s.arrears), supply: U128(supply) };
        s.history.push(row.clone());
        if s.history.len() > MAX_HISTORY {
            s.history.remove(0);
        }
        self.stalls.insert(m.id.clone(), s);
        if funded > 0 {
            self.move_token(&m.account_id, &env::current_account_id(), COIN, funded, "dividend vault");
            self.settle_holder(&m.id, &m.account_id); // the cut of its own unsold shares returns to the till
        }
        row
    }

    /// The Market Guild lends a stall up to `amount` coins from its fund (never more than it holds). Recorded as debt.
    pub fn guild_lend(&mut self, merchant: String, amount: U128) -> U128 {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        let guild = self.guild.clone();
        let lent = amount.0.min(self.bal(COIN, &guild));
        if lent == 0 {
            return U128(0);
        }
        self.move_token(&guild, &m.account_id, COIN, lent, "market guild loan");
        let mut s = self.stall(&m.id);
        s.debt += lent;
        self.stalls.insert(m.id.clone(), s);
        self.push_receipt(&m.account_id, "guild loan", COIN, lent, lent, &guild);
        U128(lent)
    }

    /// A stall pays the Guild up to `amount`: first repaying its debt, then, only while the Guild's assets (coin held
    /// plus loans outstanding) are below `fill_to`, as dues. So dues never grow the Guild past its size, and a loan
    /// repaid is not collected twice. Returns (repaid, dues).
    pub fn guild_collect(&mut self, merchant: String, amount: U128, fill_to: U128) -> (U128, U128) {
        self.only_operator();
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        let guild = self.guild.clone();
        let mut s = self.stall(&m.id);
        let till = self.bal(COIN, &m.account_id);
        let repaid = amount.0.min(s.debt).min(till);
        let lent: u128 = self.merchant_ids().iter().map(|id| self.stall(id).debt).sum();
        let assets = self.bal(COIN, &guild) + lent; // a repayment moves debt into coin: assets unchanged
        let dues = (amount.0 - repaid).min(till - repaid).min(fill_to.0.saturating_sub(assets));
        s.debt -= repaid;
        self.stalls.insert(m.id.clone(), s);
        if repaid + dues > 0 {
            self.move_token(&m.account_id, &guild, COIN, repaid + dues, if dues > 0 { "market guild dues" } else { "market guild repayment" });
        }
        (U128(repaid), U128(dues))
    }

    // ---------- merchants ----------

    /// Sets (qty > 0) or clears (qty = 0) the caller's ask for goods at `price` each. Share terms are fixed in the
    /// contract and cannot be listed.
    pub fn list(&mut self, token_id: String, qty: U128, price: U128, per: Option<U128>) {
        let m = self.caller_merchant();
        require!(is_good(&token_id) && per.is_none_or(|p| p.0 == 1), "cannot list this token");
        Self::set_order(&mut self.asks, m.account_id, token_id, qty, price);
    }

    /// Sets or clears the caller's standing bid for goods.
    pub fn bid(&mut self, token_id: String, qty: U128, price: U128, per: Option<U128>) {
        let m = self.caller_merchant();
        require!(is_good(&token_id) && per.is_none_or(|p| p.0 == 1), "can only bid for goods");
        Self::set_order(&mut self.bids, m.account_id, token_id, qty, price);
    }

    // ---------- anyone registered (players and merchants) ----------

    /// Buys from a merchant's ask: coin buyer -> seller, token seller -> buyer, in one receipt. For goods
    /// `max_price` caps the unit price; for stall shares (investing) it caps the total cost, and `qty` must be a
    /// whole number of packs.
    pub fn buy(&mut self, seller: AccountId, token_id: String, qty: U128, max_price: U128) -> Receipt {
        let buyer = env::predecessor_account_id();
        require!(self.players.contains(&buyer), "register first");
        require!(buyer != seller, "cannot trade with yourself");
        self.claim_all(&buyer);
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
        if let Some(id) = self.merchant_of(&seller).map(|m| m.id.clone()) {
            self.add_revenue(&id, cost);
        }
        self.push_receipt(&seller, "sold", &token_id, qty, price, &buyer);
        self.push_receipt(&buyer, "bought", &token_id, qty, price, &seller)
    }

    /// Sells goods into a merchant's standing bid (`min_price` per unit), or stall shares back to the stall's
    /// reserve (`min_price` is then the least total payout).
    pub fn sell(&mut self, buyer: AccountId, token_id: String, qty: U128, min_price: U128) -> Receipt {
        let seller = env::predecessor_account_id();
        require!(self.players.contains(&seller), "register first");
        require!(buyer != seller, "cannot trade with yourself");
        self.claim_all(&seller);
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
    /// nonces only increase per merchant and player (single use, O(1) storage) and `expires_ms` bounds validity.
    #[allow(clippy::too_many_arguments)]
    pub fn deal(&mut self, merchant: String, side: String, token_id: String, qty: U128, unit_price: U128, nonce: U64, expires_ms: U64, signature: Base64VecU8) -> Receipt {
        let player = env::predecessor_account_id();
        require!(self.players.contains(&player), "register first");
        require!(is_good(&token_id), "deals are for goods");
        require!(side == "buy" || side == "sell", "side must be buy or sell");
        require!(env::block_timestamp_ms() <= expires_ms.0, "deal expired");
        let m = self.merchant(&merchant).expect("unknown merchant").clone();
        require!(m.account_id != player, "cannot trade with yourself");
        require!(side == "sell" || self.stall(&m.id).closure.is_none(), "stall is closed");
        let msg = deal_message(&env::current_account_id(), &merchant, &player, &side, &token_id, qty.0, unit_price.0, nonce.0, expires_ms.0);
        let sig: [u8; 64] = signature.0.as_slice().try_into().expect("signature must be 64 bytes");
        let pk: [u8; 32] = m.deal_key.as_bytes()[1..].try_into().expect("bad deal key");
        require!(env::ed25519_verify(&sig, msg.as_bytes(), &pk), "merchant did not sign this deal");
        let nkey = (m.account_id.clone(), player.clone());
        require!(self.deal_nonces.get(&nkey).is_none_or(|last| nonce.0 > *last), "deal already used");
        self.deal_nonces.insert(nkey, nonce.0);
        let (qty, price) = (qty.0, unit_price.0);
        require!(qty > 0 && price > 0, "empty deal");
        self.claim_all(&player);
        let cost = price.checked_mul(qty).expect("overflow");
        let (buyer, seller) = if side == "buy" { (player.clone(), m.account_id.clone()) } else { (m.account_id.clone(), player.clone()) };
        self.move_token(&buyer, &seller, COIN, cost, "deal");
        self.move_token(&seller, &buyer, &token_id, qty, "deal");
        if side == "buy" {
            self.add_revenue(&m.id, cost);
        } else {
            self.restock(&m.account_id, &token_id, qty);
        }
        self.push_receipt(&m.account_id, if side == "buy" { "sold" } else { "bought" }, &token_id, qty, price, &player);
        self.push_receipt(&player, if side == "buy" { "bought" } else { "sold" }, &token_id, qty, price, &m.account_id)
    }

    /// Standard NEP-245 transfer for full-access callers (requires exactly 1 yocto). Shares move in whole packs
    /// between partners only: a stall's unsold shares are not backed and leave only by sale, and a partner returns
    /// shares to the stall by selling them (which releases their backing).
    #[payable]
    pub fn mt_transfer(&mut self, receiver_id: AccountId, token_id: String, amount: U128, approval: Option<(AccountId, u64)>, memo: Option<String>) {
        near_sdk::assert_one_yocto();
        require!(approval.is_none(), "approvals not supported");
        require!(self.players.contains(&receiver_id), "receiver not registered");
        let sender = env::predecessor_account_id();
        require!(sender != receiver_id, "cannot transfer to yourself");
        if let Some(id) = token_id.strip_prefix("share:") {
            let issuer = self.merchant(id).expect("unknown share").account_id.clone();
            require!(sender != issuer && receiver_id != issuer, "stall shares are bought from and sold to the stall");
            require!(amount.0 % PACK == 0, "shares move in whole packs");
        }
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

    pub fn get_guild(&self) -> AccountId {
        self.guild.clone()
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
            for t in GOODS {
                for (side, book) in [("ask", &self.asks), ("bid", &self.bids)] {
                    if let Some(o) = book.get(&(m.account_id.clone(), t.to_string())) {
                        out.push(OfferView { merchant: m.id.clone(), account_id: m.account_id.clone(), token_id: t.into(), side: side.into(), qty: o.qty, price: o.price });
                    }
                }
            }
        }
        out
    }

    /// Every stall's open/closed state, share terms and accounts (reserve, vault, arrears, Guild debt).
    pub fn get_stalls(&self) -> Vec<StallView> {
        self.merchants
            .iter()
            .map(|m| {
                let s = self.stall(&m.id);
                let c = s.closure;
                let token = share_token(&m.id);
                StallView {
                    merchant: m.id.clone(),
                    open: c.is_none(),
                    since_day: c.map(|c| c.since_day),
                    need: c.map_or(U128(0), |c| c.need),
                    delivered: c.map_or(U128(0), |c| c.delivered),
                    holders: s.holders,
                    supply: U128(self.supply.get(&token).copied().unwrap_or(0)),
                    treasury: U128(self.bal(&token, &m.account_id)),
                    pack: U128(PACK),
                    pack_price: m.pack_price,
                    pack_backing: m.pack_backing,
                    reserve: U128(s.reserve),
                    vault: U128(s.vault),
                    revenue: U128(s.revenue),
                    arrears: U128(s.arrears),
                    debt: U128(s.debt),
                    last_settled: s.last_settled,
                    last_rent: s.last_rent,
                    total_declared: U128(s.total_declared),
                    total_funded: U128(s.total_funded),
                    total_paid: U128(s.total_paid),
                }
            })
            .collect()
    }

    /// Dividends owed to an account per stall (whole coins plus the carried fraction), as of now.
    pub fn get_pending(&self, account_id: AccountId) -> Vec<PendingView> {
        self.merchants
            .iter()
            .map(|m| {
                let units = self.owed_units(&m.id, &account_id);
                PendingView { merchant: m.id.clone(), shares: U128(self.bal(&share_token(&m.id), &account_id)), coins: U128(units / ACC_SCALE), fraction: U128(units % ACC_SCALE) }
            })
            .collect()
    }

    /// The recent settlements of a stall (at most MAX_HISTORY), oldest first.
    pub fn get_settlements(&self, merchant: String) -> Vec<Settlement> {
        self.stall(&merchant).history
    }

    pub fn get_revenue(&self, merchant: String) -> U128 {
        U128(self.stall(&merchant).revenue)
    }

    pub fn get_receipts(&self, account_id: AccountId) -> Vec<Receipt> {
        self.receipts.get(&account_id).cloned().unwrap_or_default()
    }

    /// Checks the contract's accounting invariants from live state; anyone can call it. `ok` is true only if every
    /// one holds: custody (the contract's coin = all reserves + vaults), each reserve exactly backs the shares
    /// partners hold, and each vault holds exactly what was funded and not yet paid.
    pub fn audit(&self) -> Audit {
        let here = env::current_account_id();
        let mut sum = 0u128;
        let mut all_ok = true;
        let mut lent = 0u128;
        let stalls = self
            .merchants
            .iter()
            .map(|m| {
                let s = self.stall(&m.id);
                let token = share_token(&m.id);
                let supply = self.supply.get(&token).copied().unwrap_or(0);
                let outside = supply - self.bal(&token, &m.account_id);
                let required = m.pack_backing.0 * outside / PACK;
                let reserve_ok = outside % PACK == 0 && s.reserve == required;
                let vault_ok = s.vault == s.total_funded - s.total_paid;
                all_ok &= reserve_ok && vault_ok;
                sum += s.reserve + s.vault;
                lent += s.debt;
                StallAudit { merchant: m.id.clone(), reserve: U128(s.reserve), reserve_required: U128(required), reserve_ok, vault: U128(s.vault), vault_ok, share_supply: U128(supply) }
            })
            .collect();
        let held = self.bal(COIN, &here);
        let custody_ok = held == sum;
        Audit {
            coin_supply: U128(self.supply.get(COIN).copied().unwrap_or(0)),
            contract_coin: U128(held),
            reserves_and_vaults: U128(sum),
            custody_ok,
            guild: self.guild.clone(),
            guild_coin: U128(self.bal(COIN, &self.guild)),
            guild_lent: U128(lent),
            stalls,
            ok: all_ok && custody_ok,
        }
    }
}

/// Maintenance build only (`--features cleanup`): removes raw storage keys. Callable only by the contract account
/// itself, and compiled out of the market's real code, so the live contract cannot wipe anyone's balances.
#[cfg(feature = "cleanup")]
#[near]
impl Market {
    #[private]
    pub fn clean(keys: Vec<Base64VecU8>) {
        for k in keys {
            env::storage_remove(&k.0);
        }
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

    fn merchant_ids(&self) -> Vec<String> {
        self.merchants.iter().map(|m| m.id.clone()).collect()
    }

    fn caller_merchant(&self) -> Merchant {
        self.merchant_of(&env::predecessor_account_id()).cloned().expect("merchants only")
    }

    fn stall(&self, id: &str) -> Stall {
        self.stalls.get(id).cloned().unwrap_or_default()
    }

    fn all_tokens(&self) -> Vec<String> {
        let mut t: Vec<String> = std::iter::once(COIN).chain(GOODS).map(String::from).collect();
        t.extend(self.merchants.iter().map(|m| share_token(&m.id)));
        t
    }

    fn bal(&self, token: &str, account: &AccountId) -> u128 {
        self.balances.get(&(token.to_string(), account.clone())).copied().unwrap_or(0)
    }

    fn add_revenue(&mut self, id: &str, amount: u128) {
        let mut s = self.stall(id);
        s.revenue = s.revenue.checked_add(amount).expect("overflow");
        self.stalls.insert(id.to_string(), s);
    }

    /// Dividend owed to `who` for stall `id`, in 1/ACC_SCALE coin.
    fn owed_units(&self, id: &str, who: &AccountId) -> u128 {
        let acc = self.stall(id).acc;
        let p = self.positions.get(&(share_token(id), who.clone())).copied().unwrap_or(Position { cp: acc, carry: 0 });
        self.bal(&share_token(id), who).checked_mul(acc - p.cp).expect("overflow") + p.carry
    }

    /// Brings a holder's checkpoint up to date and pays the whole coins owed from the vault. Called before every
    /// change to a share balance, so the balance used is always the one that earned the dividend.
    fn settle_holder(&mut self, id: &str, who: &AccountId) {
        let key = (share_token(id), who.clone());
        if self.merchant(id).is_none() || (self.bal(&key.0, who) == 0 && self.positions.get(&key).is_none()) {
            return; // holds nothing and is owed nothing: no record to keep
        }
        let units = self.owed_units(id, who);
        let (pay, carry) = (units / ACC_SCALE, units % ACC_SCALE);
        let mut s = self.stall(id);
        // Always written: the balance is about to change, and a holder must never be left without a checkpoint.
        // `debit` drops it again when a balance reaches zero with nothing owed.
        self.positions.insert(key, Position { cp: s.acc, carry });
        if pay > 0 {
            s.vault -= pay; // cannot underflow: see the vault bound in docs/ECONOMY_MATH.md
            s.total_paid += pay;
            self.stalls.insert(id.to_string(), s);
            let merchant = self.merchant(id).expect("unknown merchant").account_id.clone();
            self.move_token(&env::current_account_id(), who, COIN, pay, "dividend");
            self.push_receipt(who, "dividend", COIN, pay, pay, &merchant);
        }
    }

    fn add_carry(&mut self, id: &str, who: &AccountId, carry: u128) {
        if carry == 0 {
            return;
        }
        self.settle_holder(id, who);
        let key = (share_token(id), who.clone());
        let acc = self.stall(id).acc;
        let p = self.positions.get(&key).copied().unwrap_or(Position { cp: acc, carry: 0 });
        self.positions.insert(key, Position { cp: p.cp, carry: p.carry + carry });
        self.settle_holder(id, who);
    }

    fn claim_all(&mut self, who: &AccountId) -> u128 {
        let before = self.bal(COIN, who);
        for id in self.merchant_ids() {
            self.settle_holder(&id, who);
        }
        self.bal(COIN, who) - before
    }

    /// The share's stall id, if `token` is a known stall share.
    fn stall_of(&self, token: &str) -> Option<String> {
        token.strip_prefix("share:").filter(|id| self.merchant(id).is_some()).map(String::from)
    }

    fn is_issuer(&self, id: &str, account: &AccountId) -> bool {
        self.merchant(id).is_some_and(|m| &m.account_id == account)
    }

    fn credit(&mut self, account: &AccountId, token: &str, amount: u128) {
        let id = self.stall_of(token);
        if let Some(id) = &id {
            self.settle_holder(id, account);
            let key = (token.to_string(), account.clone());
            if self.positions.get(&key).is_none() {
                let acc = self.stall(id).acc; // a new holder earns from now on, never retroactively
                self.positions.insert(key, Position { cp: acc, carry: 0 });
            }
        }
        let old = self.bal(token, account);
        self.balances.insert((token.to_string(), account.clone()), old.checked_add(amount).expect("overflow"));
        if let Some(id) = id {
            if old == 0 && !self.is_issuer(&id, account) {
                let mut s = self.stall(&id);
                s.holders += 1;
                self.stalls.insert(id, s);
            }
        }
    }

    fn debit(&mut self, account: &AccountId, token: &str, amount: u128) {
        let id = self.stall_of(token);
        if let Some(id) = &id {
            self.settle_holder(id, account);
        }
        let b = self.bal(token, account);
        require!(b >= amount, format!("not enough {token}"));
        let key = (token.to_string(), account.clone());
        if b == amount {
            self.balances.remove(&key);
            if let Some(id) = id {
                let pkey = (token.to_string(), account.clone());
                if self.positions.get(&pkey).is_some_and(|p| p.carry == 0) {
                    self.positions.remove(&pkey); // nothing owed and nothing held: no record needed
                }
                if !self.is_issuer(&id, account) {
                    let mut s = self.stall(&id);
                    s.holders -= 1;
                    self.stalls.insert(id, s);
                }
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

    fn burn(&mut self, account: &AccountId, token: &str, amount: u128, memo: &str) {
        require!(amount > 0, "zero amount");
        self.debit(account, token, amount);
        let s = self.supply.get(token).copied().unwrap_or(0);
        self.supply.insert(token.to_string(), s - amount);
        emit("mt_burn", json!({ "owner_id": account, "token_ids": [token], "amounts": [amount.to_string()], "memo": memo }));
    }

    fn is_closed(&self, account: &AccountId) -> bool {
        self.merchant_of(account).is_some_and(|m| self.stall(&m.id).closure.is_some())
    }

    /// Mangoes reaching a closed stall count toward its reopening; it opens the moment they cover the need.
    fn restock(&mut self, account: &AccountId, token: &str, qty: u128) {
        if token != "mango" {
            return;
        }
        let Some(id) = self.merchant_of(account).map(|m| m.id.clone()) else { return };
        let mut s = self.stall(&id);
        let Some(mut c) = s.closure else { return };
        c.delivered = U128(c.delivered.0 + qty);
        if c.delivered.0 >= c.need.0 {
            s.closure = None;
            env::log_str(&format!("stall {id} reopened: {} of {} mangoes delivered", c.delivered.0, c.need.0));
        } else {
            s.closure = Some(c);
        }
        self.stalls.insert(id, s);
    }

    /// A partner invests (`buying`) or sells back to the stall that `merchant_acct` runs. `limit` is the most the
    /// partner pays, or the least they accept, in total coins. Buying takes the stall's unsold shares first and
    /// issues new ones for the rest; selling is always possible and pays exactly the backing from the reserve.
    fn trade_shares(&mut self, buying: bool, player: AccountId, merchant_acct: AccountId, token: String, qty: u128, limit: u128) -> Receipt {
        let m = self.merchant_of(&merchant_acct).cloned().expect("shares trade with their stall");
        require!(token == share_token(&m.id), "shares trade with their own stall");
        require!(qty > 0 && qty % PACK == 0, format!("shares trade in packs of {PACK}"));
        let packs = qty / PACK;
        require!(packs <= MAX_PACKS, "too many shares at once");
        let here = env::current_account_id();
        if buying {
            let total = packs * m.pack_price.0;
            let backing = packs * m.pack_backing.0;
            require!(total <= limit, "share price moved above your limit");
            self.move_token(&player, &m.account_id, COIN, total, "invest");
            self.move_token(&m.account_id, &here, COIN, backing, "share reserve");
            let mut s = self.stall(&m.id);
            s.reserve += backing;
            self.stalls.insert(m.id.clone(), s);
            let from_treasury = qty.min(self.bal(&token, &m.account_id));
            if from_treasury > 0 {
                self.move_token(&m.account_id, &player, &token, from_treasury, "invest");
            }
            if qty > from_treasury {
                self.mint(&player, &token, qty - from_treasury, "new issue");
            }
            self.push_receipt(&m.account_id, "sold shares", &token, qty, total, &player);
            self.push_receipt(&player, "invested", &token, qty, total, &m.account_id)
        } else {
            let total = packs * m.pack_backing.0;
            require!(total >= limit, "buyback price dropped below your limit");
            self.move_token(&player, &m.account_id, &token, qty, "share buyback");
            let mut s = self.stall(&m.id);
            s.reserve -= total; // cannot underflow: the reserve backs every share partners hold
            self.stalls.insert(m.id.clone(), s);
            self.move_token(&here, &player, COIN, total, "share buyback");
            self.push_receipt(&m.account_id, "bought back", &token, qty, total, &player);
            self.push_receipt(&player, "cashed out", &token, qty, total, &m.account_id)
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
        if account == &env::current_account_id() {
            return r;
        }
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
