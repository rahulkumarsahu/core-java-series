import fs from "node:fs/promises";
import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const STARTER = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/.tmp_logsift_full_deck/template-starter.pptx";
const FINAL = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/Logsift_Phase_1_Offline_Learning.pptx";
const OUT = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/.tmp_logsift_full_deck/final-renders";
const STARTER_INSPECT = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/.tmp_logsift_full_deck/template-starter.pptx.inspect.ndjson";

let idMap = new Map();

const C = {
  ink: "#16324F",
  muted: "#5F6B78",
  teal: "#158A86",
  tealDark: "#0E6764",
  tealLight: "#DDF1EE",
  orange: "#DF6C4F",
  orangeLight: "#F8E2DA",
  purple: "#7057A6",
  purpleLight: "#ECE5F6",
  white: "#FFFFFF",
};

const SRC1 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/logsift-architecture/01-problem-and-architecture.md";
const SRC2 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/logsift-architecture/02-offline-learning-flow.md";
const SRC3 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/logsift-architecture/03-failure-analysis-flow.md";
const SRC4 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/logsift-architecture/04-layer-3-rag-and-code-context.md";

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function setText(pres, id, value) {
  const target = pres.resolve(mappedId(id));
  target.text = value;
  return target;
}

function setTextColor(pres, id, color) {
  pres.resolve(mappedId(id)).text.color = color;
}

function paint(pres, id, fill, lineFill = fill, lineWidth = 1.5) {
  const target = pres.resolve(mappedId(id));
  target.fill = fill;
  target.line = { style: "solid", fill: lineFill, width: lineWidth };
}

function setNotes(pres, id, presenter, sources) {
  const notes = [
    presenter,
    "",
    "[Sources]",
    ...sources.map((source) => `- ${source}`),
    "[/Sources]",
  ].join("\n");
  pres.resolve(mappedId(id)).setText(notes);
}

function mappedId(id) {
  const resolved = idMap.get(id);
  if (!resolved) throw new Error(`No imported element mapped for ${id}`);
  return resolved;
}

