// Economy data model + the starting state of Saltlight Market. Pure data, no rendering.

export type Good = "mango" | "lemon" | "lassi";
export const GOODS: readonly Good[] = ["mango", "lemon", "lassi"];
export type Stock = Record<Good, number>;

export type MerchantId = "pema" | "tomas" | "teahouse";

export interface Merchant {
  readonly id: MerchantId;
  readonly name: string;
  readonly shop: string;
  /** Goods this merchant sells to shoppers. */
  readonly sells: readonly Good[];
  readonly baseCost: Stock;
  /** Stock level the merchant considers "normal" (scarcity pricing is relative to this). */
  readonly target: Stock;
  /** 0..1: how hard the merchant pushes prices up. */
  readonly greed: number;
  readonly rent: number;
  readonly rentEveryDays: number;
  cash: number;
  stock: Stock;
  /** Exponentially decayed units sold per hour (demand signal). */
  recentSales: Stock;
  status: "open" | "closed";
}

export type ShipmentStatus = "held" | "transit" | "delivered";

export interface Shipment {
  readonly id: string;
  readonly to: MerchantId;
  readonly good: Good;
  readonly qty: number;
  /** Fee the harbor charges to release a held shipment early. */
  readonly releaseFee: number;
  /** Game minute when a held shipment is released anyway (bureaucracy clears). */
  readonly autoReleaseAt: number;
  status: ShipmentStatus;
  arriveAt: number | null;
}

export interface EconEvent {
  readonly minute: number;
  readonly kind: "trade" | "rent" | "closed" | "reopened" | "shipment" | "player" | "quest";
  readonly text: string;
}

export interface DaySample {
  readonly day: number;
  readonly pemaMango: number;
  readonly tomasMango: number;
  readonly lassi: number;
  readonly pemaCash: number;
  readonly pemaOpen: boolean;
}

/** A deal receipt and its NEAR settlement status. "local" = never sent to the chain (said so in the UI). */
export interface Receipt {
  readonly id: string;
  readonly kind: string;
  readonly minute: number;
  readonly summary: string;
  status: "pending" | "onchain" | "local" | "failed";
  txHash?: string;
  accountId?: string;
  contractId?: string;
  message?: string;
}

export interface EconomyState {
  readonly version: 1;
  receipts: Receipt[];
  /** Game minutes since Day 1 00:00. */
  minute: number;
  merchants: Record<MerchantId, Merchant>;
  shipments: Shipment[];
  player: { coins: number; inventory: Stock; rep: Record<MerchantId, number> };
  /** Fractional shopper demand carried between ticks (keeps the sim deterministic and smooth). */
  carry: Record<string, number>;
  flags: Record<string, string | number | boolean>;
  log: EconEvent[];
  history: DaySample[];
}

export const MINUTES_PER_DAY = 24 * 60;
export const START_MINUTE = 9 * 60; // Day 1, 09:00
const stock = (mango: number, lemon: number, lassi: number): Stock => ({ mango, lemon, lassi });

export function initialEconomy(): EconomyState {
  return {
    version: 1,
    receipts: [],
    minute: START_MINUTE,
    merchants: {
      pema: {
        id: "pema", name: "Auntie Pema", shop: "Pema's Fruit",
        sells: ["mango", "lemon"], baseCost: stock(3, 1, 0), target: stock(24, 30, 0),
        greed: 0.15, rent: 40, rentEveryDays: 2,
        cash: 12, stock: stock(3, 16, 0), recentSales: stock(0, 0, 0), status: "open",
      },
      tomas: {
        id: "tomas", name: "Tomas Vell", shop: "Vell's Fine Produce",
        sells: ["mango", "lemon"], baseCost: stock(3, 1, 0), target: stock(30, 30, 0),
        greed: 0.75, rent: 40, rentEveryDays: 2,
        cash: 260, stock: stock(28, 30, 0), recentSales: stock(0, 0, 0), status: "open",
      },
      teahouse: {
        id: "teahouse", name: "Saltlight Tea House", shop: "Saltlight Tea House",
        sells: ["lassi"], baseCost: stock(3, 1, 2), target: stock(6, 0, 16),
        greed: 0.3, rent: 30, rentEveryDays: 2,
        cash: 90, stock: stock(2, 0, 8), recentSales: stock(0, 0, 0), status: "open",
      },
    },
    shipments: [
      {
        id: "pema-mangoes", to: "pema", good: "mango", qty: 30, releaseFee: 15,
        autoReleaseAt: 3 * MINUTES_PER_DAY + 8 * 60, // Day 4, 08:00
        status: "held", arriveAt: null,
      },
    ],
    player: { coins: 25, inventory: stock(0, 0, 0), rep: { pema: 0, tomas: 0, teahouse: 0 } },
    carry: {},
    flags: {},
    log: [{ minute: START_MINUTE, kind: "shipment", text: "Pema's mango shipment is held at the harbor." }],
    history: [],
  };
}

export const dayOf = (minute: number): number => Math.floor(minute / MINUTES_PER_DAY) + 1;
export const clockOf = (minute: number): string => {
  const m = minute % MINUTES_PER_DAY;
  return `Day ${dayOf(minute)} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
};
