// How frontend/src was recovered from the deployed (minified) phone bundle. Kept for reference; run once.
//   1. npx webcrack recovered/phone-dist/assets/index-BFl6V9sJ.js -o wc     (un-minify, rebuild JSX)
//   2. sed -n '11656,12629p;41281,44051p' wc/deobfuscated.js > app.raw.jsx   (app code only: no React/Recharts)
//   3. node unbundle.mjs app.raw.jsx out_dir                                 (needs @babel/* and prettier)
// It names every top-level declaration (MODULES), restores imports from react/recharts, turns
// `(t = x) == null ? undefined : t.y` back into `x?.y`, renames `{ title: e }` to `{ title }`, and splits the code
// into modules with their imports and exports. Hand-edited afterwards: api.js (the PC transport the phone build
// had removed), App.jsx (PC drop-to-upload and rescan), main.jsx, phone/snapshot.js and phone/engine.worker.js.
import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseMod from "@babel/traverse";
import generateMod from "@babel/generator";
import * as t from "@babel/types";
import * as prettier from "prettier";

const traverse = traverseMod.default;
const generate = generateMod.default;
const [inFile, outDir] = process.argv.slice(2);
const ast = parse(fs.readFileSync(inFile, "utf8"), { sourceType: "module", plugins: ["jsx"] });

// ---------------------------------------------------------------- names
const MODULES = {
  "api.js": "VIEW_ONLY:Fh scopeIds:zh setScope:gd withScope:mN request:Fa api:Q",
  "format.js": "wholeDollars:U1 cents:vN money:K moneyCents:te compactMoney:yN pct:sn signedMoney:H1 monthLabel:ae dayLabel:sr today:ai parseAmount:Tu",
  "context.js": "AppContext:K1 useApp:ve useApi:de PhoneContext:q1 usePhone:bN",
  "components/ui.jsx": "Card:J PageHead:He Loading:Qt Empty:Fr Stat:_Component2 SEVERITY:gN Alert:Zc Tabs:V1 hashParams:G1",
  "components/charts.jsx": "SERIES_COLORS:XY OTHER_COLOR:Ow colorMap:pl topKeys:QY axisProps:It yAxisProps:Vt gridProps:Gt ChartTooltip:_Component5 Legend:Un BarList:_Component14 Sparkline:ZY",
  "components/ViewingPicker.jsx": "ViewingPicker:_Component25",
  "components/ThemeSwitch.jsx": "applyTheme:UX ThemeSwitch:HX",
  "components/Logo.jsx": "Logo:Nw",
  "components/Checks.jsx": "ConsistencyCheck:_Component23 CheckBanner:_Component18",
  "components/CategoryOptions.jsx": "KIND_GROUPS:PX CategoryOptions:_Component24",
  "App.jsx": "PAGES:Gd PHONE_HIDDEN:FX useRoute:zX App:WX",
  "pages/Accounts.jsx": "ROOM_TAGS:jN RoomCandidates:SN FamilyMembers:_N MemberRow:ON AccountsPage:PN AccountsTable:AN BalanceForm:$N findDuplicate:Wh RemoveOrMerge:NN ManualItems:_Component ContributionRoom:EN RoomRow:TN",
  "pages/Debts.jsx": "DebtsPage:JY PaymentStatus:_Component8",
  "pages/Family.jsx": "FamilyPage:tX PersonSummary:Pw SummaryLine:Gl",
  "pages/Statements.jsx": "COVERAGE_CELLS:nX StatementCoverage:_Component1 STATUS:yy StatementsPage:aX StatusBadge:TP DeleteStatementButton:CP AttentionRow:_Component9 StatementActions:_Component10 StatementReview:_Component0 UnlockForm:_Component11 StagedReview:_Component12",
  "pages/Insurance.jsx": "FREQUENCY:MP PAID_VIA:IP blankPolicy:Aw InsurancePage:cX PolicyEditor:_Component13",
  "pages/Investments.jsx": "REGISTRATIONS:$w InvestmentsPage:dX YearToDate:_Component15",
  "pages/NetWorth.jsx": "NETWORTH_GROUPS:pX NetWorthPage:mX",
  "pages/Overview.jsx": "OverviewPage:gX",
  "pages/People.jsx": "Owed:_Component19 PeoplePage:xX PersonForm:DP PersonDetail:_Component20 AssignTransactions:_Component21",
  "pages/Review.jsx": "CUT_KINDS:jX SUB_STATUS:SX ReviewPage:_X FamilyFlows:OX",
  "pages/Settings.jsx": "PhoneSnapshotSettings:AX KINDS:$X SettingsPage:NX Rules:_Component22 Unrecognised:EX UnrecognisedRow:TX AddRule:CX RulesByCategory:MX RuleEditor:IX Categories:DX YourData:LX",
  "pages/Spending.jsx": "SpendingPage:RX Transactions:BX",
  "phone/engine.js": "worker:Cn nextId:KX pending:ha onProgress:LP getWorker:VX call:RP startEngine:BP stopEngine:ns phoneRequest:GX",
  "phone/snapshot.js": "MAGIC:YX isSnapshot:XX DB_NAME:QX STORE:ym openDb:ZX withStore:gy loadSaved:JX saveSnapshot:eQ removeSaved:tQ",
  "phone/PhoneGate.jsx": "LOCK_AFTER_MS:nQ PhoneGate:_Component27",
  "phone/PhoneStatus.jsx": "PhoneStatus:_Component26",
};
const DROP = new Set(["dN", "hN", "kg", "pN", "Y1", "le", "qX"]);
const LIB = Object.assign(Object.create(null), {
  Kt: ["recharts", "ResponsiveContainer"], Mt: ["recharts", "CartesianGrid"], Re: ["recharts", "Tooltip"],
  Ps: ["recharts", "Cell"], _Component6: ["recharts", "Bar"], La: ["recharts", "Line"], _Component16: ["recharts", "Area"],
  _Component3: ["recharts", "XAxis"], _Component4: ["recharts", "YAxis"], YY: ["recharts", "LineChart"],
  _Component7: ["recharts", "BarChart"], _Component17: ["recharts", "AreaChart"], EP: ["recharts", "ComposedChart"],
});
const rename = Object.create(null), moduleOf = Object.create(null);
for (const [file, spec] of Object.entries(MODULES))
  for (const pair of spec.split(" ")) {
    const [name, old] = pair.split(":");
    rename[old] = name;
    moduleOf[name] = file;
  }

