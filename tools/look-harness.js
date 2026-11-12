// Dev-only: identical-camera character shots at noon, sunset and night, for before/after lighting comparisons.
// Needs only the running dev game (the title screen is enough; nothing is entered, no chain call is made):
//   eval(await (await fetch("/tools/look-harness.js")).text()); await __look.all("before")
// Townsfolk and Kavi are placed at one fixed plaza spot (everyone else is parked far away) so the backdrop and light
// are identical for every subject and for before/after runs; merchants stay at their stalls. Writes
// docs/evidence/look-<tag>-<time>-<subject>.jpg through the dev-only /__evidence endpoint.
const v = window.__v2, P = window.__npcs, V = v.camera.position.constructor;
const NPC = ["pema", "tomas", "mira", "arin", "bram", "ines", "noor", "joon", "hadi", "lena", "suki", "rafa"];
const TIMES = { noon: 12 * 60, sunset: 19 * 60, night: 22.5 * 60 };
const SPOT = { x: 0, z: -22, yaw: Math.PI }; // plaza, facing the Spire
const BENCH = { x: 40.1, z: 1.4, yaw: Math.PI }; // a bench by the market stalls: the seated subject
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const look = v.game.look;
async function setTime(min) { look.setTime(min); await wait(650); look.setTime(min); } // env map re-bake is throttled
const park = () => P.forEach((p) => { if (!p.fixed) { p.x = 300; p.z = 300; p.state = "idle"; p.t = 9999; p.spd = 0; } });
function place(p, at, action) {
  Object.assign(p, { x: at.x, z: at.z, yaw: at.yaw, state: "idle", t: 9999, spd: 0, hidden: false });
  p.root.visible = true;
  p.c.setAction(action, false);
  p.c.lift = action === "Sit" ? 0.37 : 0;
  for (let k = 0; k < 30; k++) p.c.update(0.04);
}
async function one(tag, time, subject, seated = false) {
  const min = TIMES[time];
  let root, face;
  if (subject === "kavi") {
    park();
    v.player.root.visible = true;
    Object.assign(v.player.body, { x: SPOT.x, z: SPOT.z });
    v.sim(0.3);
    root = v.player.root; face = v.player.root.rotation.y;
  } else {
    const i = NPC.indexOf(subject), p = P[i];
    v.player.root.visible = false; // Kavi only appears in his own shots
    if (!p.fixed) { park(); place(p, seated ? BENCH : SPOT, seated ? "Sit" : null); v.sim(0.02); place(p, seated ? BENCH : SPOT, seated ? "Sit" : null); }
    p.root.visible = true; root = p.c.root; face = p.yaw;
  }
  await setTime(min); // after every sim: the game's own step resets the clock
  const w = root.getWorldPosition(new V()), a = face + (subject === "ines" ? -0.7 : 0.45), d = subject === "ines" ? 3.4 : 2.7;
  v.camera.position.set(w.x + Math.sin(a) * d, w.y + 1.25, w.z + Math.cos(a) * d);
  v.camera.lookAt(w.x, w.y + 0.95, w.z);
  v.camera.updateMatrixWorld(true);
  return v.shot(`look-${tag}-${time}-${seated ? subject + "-seated" : subject}`);
}
async function run(tag, time) {
  const res = [];
  for (const s of ["kavi", ...NPC]) res.push((await one(tag, time, s)).slice(0, 3));
  res.push((await one(tag, time, "rafa", true)).slice(0, 3));
  return res.join(",");
}
window.__look = { run, one, setTime, NPC, TIMES };
"look harness ready";
