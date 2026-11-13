// The approved spoken sentences of VIVOLITH: every sentence the game's text sources can produce, read with the
// TypeScript type checker. A sentence from a plain string literal is approved exactly. A sentence from a template
// literal is approved as a shape whose slots may only be what their type allows: a number (digits), one of a closed set
// of string literals, a game clock (clockOf) or a player's name (one capitalised word, slots named `name`); strings
// joined with + are read as one template. A sentence with any other slot
// (free text) is not approved. The voice route speaks a line without a server speech token only if every sentence of it
// is approved, so it cannot be used to compose new text. Run by scripts/build-api.mjs; voice.check fails when stale.
//   node scripts/audio/lines.ts            writes server/near/lines.json
//   node scripts/audio/lines.ts --check    exits 1 when it would change
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { CLOCK, NUM, NAME, sentences } from "../../server/near/lines-match.ts";

const ROOTS = ["src/v2", "src/economy", "src/quests", "src/near", "server/near/talk.ts"];
const OUT = "server/near/lines.json";
const MAX_UNION = 40;
const MAX_VARIANTS = 64;

function files(p: string): string[] {
  if (fs.statSync(p).isFile()) return [p];
  return fs.readdirSync(p).flatMap((f) => files(path.join(p, f))).filter((f) => f.endsWith(".ts") && !f.endsWith(".check.ts"));
}
const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (t: string): string => t.replace(/\s+/g, " ").trim();

export function approved(): { exact: string[]; shapes: string[] } {
  const roots = ROOTS.flatMap(files);
  const program = ts.createProgram(roots, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, strict: true, resolveJsonModule: true });
  const checker = program.getTypeChecker();
  const exact = new Set<string>(), shapes = new Set<string>();
  // a slot's pattern, or null when it can hold free text
  const slot = (e: ts.Expression): string | null => {
    const t = checker.getTypeAtLocation(e);
    const parts = t.isUnion() ? t.types : [t];
    if (parts.every((p) => p.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike))) return NUM;
    if (parts.length <= MAX_UNION && parts.every((p) => p.isStringLiteral() || p.isNumberLiteral())) {
      return `(?:${parts.map((p) => (p.isNumberLiteral() ? String(p.value) : esc(norm(String((p as ts.StringLiteralType).value))))).join("|")})`;
    }
    if (ts.isCallExpression(e) && e.expression.getText() === "clockOf") return CLOCK;
    if (/name(?:\(\w*\))?$/i.test(e.getText()) && parts.every((p) => p.flags & ts.TypeFlags.StringLike)) return NAME;
    return null;
  };
  // a string joined with + is read whole (outermost join only; a template inside one is read with it)
  const stringy = (e: ts.Node): boolean => (checker.getTypeAtLocation(e).flags & ts.TypeFlags.StringLike) !== 0;
  const isPlus = (e: ts.Node): boolean => ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken && stringy(e);
  const inJoin = (e: ts.Node): boolean => { let p = e.parent; while (p && ts.isParenthesizedExpression(p)) p = p.parent; return !!p && (isPlus(p) || ts.isTemplateSpan(p)); };
  const isConcat = (e: ts.Node): boolean => isPlus(e) && !inJoin(e);
  for (const sf of program.getSourceFiles()) {
    if (!roots.some((r) => path.resolve(r) === path.resolve(sf.fileName))) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) for (const s of sentences(norm(n.text))) exact.add(s);
      if (ts.isTemplateExpression(n) || isConcat(n)) {
        // placeholders \u0000<k>\u0001 stand for slot k while the template is split into sentences
        // each variant of the text (a `c ? "a" : "b"` inside it gives one variant per branch), slots as placeholders
        const pats: (string | null)[] = [];
        const cross = (a: string[], b: string[]): string[] => a.flatMap((x) => b.map((y) => x + y));
        const hole = (e: ts.Expression): string[] => { pats.push(slot(e)); return [`\u0000${pats.length - 1}\u0001`]; };
        const expand = (e: ts.Expression): string[] => {
          if (ts.isParenthesizedExpression(e)) return expand(e.expression);
          if (isPlus(e)) return cross(expand((e as ts.BinaryExpression).left), expand((e as ts.BinaryExpression).right));
          if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
          if (ts.isTemplateExpression(e)) return e.templateSpans.reduce((acc, sp) => cross(cross(acc, expand(sp.expression)), [sp.literal.text]), [e.head.text]);
          if (ts.isConditionalExpression(e) && stringy(e.whenTrue) && stringy(e.whenFalse)) {
            const v = [...expand(e.whenTrue), ...expand(e.whenFalse)];
            return v.length <= MAX_VARIANTS ? v : hole(e);
          }
          return hole(e);
        };
        const variants = expand(n as ts.Expression);
        for (const s of (variants.length <= MAX_VARIANTS ? variants : []).flatMap((raw) => sentences(norm(raw)))) {
          const ids = [...s.matchAll(/\u0000(\d+)\u0001/g)].map((m) => Number(m[1]));
          if (!ids.length) { exact.add(s); continue; }
          if (ids.some((i) => pats[i] === null)) continue; // free text: not approved
          shapes.add(s.split(/\u0000\d+\u0001/).map(esc).reduce((a, lit, i) => a + pats[ids[i - 1]] + lit));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { exact: [...exact].filter((s) => /\p{L}/u.test(s)).sort(), shapes: [...shapes].sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const a = approved();
  const next = JSON.stringify(a) + "\n";
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (process.argv.includes("--check")) { if (now.trim() !== next.trim()) { console.error(`${OUT} is stale: node scripts/audio/lines.ts`); process.exit(1); } }
  else { fs.writeFileSync(OUT, next); console.log(`${OUT}: ${a.exact.length} sentences, ${a.shapes.length} shapes`); }
}