// ---------------------------------------------------------------- clean-up passes
// drop the bundler's own helpers and the bundled clsx
ast.program.body = ast.program.body.filter((n) => {
  if (n.type === "ExpressionStatement") return false;
  const names = n.type === "FunctionDeclaration" ? [n.id.name] : n.declarations?.map((d) => d.id.name) ?? [];
  return !names.some((x) => DROP.has(x));
});

const reactUsed = new Set();
traverse(ast, {
  // <s.Fragment> → <>, <N.Fragment key> → <Fragment key>
  JSXElement(p) {
    const o = p.node.openingElement;
    if (o.name.type !== "JSXMemberExpression" || o.name.property.name !== "Fragment") return;
    if (o.attributes.length === 0) {
      p.replaceWith(t.jsxFragment(t.jsxOpeningFragment(), t.jsxClosingFragment(), p.node.children));
    } else {
      o.name = t.jsxIdentifier("Fragment");
      p.node.closingElement.name = t.jsxIdentifier("Fragment");
      reactUsed.add("Fragment");
    }
  },
  // N.useState → useState
  MemberExpression(p) {
    const { object, property, computed } = p.node;
    if (!computed && object.type === "Identifier" && object.name === "N" && !p.scope.getBinding("N")) {
      reactUsed.add(property.name);
      p.replaceWith(t.identifier(property.name));
    }
  },
});

