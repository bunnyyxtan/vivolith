// Production deploy that cannot drift from git: refuses a dirty tree, stamps the commit into the build, then reads
// the live page back and fails unless it reports that commit.   npm run deploy
import { execSync } from "node:child_process";

const LIVE = "https://vivolith.vercel.app/";
const sh = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

const dirty = sh("git status --porcelain --untracked-files=no");
if (dirty) {
  console.error(`Refusing to deploy: uncommitted changes would ship without a commit.\n${dirty}`);
  process.exit(1);
}
const commit = sh("git rev-parse --short HEAD");
console.log(`Deploying ${commit} (${sh("git log -1 --format=%s")})`);
const url = /https:\/\/[\w.-]+\.vercel\.app/.exec(sh(`npx vercel deploy --prod --yes --build-env VIVOLITH_COMMIT=${commit}`))?.[0];
console.log(`Deployment ${url}`);

const html = await (await fetch(`${LIVE}?v=${Date.now()}`, { headers: { "cache-control": "no-cache" } })).text();
const live = /name="vivolith-commit" content="([^"]+)"/.exec(html)?.[1];
if (live !== commit) {
  console.error(`${LIVE} reports ${live ?? "no commit"}, expected ${commit}`);
  process.exit(1);
}
console.log(`${LIVE} is serving ${commit}`);