function parseInspect(ndjson) {
  return ndjson.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sameBbox(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildIdMap(referenceRows, importedRows) {
  const nextMap = new Map();
  for (const ref of referenceRows) {
    if (!ref.id || !ref.kind || !ref.slide) continue;
    let candidates = importedRows.filter((row) => row.kind === ref.kind && row.slide === ref.slide);
    if (ref.bbox) candidates = candidates.filter((row) => sameBbox(row.bbox, ref.bbox));
    if (ref.text !== undefined) candidates = candidates.filter((row) => row.text === ref.text);
    if (ref.name) candidates = candidates.filter((row) => row.name === ref.name);
    if (candidates.length === 1) nextMap.set(ref.id, candidates[0].id);
  }
  return nextMap;
}

function editOpening(pres) {
  setText(pres, "sh/rq50vuhg", "LOGSIFT · THREE-PHASE OVERVIEW");
  setText(pres, "sh/gfe1szix", "01");
  setText(pres, "sh/edwjqp07", "3 PHASES");
  setText(pres, "sh/fe50zuhc", "Logsift turns CI/CD logs into a clear root-cause story");
  setText(pres, "sh/wjuhgvit", "A lightweight mental model: learn normal, reduce failure noise, then retrieve trusted context.");

  setText(pres, "sh/xk3ip0ze", "PHASE 1\nLEARN NORMAL");
  setText(pres, "sh/cfmxkrah", "PHASE 2\nFIND EVIDENCE");
  setText(pres, "sh/adkfihsr", "PHASE 3\nADD CONTEXT");
  paint(pres, "sh/xk3ip0ze", C.tealLight, C.teal);
  paint(pres, "sh/cfmxkrah", C.orangeLight, C.orange);
  paint(pres, "sh/adkfihsr", C.purpleLight, C.purple);
  paint(pres, "sh/xgvydwr2", C.orange, C.orange, 0.5);
  paint(pres, "sh/bedgbm9w", C.purple, C.purple, 0.5);

  setText(pres, "sh/kjmxobat", "THE WHOLE IDEA\nEvery phase makes the problem smaller and the final answer more trustworthy.");
  setText(pres, "sh/zidgf698", "For junior engineers · three simple flows · one connected system");
  setNotes(pres, "nt/sgyi62", "Introduce the deck as one connected story. Avoid implementation detail on this slide.", [SRC1, SRC2, SRC3, SRC4]);
}

function editPhase1(pres) {
  setText(pres, "sh/9gv25s7e", "PHASE 1 · LEARN NORMAL");
  setText(pres, "sh/uh43exoz", "02");
  setText(pres, "sh/gj6lg76p", "Phase 1 learns normal behavior");
  setText(pres, "sh/i5o3ihov", "Only trusted, complete success logs can update the baseline.");

  const steps = [
    ["sh/36xkbmpg", "Trusted\nsuccess"],
    ["sh/e9ojqh43", "Detect\nsource"],
    ["sh/0bq1srm9", "Normalize"],
    ["sh/qlojmx4r", "Redact"],
    ["sh/s761o7mx", "Mask"],
    ["sh/ih4jix4v", "Drain"],
    ["sh/9crq54z2", "Store\nartifacts"],
    ["sh/na983uhw", "Publish\nbaseline"],
  ];
  for (const [id, text] of steps) setText(pres, id, text);

  setText(pres, "sh/wf2pgjyd", "SIMPLE DEFINITIONS");
  setText(pres, "sh/xgbq9ofy", "CLEAN");
  setText(pres, "sh/ad07e9gn", "Normalize formatting · redact secrets · mask values that change every run");
  setText(pres, "sh/vet87eh8", "LEARN");
  setText(pres, "sh/cjyp4fy9", "Drain groups repeated message shapes into reusable templates.");
  setText(pres, "sh/5c3qto3a", "KEY FILES\nbaseline.json · templates.json\ndrain3_state.json · template_stats.json");
  setTextColor(pres, "sh/wf2pgjyd", C.teal);
  paint(pres, "sh/xgbq9ofy", C.tealLight, C.teal);
  paint(pres, "sh/vet87eh8", C.tealLight, C.teal);
  setTextColor(pres, "sh/xgbq9ofy", C.tealDark);
  setTextColor(pres, "sh/vet87eh8", C.tealDark);
  setNotes(pres, "nt/99rue8", "Explain each box in one sentence. The central idea is learning patterns from trusted success logs.", [SRC2]);
}

function editSources(pres) {
  setText(pres, "sh/n250jm1k", "PHASE 1 · KEEP SOURCES SEPARATE");
  setText(pres, "sh/w7y1gr2h", "03");
  setText(pres, "sh/a5gje1kb", "Jules and Lattice learn separately");
  setText(pres, "sh/kbi1kb2d", "They use the same Logsift pipeline, but their execution order is different.");

  setText(pres, "sh/fu50f6t8", "• Stages run one after another\n• Nearby lines usually belong together\n• Compare inside the same stage");
  setText(pres, "sh/etwz61cn", "…/payment-api/JULES/v17");
  setText(pres, "sh/qloni9on", "• DAG nodes may run together\n• Physical lines can interleave\n• Compare the same node + attempt");
  setText(pres, "sh/rmxobe58", "…/payment-api/LATTICE/v17");
  setText(pres, "sh/rip4fqxc", "Baseline key: seal_id + project_id + repo_id + source_type");
  setNotes(pres, "nt/dojjqp", "The only teaching goal is why Jules and Lattice cannot share one baseline.", [SRC1, SRC2]);
}

function recolorFlow(pres, ids, color, light) {
  for (const id of ids.arrows) paint(pres, id, color, color, 0.5);
  for (const id of ids.boxes) paint(pres, id, C.white, color);
  paint(pres, ids.first, light, color);
  paint(pres, ids.last, light, color);
  paint(pres, ids.underline, color, color, 0);
  setTextColor(pres, ids.phaseLabel, color);
  setTextColor(pres, ids.definitionHeader, color);
  paint(pres, ids.label1, light, color);
  paint(pres, ids.label2, light, color);
  setTextColor(pres, ids.label1, color);
  setTextColor(pres, ids.label2, color);
}

function editPhase2(pres) {
  setText(pres, "sh/b2x0fmtw", "PHASE 2 · REDUCE FAILURE NOISE");
  setText(pres, "sh/oz6h4ra5", "04");
  setText(pres, "sh/2xoz2hsf", "Phase 2 keeps the evidence that matters");
  setText(pres, "sh/gv6h07a9", "A failed run is compared with the right successful baseline.");

  const steps = [
    ["sh/1wfi9cbu", "Failed\nrun"],
    ["sh/gryx432x", "Same\npreprocess"],
    ["sh/upwf2t47", "Find\nbaseline"],
    ["sh/8nex0jm1", "LogDiff"],
    ["sh/6lwfy94v", "Expand\ncontext"],
    ["sh/sjihcn25", "Build +\ndedup"],
    ["sh/bq1cza18", "Rank +\ntrim"],
    ["sh/xs3e1kje", "Evidence\npack"],
  ];
  for (const [id, text] of steps) setText(pres, id, text);

  setText(pres, "sh/21sv25kr", "SIMPLE DEFINITIONS");
  setText(pres, "sh/n21cva1c", "LOGDIFF");
  setText(pres, "sh/o3ad4f2h", "templates.json is the main LogDiff input; stats add counts and support.");
  setText(pres, "sh/94juxkj2", "EVIDENCE");
  setText(pres, "sh/6xcve90v", "Group nearby lines, remove repeats, rank useful blocks, then fit the token budget.");
  setText(pres, "sh/rq1s365w", "LARGE LOGS\nRead indexed ranges only—never load or send the whole log.");

  recolorFlow(pres, {
    arrows: ["sh/hs7yx83i", "sh/vq5gvyls", "sh/tonyto3m", "sh/7m5grelg", "sh/dkry5s3q", "sh/a5sv6pkn", "sh/wrad8f2t"],
    boxes: ["sh/1wfi9cbu", "sh/gryx432x", "sh/upwf2t47", "sh/8nex0jm1", "sh/6lwfy94v", "sh/sjihcn25", "sh/bq1cza18", "sh/xs3e1kje"],
    first: "sh/1wfi9cbu",
    last: "sh/xs3e1kje",
    underline: "sh/3yx0bmt0",
    phaseLabel: "sh/b2x0fmtw",
    definitionHeader: "sh/21sv25kr",
    label1: "sh/n21cva1c",
    label2: "sh/94juxkj2",
  }, C.orange, C.orangeLight);
  setNotes(pres, "nt/b4qopn", "Keep the explanation simple: compare, expand, remove repetition, and keep the best evidence.", [SRC3]);
}

function editPhase3(pres) {
  setText(pres, "sh/58vap4r6", "PHASE 3 · ADD TRUSTED CONTEXT");
  setText(pres, "sh/uhkra5sj", "05");
  setText(pres, "sh/g329cfa9", "Phase 3 connects evidence to knowledge and code");
  setText(pres, "sh/6d0r65s7", "RAG searches trusted context before the model explains the failure.");

  const steps = [
    ["sh/7et8fa9s", "Evidence\npack"],
    ["sh/a5wfyx43", "Extract\nclues"],
    ["sh/c7ex07mt", "Exact\nsearch"],
    ["sh/y9gf2h4z", "Vector\nsearch"],
    ["sh/kbyx4rm5", "Code\ngraph"],
    ["sh/edcfqd4v", "Filter\naccess"],
    ["sh/5kjutojy", "Rerank"],
    ["sh/ji1crels", "Grounded\nRCA"],
  ];
  for (const [id, text] of steps) setText(pres, id, text);

  setText(pres, "sh/wfqdwj2h", "SIMPLE DEFINITIONS");
  setText(pres, "sh/hgzupo32", "RAG");
  setText(pres, "sh/ud8vu9kb", "Search runbooks, incidents, configuration, and code before asking the model.");
  setText(pres, "sh/vehcnelw", "VECTOR DB");
  setText(pres, "sh/0bud832l", "Finds similar meaning; exact search still handles errors, symbols, and file names.");
  setText(pres, "sh/xwvat0ji", "CODE SAFETY\nReturn permitted code from the same repository and failed commit.");

  recolorFlow(pres, {
    arrows: ["sh/b65gr2l8", "sh/x8nytc3e", "sh/zapgvmlk", "sh/lw7yxw3q", "sh/felwji50", "sh/4jad0j2d", "sh/ih8vy9kn"],
    boxes: ["sh/7et8fa9s", "sh/a5wfyx43", "sh/c7ex07mt", "sh/y9gf2h4z", "sh/kbyx4rm5", "sh/edcfqd4v", "sh/5kjutojy", "sh/ji1crels"],
    first: "sh/7et8fa9s",
    last: "sh/ji1crels",
    underline: "sh/h4balkru",
    phaseLabel: "sh/58vap4r6",
    definitionHeader: "sh/wfqdwj2h",
    label1: "sh/hgzupo32",
    label2: "sh/vehcnelw",
  }, C.purple, C.purpleLight);
  paint(pres, "sh/7et8fa9s", C.orangeLight, C.orange);
  setNotes(pres, "nt/nhkgsg", "Define RAG in plain language. Exact search, vector search, and the code graph are complementary, not competing options.", [SRC4]);
}

function editSummary(pres) {
  setText(pres, "sh/yd0f2pgr", "LOGSIFT · COMPLETE FLOW");
  setText(pres, "sh/dsre9kfm", "06");
  setText(pres, "sh/bqpw7axg", "Three phases produce a grounded explanation");
  setText(pres, "sh/xobyl4fq", "Each phase has one job and passes a smaller, safer output to the next.");

  setText(pres, "sh/wn2xcje5", "CI/CD LOGS\nsuccess + failure");
  setText(pres, "sh/h43qxcry", "PHASE 1\nNORMAL BASELINE");
  setText(pres, "sh/f2l8v298", "PHASE 2\nEVIDENCE PACK");
  setText(pres, "sh/t0jqtcr2", "PHASE 3\nGROUNDED RCA");
  paint(pres, "sh/wn2xcje5", C.white, C.teal);
  paint(pres, "sh/h43qxcry", C.tealLight, C.teal);
  paint(pres, "sh/f2l8v298", C.orangeLight, C.orange);
  paint(pres, "sh/t0jqtcr2", C.purpleLight, C.purple);
  paint(pres, "sh/g3u947qt", C.teal, C.teal, 0.5);
  paint(pres, "sh/u1cr2h8n", C.orange, C.orange, 0.5);
  paint(pres, "sh/szap07qh", C.purple, C.purple, 0.5);

  setText(pres, "sh/6xs7yx8b", "REMEMBER THESE FOUR THINGS");
  setText(pres, "sh/7y18r29w", "Jules ≠ Lattice baseline");
  setText(pres, "sh/kvapwnql", "Secrets removed before storage");
  setText(pres, "sh/5wjqpsrq", "Full logs never go to the model");
  setText(pres, "sh/n6h8zits", "Code matches the failed commit");
  setText(pres, "sh/98za1sby", "WHAT LOGSIFT SAVES\nBaseline · evidence pack · cited knowledge and code");
  setText(pres, "sh/87q98nud", "WHAT THE ENGINEER GETS\nA short, traceable explanation with evidence and clear next checks.");
  setNotes(pres, "nt/ltwaob", "Close by repeating the three outputs: normal baseline, evidence pack, grounded RCA.", [SRC1, SRC2, SRC3, SRC4]);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const pres = await PresentationFile.importPptx(await FileBlob.load(STARTER));
  const before = await pres.inspect({ kind: "slide,textbox,shape,notes,layout", maxChars: 40000 });
  await fs.writeFile(`${OUT}/before-inspect.ndjson`, before.ndjson);
  idMap = buildIdMap(
    parseInspect(await fs.readFile(STARTER_INSPECT, "utf8")),
    parseInspect(before.ndjson),
  );

  editOpening(pres);
  editPhase1(pres);
  editSources(pres);
  editPhase2(pres);
  editPhase3(pres);
  editSummary(pres);

  for (const [index, slide] of pres.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(`${OUT}/${stem}.png`, await pres.export({ slide, format: "png", scale: 1.5 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(`${OUT}/${stem}.layout.json`, await layout.text());
  }
  await writeBlob(`${OUT}/montage.webp`, await pres.export({ format: "webp", montage: true, scale: 1 }));

  const after = await pres.inspect({ kind: "slide,textbox,shape,notes,layout", maxChars: 40000 });
  await fs.writeFile(`${OUT}/after-inspect.ndjson`, after.ndjson);
  const pptx = await PresentationFile.exportPptx(pres);
  await pptx.save(FINAL);
  console.log(`Updated ${FINAL}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