// (tmp = x) == null ? undefined : tmp.a.b()  →  x?.a.b()
function chainRoot(node) {
  const links = [];
  let n = node;
  while (n.type === "MemberExpression" || n.type === "CallExpression") {
    links.unshift(n);
    n = n.type === "MemberExpression" ? n.object : n.callee;
  }
  return { root: n, links };
}
function rebuild(base, links) {
  let out = base;
  links.forEach((l, i) => {
    out = l.type === "MemberExpression"
      ? t.optionalMemberExpression(out, l.property, l.computed, i === 0)
      : t.optionalCallExpression(out, l.arguments, i === 0);
  });
  return out;
}
traverse(ast, {
  ConditionalExpression(p) {
    const { test, consequent, alternate } = p.node;
    if (test.type !== "BinaryExpression" || test.operator !== "==" || test.right.type !== "NullLiteral") return;
    if (!(consequent.type === "Identifier" && consequent.name === "undefined")) return;
    const { root, links } = chainRoot(alternate);
    if (root.type !== "Identifier" || links.length === 0) return;
    if (test.left.type === "Identifier" && test.left.name === root.name) {
      p.replaceWith(rebuild(t.identifier(root.name), links));
    } else if (test.left.type === "AssignmentExpression" && test.left.operator === "=" &&
               test.left.left.type === "Identifier" && test.left.left.name === root.name) {
      const b = p.scope.getBinding(root.name);
      if (!b || b.references !== 1 || b.constantViolations.length !== 1) return;
      p.replaceWith(rebuild(test.left.right, links));
    }
  },
});
// remove `var tmp;` left unused by the pass above
traverse(ast, {
  Program(p) { p.scope.crawl(); },
  VariableDeclarator(p) {
    if (p.node.init || p.node.id.type !== "Identifier") return;
    const b = p.scope.getBinding(p.node.id.name);
    if (b && b.references === 0 && b.constantViolations.length === 0) p.remove();
  },
});

// { title: e } → { title }, when nothing in that scope already uses the name
const RESERVED = new Set(["default", "class", "new", "delete", "in", "for", "if", "do", "var", "let", "const", "function",
  "return", "this", "switch", "case", "typeof", "void", "with", "yield", "enum", "await", "static", "super", "import",
  "export", "extends", "null", "true", "false", "try", "catch", "finally", "throw", "while", "break", "continue",
  "package", "private", "protected", "public", "interface", "implements", "instanceof", "debugger", "arguments", "eval"]);
function nameUsedIn(scopePath, name) {
  let used = false;
  scopePath.traverse({
    "Identifier|JSXIdentifier"(q) {
      if (q.node.name !== name) return;
      const parent = q.parent;
      if ((parent.type === "ObjectProperty" || parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression" ||
           parent.type === "ObjectMethod") && !parent.computed && (parent.key === q.node || parent.property === q.node) &&
          !(parent.type === "ObjectProperty" && parent.shorthand)) return;
      if (parent.type === "JSXAttribute" && parent.name === q.node) return;
      if (parent.type === "JSXMemberExpression" && parent.property === q.node) return;
      used = true;
      q.stop();
    },
  });
  return used;
}
traverse(ast, {
  Program(p) { p.scope.crawl(); },
  ObjectPattern(p) {
    for (const prop of p.node.properties) {
      if (prop.type !== "ObjectProperty" || prop.computed || prop.key.type !== "Identifier") continue;
      const target = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value;
      if (target.type !== "Identifier" || target.name === prop.key.name || target.name.length > 2) continue;
      const want = prop.key.name;
      if (RESERVED.has(want) || rename[want] || moduleOf[want] || LIB[want]) continue;
      const b = p.scope.getBinding(target.name);
      if (!b || nameUsedIn(b.scope.path, want)) continue;
      b.scope.rename(target.name, want);
      if (prop.value.type === "Identifier") prop.shorthand = true;
      else prop.shorthand = true; // `{ className = "" }`
    }
  },
});

