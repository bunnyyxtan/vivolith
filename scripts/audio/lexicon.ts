// The closed vocabulary of VIVOLITH's spoken lines: every word that appears inside a string literal of the game's text
// sources. The voice route speaks a line without a server-issued speech token only if every word is in it (plus
// numbers and one name), so it cannot be used as a general text-to-speech service. Run by scripts/build-api.mjs;
// lexicon.check (in server/near/voice.check.ts) fails when the committed file is stale.
//   node scripts/audio/lexicon.ts            writes server/near/lexicon.json
//   node scripts/audio/lexicon.ts --check    exits 1 when it would change
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOTS = ["src/v2", "src/economy", "src/quests", "src/near", "server/near/talk.ts"];
const OUT = "server/near/lexicon.json";

function files(p: string): string[] {
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p).flatMap((f) => files(path.join(p, f))).filter((f) => f.endsWith(".ts") && !f.endsWith(".check.ts"));
}

export function lexicon(): string[] {
  const words = new Set<string>();
  const add = (t: string): void => { for (const w of t.toLowerCase().match(/[a-z]+(?:'[a-z]+)*/g) ?? []) words.add(w); };
  for (const f of ROOTS.flatMap(files)) {
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true));
  }
  return [...words].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const next = JSON.stringify(lexicon()) + "\n";
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (process.argv.includes("--check")) { if (now !== next) { console.error(`${OUT} is stale: node scripts/audio/lexicon.ts`); process.exit(1); } }
  else { fs.writeFileSync(OUT, next); console.log(`${OUT}: ${JSON.parse(next).length} words`); }
}
