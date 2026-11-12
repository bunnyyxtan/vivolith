// The Mango Orchard's pickup, in the world: a crate beside the orchard sign holding today's share (ORCHARD_PICK
// mangoes). Ripe fruit sits in it while picking is open and this player has not picked this market day; a confirmed
// pick lifts each mango out in an arc into Kavi's hands. Nothing here decides a pick: play.ts calls pickTo() only
// after NEAR (or the offline market) has answered.
import * as THREE from "three";
import { applyToon } from "./toon";

const FLY_SEC = 0.55, STAGGER_SEC = 0.16, ARC_M = 1.1, BOB_HZ = 1.6;

export interface OrchardBasket {
  readonly at: THREE.Vector3;
  /** Fruit visible (ready to pick) or not (picked, or outside the picking hours). */
  setReady(ready: boolean): void;
  /** While a pick is in flight the fruit trembles. */
  setBusy(busy: boolean): void;
  /** Flies the fruit to `to()` (Kavi's hands), one after another. */
  pickTo(to: () => THREE.Vector3): void;
  update(dt: number): void;
}

export function createOrchardBasket(scene: THREE.Scene, at: THREE.Vector3, count: number): OrchardBasket {
  const root = new THREE.Group();
  root.name = "ORCHARD_basket";
  root.position.copy(at);
  const wood = new THREE.MeshStandardMaterial({ color: "#b07a45", roughness: 0.85 });
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.34, 0.5), wood);
  crate.position.y = 0.17;
  root.add(crate);
  const fruitMat = new THREE.MeshStandardMaterial({ color: "#f6a623", roughness: 0.45, emissive: "#f08a00", emissiveIntensity: 0.25 });
  const blush = new THREE.MeshStandardMaterial({ color: "#e8682c", roughness: 0.5 });
  const geo = new THREE.SphereGeometry(0.1, 16, 12);
  const fruit: THREE.Mesh[] = [];
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(geo, i % 2 ? blush : fruitMat);
    m.scale.set(1, 0.82, 0.82);
    m.userData.home = new THREE.Vector3((i - (count - 1) / 2) * 0.2, 0.4, (i % 2) * 0.06 - 0.03);
    m.position.copy(m.userData.home);
    fruit.push(m);
    root.add(m);
  }
  applyToon(root, 0.01, "#1a2238", true);
  scene.add(root);

  let ready = false, busy = false, t = 0;
  const flights: { m: THREE.Mesh; from: THREE.Vector3; to: () => THREE.Vector3; t: number }[] = [];
  const show = (): void => { for (const m of fruit) { m.visible = ready || flights.some((f) => f.m === m); } };
  return {
    at: root.position,
    setReady(r) { ready = r; if (r) for (const m of fruit) { m.position.copy(m.userData.home); m.scale.set(1, 0.82, 0.82); } show(); },
    setBusy(b) { busy = b; },
    pickTo(to) {
      fruit.forEach((m, i) => {
        m.visible = true;
        flights.push({ m, from: m.getWorldPosition(new THREE.Vector3()), to, t: -i * STAGGER_SEC });
      });
      ready = false;
    },
    update(dt) {
      t += dt;
      if (ready && !flights.length) {
        fruit.forEach((m, i) => {
          const h = m.userData.home as THREE.Vector3;
          m.position.set(h.x + (busy ? Math.sin(t * 40 + i) * 0.01 : 0), h.y + Math.sin(t * BOB_HZ * Math.PI * 2 + i) * 0.015, h.z);
        });
      }
      for (let i = flights.length - 1; i >= 0; i--) {
        const f = flights[i];
        f.t += dt;
        if (f.t < 0) continue;
        const k = Math.min(1, f.t / FLY_SEC), end = f.to();
        const p = f.from.clone().lerp(end, k);
        p.y += Math.sin(k * Math.PI) * ARC_M;
        f.m.position.copy(root.worldToLocal(p));
        const s = 1 - 0.6 * k * k;
        f.m.scale.set(s, s * 0.82, s * 0.82);
        if (k >= 1) { f.m.visible = false; flights.splice(i, 1); }
      }
      if (!flights.length) show();
    },
  };
}