// top-level and library names
traverse(ast, {
  Program(p) {
    p.scope.crawl();
    for (const [old, name] of Object.entries(rename)) if (p.scope.hasOwnBinding(old)) p.scope.rename(old, name);
  },
});
const libUsed = {};
traverse(ast, {
  "Identifier|JSXIdentifier"(p) {
    const lib = LIB[p.node.name];
    if (!lib || p.scope.getBinding(p.node.name)) return;
    if (p.parent.type === "JSXAttribute" && p.parent.name === p.node) return;
    (libUsed[lib[0]] ??= new Set()).add(lib[1]);
    p.node.name = lib[1];
  },
});

// ---------------------------------------------------------------- split into modules
const declOf = (n) => n.type === "FunctionDeclaration" ? [n.id.name] : n.type === "VariableDeclaration" ? n.declarations.map((d) => d.id.name) : [];
const files = {};
for (const node of ast.program.body) {
  const names = declOf(node);
  const file = moduleOf[names[0]];
  if (!file) throw new Error(`no module for ${names.join(",")}`);
  (files[file] ??= []).push(node);
}
// who uses what
const uses = {};
traverse(ast, {
  "Identifier|JSXIdentifier"(p) {
    const name = p.node.name;
    if (!moduleOf[name]) return;
    if (p.isIdentifier() && !p.isReferencedIdentifier()) return;
    if (p.isJSXIdentifier() && (p.parent.type === "JSXAttribute" || (p.parent.type === "JSXMemberExpression" && p.parent.property === p.node))) return;
    const b = p.scope.getBinding(name);
    if (b && b.scope.block.type !== "Program") return;
    const stmt = p.findParent((q) => q.parentPath?.isProgram());
    if (!stmt) return;
    const from = moduleOf[declOf(stmt.node)[0]];
    if (from && from !== moduleOf[name]) (uses[from] ??= new Set()).add(name);
  },
});
const exported = new Set(Object.values(uses).flatMap((s) => [...s]));
const libPerFile = {};
for (const [file, nodes] of Object.entries(files)) {
  const r = new Set(), lib = {};
  const prog = t.program(nodes.map((n) => t.cloneNode(n, true)));
  traverse(t.file(prog), {
    noScope: true,
    "Identifier|JSXIdentifier"(p) {
      const n = p.node.name;
      if (reactUsed.has(n) && (p.parent.type !== "MemberExpression" || p.parent.object === p.node)) r.add(n);
      for (const [pkg, set] of Object.entries(libUsed)) if (set.has(n)) (lib[pkg] ??= new Set()).add(n);
    },
  });
  libPerFile[file] = { react: r, lib };
}

const rel = (from, to) => {
  let r = path.relative(path.dirname(from), to).replace(/\.(jsx|js)$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};
for (const [file, nodes] of Object.entries(files)) {
  const header = [];
  const { react, lib } = libPerFile[file];
  if (react.size) header.push(`import { ${[...react].sort().join(", ")} } from "react";`);
  for (const [pkg, set] of Object.entries(lib)) header.push(`import { ${[...set].sort().join(", ")} } from "${pkg}";`);
  const byFile = {};
  for (const name of uses[file] ?? []) (byFile[moduleOf[name]] ??= []).push(name);
  for (const [f, names] of Object.entries(byFile).sort())
    header.push(`import { ${names.sort().join(", ")} } from "${rel(file, f)}";`);
  const body = nodes.map((n) => {
    const code = generate(n, { jsescOption: { minimal: true } }).code;
    return declOf(n).some((x) => exported.has(x) || x.endsWith("Page") || x === "App" || x === "PhoneGate") ? `export ${code}` : code;
  });
  const src = `${header.join("\n")}\n\n${body.join("\n\n")}\n`;
  const out = path.join(outDir, file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await prettier.format(src, { parser: "babel", printWidth: 120 }));
  console.log(`${String(src.split("\n").length).padStart(5)} ${file}`);
}
