// Dev-only playtest harness for the character quality gate (not part of the build; never imported by the game).
// In the running dev game: eval(await (await fetch("/tools/gate-harness.js")).text()), then
//   __gate.run(seconds)   steps the real game loop with every walker forced on-screen and records, per townsperson model:
//                         hip jumps > 12 cm in one frame (pops), planted-toe slide speed, sole-vs-ground error, states
//   __gate.report()       per-model summary
//   __gate.cam(i, tag)    shoots npc i from a fixed 3/4 angle into docs/evidence/gate-<tag>-<name>.jpg
const v = window.__v2, P = window.__npcs, V = v.camera.position.constructor;
const NAMES = ["pema", "tomas", "mira", "arin", "bram", "ines", "noor", "joon", "hadi", "lena", "suki", "rafa"];
const modelOf = (i) => NAMES[6 + ((i - 6) % 6)];
const W = P.map((p, i) => i).filter((i) => !P[i].fixed);
W.forEach((i) => Object.defineProperty(P[i], "onScreen", { get: () => true, set() {}, configurable: true }));
const tmp = new V(), B = {}, prev = {}, stat = {};
W.forEach((i) => {
  const o = {};
  P[i].c.root.traverse((b) => {
    if (!b.isBone) return;
    if (/Hips$/.test(b.name)) o.hips = b;
    if (/LeftToeBase$/.test(b.name)) o.lt = b;
    if (/RightToeBase$/.test(b.name)) o.rt = b;
  });
  B[i] = o;
  stat[i] = { model: modelOf(i), jumps: 0, maxJump: 0, slide: [], minGround: 9, maxGround: -9, changes: 0, last: P[i].state, states: {} };
});
const soleErr = (p) => {
  let min = 1e9;
  p.c.root.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.skeleton.update();
    const t = new V(), n = o.geometry.attributes.position.count;
    for (let k = 0; k < n; k += 40) { o.getVertexPosition(k, t); o.applyBoneTransform(k, t); o.localToWorld(t); if (t.y < min) min = t.y; }
  });
  return min - p.c.root.getWorldPosition(new V()).y;
};
const run = (sec) => {
  for (let f = 0; f < sec * 60; f++) {
    v.sim(1 / 60);
    W.forEach((i) => {
      const p = P[i], b = B[i], s = stat[i];
      p.c.root.updateMatrixWorld(true);
      const rw = p.c.root.getWorldPosition(tmp).y;
      const hips = b.hips.getWorldPosition(new V()), lt = b.lt.getWorldPosition(new V()), rt = b.rt.getWorldPosition(new V());
      const pv = prev[i];
      s.states[p.state] = (s.states[p.state] || 0) + 1;
      if (p.state !== s.last) { s.changes++; s.last = p.state; }
      if (pv) {
        const dj = Math.abs(hips.y - rw - pv.hy);
        if (dj > 0.12) s.jumps++;
        s.maxJump = Math.max(s.maxJump, dj);
        if (p.state === "walk" && p.spd > 0.8) {
          [[lt, pv.lt], [rt, pv.rt]].forEach(([c, q]) => {
            const sp = Math.hypot(c.x - q.x, c.z - q.z) * 60;
            if (c.y - rw < 0.06 && q.y - pv.rw < 0.06 && sp < 3) s.slide.push(sp); // > 3 m/s is a doorway respawn, not a slide
          });
        }
      }
      if (f % 30 === 0 && (p.state !== "act" || p.c.lift < 0.01)) {
        const e = soleErr(p);
        s.minGround = Math.min(s.minGround, e); s.maxGround = Math.max(s.maxGround, e);
      }
      prev[i] = { hy: hips.y - rw, lt: lt.clone(), rt: rt.clone(), rw };
    });
  }
};
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
const report = () => {
  const by = {};
  Object.values(stat).forEach((s) => {
    const m = (by[s.model] = by[s.model] || { inst: 0, jumps: 0, maxJump: 0, slide: [], minG: 9, maxG: -9, changes: 0, states: {} });
    m.inst++; m.jumps += s.jumps; m.maxJump = Math.max(m.maxJump, s.maxJump); m.slide.push(...s.slide);
    m.minG = Math.min(m.minG, s.minGround); m.maxG = Math.max(m.maxG, s.maxGround); m.changes += s.changes;
    Object.entries(s.states).forEach(([k, c]) => (m.states[k] = (m.states[k] || 0) + c));
  });
  return Object.fromEntries(Object.entries(by).map(([k, m]) => [k, {
    inst: m.inst, popsOver12cm: m.jumps, slideMedian: +med(m.slide).toFixed(2),
    slideP95: +(m.slide.slice().sort((a, b) => a - b)[Math.floor(m.slide.length * 0.95)] ?? 0).toFixed(2),
    ground: [+m.minG.toFixed(2), +m.maxG.toFixed(2)], stateChanges: m.changes, states: m.states }]));
};
const cam = (i, tag, ang = 0.5, dist = 3) => {
  const p = P[i], w = p.c.root.getWorldPosition(new V()), a = p.yaw + ang;
  p.root.visible = true;
  v.camera.position.set(w.x + Math.sin(a) * dist, w.y + 1.35, w.z + Math.cos(a) * dist);
  v.camera.lookAt(w.x, w.y + 1.0, w.z);
  v.camera.updateMatrixWorld(true);
  return v.shot("gate-" + tag + "-" + (i < 6 ? NAMES[i] : modelOf(i)) + "-" + i);
};
window.__gate = { run, report, cam, stat, NAMES, W };
"harness ready";
