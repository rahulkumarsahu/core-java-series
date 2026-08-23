import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT_DIR = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/.tmp_logsift_phase1/renders";
const FINAL_PPTX = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/Logsift_Phase_1_Offline_Learning.pptx";

const C = {
  paper: "#FBFAF5",
  paper2: "#F4F1E8",
  ink: "#16324F",
  muted: "#5F6B78",
  faint: "#DCD8CC",
  teal: "#158A86",
  tealDark: "#0E6764",
  tealLight: "#DDF1EE",
  orange: "#DF6C4F",
  orangeLight: "#F8E2DA",
  purple: "#7057A6",
  purpleLight: "#ECE5F6",
  yellow: "#F3D66B",
  yellowLight: "#FFF4BE",
  red: "#B84444",
  redLight: "#F6DDDA",
  white: "#FFFFFF",
};

const F = { sans: "Aptos", mono: "Aptos Mono" };

async function writeBlob(path, blob) {
  await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

function addShape(slide, geometry, x, y, w, h, fill = "none", lineFill = "none", lineWidth = 0, name = undefined) {
  return slide.shapes.add({
    geometry,
    name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: lineFill, width: lineWidth },
  });
}

function addText(slide, text, x, y, w, h, opts = {}) {
  const shape = addShape(slide, "textbox", x, y, w, h, opts.fill ?? "none", opts.lineFill ?? "none", opts.lineWidth ?? 0, opts.name);
  shape.text = text;
  shape.text.style = {
    fontSize: opts.fontSize ?? 20,
    bold: opts.bold ?? false,
    color: opts.color ?? C.ink,
    alignment: opts.align ?? "left",
    verticalAlignment: opts.valign ?? "top",
    autoFit: opts.autoFit ?? "shrinkText",
    wrap: "square",
    insets: opts.insets ?? { top: 4, right: 4, bottom: 4, left: 4 },
    typeface: opts.typeface ?? F.sans,
    lineSpacing: opts.lineSpacing ?? 1.0,
  };
  return shape;
}

function addBox(slide, text, x, y, w, h, opts = {}) {
  const shape = addShape(slide, opts.geometry ?? "roundRect", x, y, w, h, opts.fill ?? C.white, opts.lineFill ?? C.faint, opts.lineWidth ?? 1.5, opts.name);
  if (opts.shadow) shape.shadow = "1px 3px 8px #16324F/12";
  shape.text = text;
  shape.text.style = {
    fontSize: opts.fontSize ?? 18,
    bold: opts.bold ?? false,
    color: opts.color ?? C.ink,
    alignment: opts.align ?? "center",
    verticalAlignment: opts.valign ?? "middle",
    autoFit: "shrinkText",
    wrap: "square",
    insets: opts.insets ?? { top: 8, right: 10, bottom: 8, left: 10 },
    typeface: opts.typeface ?? F.sans,
    lineSpacing: opts.lineSpacing ?? 1.0,
  };
  return shape;
}

function addArrow(slide, x, y, w = 36, h = 22, color = C.teal) {
  addShape(slide, "rightArrow", x, y, w, h, color, color, 0.5);
}

function addNotebookGrid(slide) {
  const x0 = 1110;
  const y0 = 22;
  for (let i = 0; i < 7; i += 1) addShape(slide, "line", x0 + i * 22, y0, 1, 58, "none", C.faint, 0.6);
  for (let j = 0; j < 4; j += 1) addShape(slide, "line", x0, y0 + j * 19, 132, 1, "none", C.faint, 0.6);
}

function baseSlide(pres, number, section = "PHASE 1 · OFFLINE LEARNING") {
  const slide = pres.slides.add();
  slide.background.fill = C.paper;
  addShape(slide, "rect", 42, 0, 3, 720, C.orange, C.orange, 0);
  addNotebookGrid(slide);
  addText(slide, section, 78, 24, 420, 24, { fontSize: 13, bold: true, color: C.tealDark, typeface: F.mono });
  addText(slide, String(number).padStart(2, "0"), 1172, 650, 52, 28, { fontSize: 14, bold: true, color: C.muted, align: "right", typeface: F.mono });
  addShape(slide, "line", 78, 674, 1060, 1, "none", C.faint, 1);
  return slide;
}

function addTitle(slide, title, subtitle = undefined) {
  addText(slide, title, 78, 66, 1060, 58, { fontSize: 39, bold: true, color: C.ink, name: "slide-title" });
  addShape(slide, "line", 78, 132, 138, 1, "none", C.teal, 3);
  if (subtitle) addText(slide, subtitle, 236, 116, 890, 38, { fontSize: 18, color: C.muted, valign: "middle" });
}

function addPill(slide, text, x, y, w, fill, color = C.ink) {
  addBox(slide, text, x, y, w, 32, { fill, lineFill: fill, fontSize: 14, bold: true, color });
}

function addSticky(slide, title, body, x, y, w, h) {
  addShape(slide, "rect", x + 5, y + 6, w, h, "#B8AA6C", "#B8AA6C", 0);
  addBox(slide, `${title}\n${body}`, x, y, w, h, {
    geometry: "rect",
    fill: C.yellowLight,
    lineFill: C.yellow,
    lineWidth: 1,
    fontSize: 18,
    bold: false,
    align: "left",
    valign: "top",
    insets: { top: 13, right: 14, bottom: 12, left: 14 },
  });
}

function addSourceNotes(slide, sources, presenter = []) {
  const notes = [
    ...presenter,
    "",
    "[Sources]",
    ...sources.map((s) => `- ${s}`),
    "[/Sources]",
  ];
  slide.speakerNotes.textFrame.setText(notes);
  slide.speakerNotes.setVisible(true);
}

const SRC1 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/logsift-architecture/01-problem-and-architecture.md";
const SRC2 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/final/logsift-architecture/02-offline-learning-flow.md";
const SRC3 = "/Users/rahulkumar/Documents/Project/logsift/engineeringDocs/implementation/Offline_Baseline_Storage_and_Template_Management.md";

function slide1(pres) {
  const s = baseSlide(pres, 1, "LOGSIFT · TECHNICAL SYSTEMS NOTEBOOK");
  addPill(s, "PHASE 1", 80, 76, 116, C.tealLight, C.tealDark);
  addText(s, "Logsift turns CI/CD noise into evidence", 80, 132, 710, 156, { fontSize: 58, bold: true, color: C.ink, lineSpacing: 0.92, name: "deck-title" });
  addText(s, "Learn normal behavior from trusted successful runs—before a failure needs explaining.", 82, 306, 680, 76, { fontSize: 25, color: C.muted, lineSpacing: 1.08 });

  addBox(s, "SUCCESSFUL\nCI/CD LOGS", 850, 132, 240, 86, { fill: C.tealLight, lineFill: C.teal, fontSize: 19, bold: true, shadow: true });
  addArrow(s, 950, 232, 38, 28, C.teal);
  addBox(s, "VERSIONED\nSUCCESS BASELINE", 850, 274, 240, 86, { fill: C.white, lineFill: C.teal, fontSize: 19, bold: true, shadow: true });
  addArrow(s, 950, 374, 38, 28, C.purple);
  addBox(s, "FAILURE-READY\nCOMPARISON TARGET", 850, 416, 240, 86, { fill: C.purpleLight, lineFill: C.purple, fontSize: 19, bold: true, shadow: true });

  addSticky(s, "THE CORE IDEA", "Teach the system what “normal” looks like, then measure what changed.", 82, 470, 612, 112);
  addText(s, "Technical architecture · reusable template · one idea per slide", 82, 617, 720, 28, { fontSize: 15, color: C.muted, typeface: F.mono });
  addSourceNotes(s, [SRC1, SRC2], ["Open with the audience problem: engineers should not have to read an entire noisy build log to find a small failure signal."]);
}

function slide2(pres) {
  const s = baseSlide(pres, 2);
  addTitle(s, "A trusted success becomes a reusable baseline", "The offline flow is deterministic, versioned, and source-aware.");

  const labels = ["Qualified\nsuccess", "Detect\nsource", "Canonical\nevents", "Normalize", "Redact", "Mask", "Drain", "Publish\nbaseline"];
  const widths = [124, 118, 126, 112, 102, 92, 92, 132];
  let x = 79;
  labels.forEach((label, i) => {
    addBox(s, label, x, 230, widths[i], 82, {
      fill: i === 0 || i === 7 ? C.tealLight : C.white,
      lineFill: C.teal,
      fontSize: 17,
      bold: i === 0 || i === 7,
      shadow: i === 7,
    });
    x += widths[i];
    if (i < labels.length - 1) {
      addArrow(s, x + 4, 260, 28, 22, C.teal);
      x += 38;
    }
  });

  addText(s, "ADMISSION RULES", 82, 386, 220, 28, { fontSize: 15, bold: true, color: C.orange, typeface: F.mono });
  addBox(s, "LEARN", 82, 426, 110, 44, { fill: C.tealLight, lineFill: C.teal, fontSize: 16, bold: true, color: C.tealDark });
  addText(s, "Successful + complete + known source + trusted main/master or release/*", 210, 425, 830, 48, { fontSize: 20, color: C.ink, valign: "middle" });
  addBox(s, "STOP", 82, 492, 110, 44, { fill: C.orangeLight, lineFill: C.orange, fontSize: 16, bold: true, color: C.red });
  addText(s, "Failed, cancelled, skipped, unstable, incomplete, or UNKNOWN source", 210, 491, 830, 48, { fontSize: 20, color: C.ink, valign: "middle" });

  addSticky(s, "NON-NEGOTIABLE", "A failed run never updates successful parser state or the shared baseline.", 856, 548, 290, 96);
  addSourceNotes(s, [SRC2], ["Walk left to right. Emphasize that every later comparison depends on the same preprocessing versions used here."]);
}

function slide3(pres) {
  const s = baseSlide(pres, 3);
  addTitle(s, "Jules and Lattice cannot share a baseline", "They use one canonical event shape, but different ordering semantics.");

  addText(s, "JULES", 85, 176, 270, 40, { fontSize: 24, bold: true, color: C.tealDark, typeface: F.mono });
  addPill(s, "SEQUENTIAL", 338, 178, 130, C.tealLight, C.tealDark);
  const jx = [92, 256, 420];
  ["BUILD", "TEST", "PACKAGE"].forEach((label, i) => addBox(s, label, jx[i], 254, 132, 66, { fill: C.tealLight, lineFill: C.teal, fontSize: 18, bold: true }));
  addArrow(s, 226, 275, 26, 22, C.teal);
  addArrow(s, 390, 275, 26, 22, C.teal);
  addText(s, "• Stage order is meaningful\n• Nearby lines usually share a stage\n• Compare within the same stage", 92, 356, 450, 112, { fontSize: 20, color: C.ink, lineSpacing: 1.08 });
  addBox(s, "…/payment-api/JULES/v17", 92, 510, 450, 54, { fill: C.white, lineFill: C.teal, fontSize: 18, typeface: F.mono });

  addShape(s, "line", 630, 178, 1, 392, "none", C.faint, 2);

  addText(s, "LATTICE", 684, 176, 300, 40, { fontSize: 24, bold: true, color: C.purple, typeface: F.mono });
  addPill(s, "PARALLEL DAG", 984, 178, 144, C.purpleLight, C.purple);
  addBox(s, "A", 740, 246, 58, 50, { fill: C.purpleLight, lineFill: C.purple, fontSize: 20, bold: true });
  addArrow(s, 815, 260, 34, 20, C.purple);
  addBox(s, "B", 866, 224, 58, 50, { fill: C.white, lineFill: C.purple, fontSize: 20, bold: true });
  addBox(s, "C", 866, 288, 58, 50, { fill: C.white, lineFill: C.purple, fontSize: 20, bold: true });
  addArrow(s, 944, 239, 34, 20, C.purple);
  addArrow(s, 944, 303, 34, 20, C.purple);
  addBox(s, "D", 998, 255, 58, 50, { fill: C.purpleLight, lineFill: C.purple, fontSize: 20, bold: true });
  addText(s, "• Physical lines may interleave\n• Preserve node, attempt, local order\n• Compare inside the same DAG scope", 684, 356, 476, 112, { fontSize: 20, color: C.ink, lineSpacing: 1.08 });
  addBox(s, "…/payment-api/LATTICE/v17", 684, 510, 476, 54, { fill: C.white, lineFill: C.purple, fontSize: 18, typeface: F.mono });

  addText(s, "Same repository. Two independent notions of “normal.”", 292, 608, 690, 34, { fontSize: 22, bold: true, color: C.orange, align: "center" });
  addSourceNotes(s, [SRC1, SRC2, SRC3], ["Use the left/right contrast to explain why line proximity is useful for Jules but potentially misleading for Lattice."]);
}

function slide4(pres) {
  const s = baseSlide(pres, 4);
  addTitle(s, "Normalization removes display noise—not meaning", "Provenance is captured before cleanup changes the text.");

  addText(s, "RAW LINE", 86, 174, 220, 28, { fontSize: 15, bold: true, color: C.orange, typeface: F.mono });
  addBox(s, "2026-08-24T09:31:04Z  [31mERROR[0m\nworker 10.4.8.2 completed build 7312\nprogress 41%\\rprogress 42%", 86, 214, 410, 160, {
    fill: C.orangeLight,
    lineFill: C.orange,
    fontSize: 17,
    align: "left",
    valign: "top",
    typeface: F.mono,
    insets: { top: 16, right: 16, bottom: 12, left: 16 },
  });

  addArrow(s, 524, 272, 58, 32, C.teal);
  addBox(s, "NORMALIZE", 592, 238, 164, 98, { fill: C.tealLight, lineFill: C.teal, fontSize: 20, bold: true, shadow: true });
  addArrow(s, 766, 272, 58, 32, C.teal);

  addText(s, "CLEAN EVENT", 846, 174, 220, 28, { fontSize: 15, bold: true, color: C.tealDark, typeface: F.mono });
  addBox(s, "message: ERROR worker 10.4.8.2\ncompleted build 7312\n\nmetadata:\nobserved_at · physical_line · byte_range", 846, 214, 342, 160, {
    fill: C.tealLight,
    lineFill: C.teal,
    fontSize: 17,
    align: "left",
    valign: "top",
    typeface: F.mono,
    insets: { top: 16, right: 14, bottom: 12, left: 14 },
  });

  addText(s, "WHAT CHANGES", 86, 418, 220, 28, { fontSize: 15, bold: true, color: C.tealDark, typeface: F.mono });
  addBox(s, "UTF-8 + line endings", 86, 458, 286, 58, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });
  addBox(s, "ANSI + control characters", 397, 458, 318, 58, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });
  addBox(s, "Bounded progress rewrites", 740, 458, 318, 58, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });
  addSticky(s, "KEEP THE TRUTH", "Exit codes, exception types, failed tests, source files, and exact line provenance remain diagnostic evidence.", 86, 552, 972, 88);
  addSourceNotes(s, [SRC2], ["Normalization is formatting cleanup. It must not be confused with redaction or masking."]);
}

function slide5(pres) {
  const s = baseSlide(pres, 5);
  addTitle(s, "Redaction is the security gate before derived data is stored", "Secrets are removed permanently; audit metadata never records the secret value.");

  addBox(s, "RESTRICTED RAW LOG", 88, 206, 230, 74, { fill: C.orangeLight, lineFill: C.orange, fontSize: 18, bold: true });
  addArrow(s, 342, 232, 52, 26, C.orange);
  addBox(s, "REDACTION RULES", 410, 190, 230, 106, { fill: C.redLight, lineFill: C.red, fontSize: 19, bold: true, shadow: true });
  addArrow(s, 664, 232, 52, 26, C.teal);
  addBox(s, "PROTECTED DERIVED TEXT", 734, 206, 278, 74, { fill: C.tealLight, lineFill: C.teal, fontSize: 18, bold: true });
  addBox(s, "AUDIT: rule ID · category · position · count", 734, 304, 408, 52, { fill: C.white, lineFill: C.faint, fontSize: 16, typeface: F.mono });

  addText(s, "REMOVE OR SANITIZE", 88, 384, 300, 28, { fontSize: 15, bold: true, color: C.red, typeface: F.mono });
  addBox(s, "Token / password / private key", 88, 428, 318, 62, { fill: C.redLight, lineFill: C.red, fontSize: 18, bold: true });
  addBox(s, "Credentials inside URL", 430, 428, 278, 62, { fill: C.redLight, lineFill: C.red, fontSize: 18, bold: true });
  addBox(s, "Sensitive username", 732, 428, 250, 62, { fill: C.redLight, lineFill: C.red, fontSize: 18, bold: true });
  addBox(s, "<REDACTED_SECRET>", 1000, 428, 182, 62, { fill: C.white, lineFill: C.red, fontSize: 13, bold: true, color: C.red, typeface: F.mono });

  addSticky(s, "FAIL CLOSED", "If a redaction rule fails or the scan is uncertain, quarantine the run. Never publish the baseline.", 88, 548, 688, 90);
  addBox(s, "Restricted raw storage\nuses its own retention policy", 830, 552, 310, 82, { fill: C.white, lineFill: C.faint, fontSize: 18, color: C.muted });
  addSourceNotes(s, [SRC1, SRC2], ["Redaction is irreversible in derived artifacts. The restricted source log remains separately governed."]);
}

function slide6(pres) {
  const s = baseSlide(pres, 6);
  addTitle(s, "Mask variability; preserve diagnostic meaning", "Masking creates stable patterns without erasing the reason a run failed.");

  addText(s, "BEFORE", 86, 172, 160, 26, { fontSize: 15, bold: true, color: C.orange, typeface: F.mono });
  addBox(s, "worker 10.4.8.2 completed build 7312 in 12.8s", 86, 208, 500, 70, { fill: C.orangeLight, lineFill: C.orange, fontSize: 18, typeface: F.mono });
  addArrow(s, 610, 232, 56, 28, C.teal);
  addText(s, "AFTER", 692, 172, 160, 26, { fontSize: 15, bold: true, color: C.tealDark, typeface: F.mono });
  addBox(s, "worker <IP_ADDRESS> completed build <BUILD_ID> in <DURATION>", 692, 208, 496, 70, { fill: C.tealLight, lineFill: C.teal, fontSize: 18, typeface: F.mono });

  addPill(s, "MASK", 86, 344, 104, C.tealLight, C.tealDark);
  addBox(s, "Request IDs\nBuild IDs\nDurations\nEphemeral IPs + ports\nTemporary paths", 86, 386, 430, 176, {
    fill: C.tealLight, lineFill: C.teal, fontSize: 21, bold: false, align: "left", valign: "top", insets: { top: 18, right: 18, bottom: 14, left: 22 }, lineSpacing: 1.08,
  });
  addPill(s, "PRESERVE", 652, 344, 132, C.orangeLight, C.orange);
  addBox(s, "Exit code 137\nException class\nFailed test name\nCompiler diagnostic\nSource file + line", 652, 386, 430, 176, {
    fill: C.orangeLight, lineFill: C.orange, fontSize: 21, bold: false, align: "left", valign: "top", insets: { top: 18, right: 18, bottom: 14, left: 22 }, lineSpacing: 1.08,
  });
  addText(s, "Dynamic values can still be retained as protected numeric features for anomaly checks.", 190, 598, 900, 32, { fontSize: 19, color: C.muted, align: "center" });
  addSourceNotes(s, [SRC2], ["Use the phrase: redact secrets, mask variability, preserve meaning."]);
}

function slide7(pres) {
  const s = baseSlide(pres, 7);
  addTitle(s, "Drain routes each line to a small template set", "Fixed-depth tree routing keeps comparisons bounded as template libraries grow.");

  addBox(s, "Compiling <COUNT> files\nCompiling <COUNT> files\nCompiling <COUNT> files", 82, 212, 260, 134, { fill: C.tealLight, lineFill: C.teal, fontSize: 18, typeface: F.mono, align: "left", valign: "top", insets: { top: 18, right: 14, bottom: 12, left: 16 } });
  addArrow(s, 360, 263, 38, 24, C.teal);
  addBox(s, "TOKEN\nCOUNT", 412, 238, 126, 78, { fill: C.white, lineFill: C.teal, fontSize: 18, bold: true });
  addArrow(s, 552, 263, 38, 24, C.teal);
  addBox(s, "PREFIX\nTREE", 604, 238, 126, 78, { fill: C.white, lineFill: C.teal, fontSize: 18, bold: true });
  addArrow(s, 744, 263, 38, 24, C.teal);
  addBox(s, "LEAF\nCANDIDATES", 796, 238, 148, 78, { fill: C.white, lineFill: C.teal, fontSize: 18, bold: true });
  addArrow(s, 958, 263, 38, 24, C.teal);
  addBox(s, "Compiling\n<COUNT> files", 1010, 226, 184, 102, { fill: C.tealLight, lineFill: C.teal, fontSize: 19, bold: true, typeface: F.mono, shadow: true });

  addText(s, "TUNING RISK", 82, 404, 200, 28, { fontSize: 15, bold: true, color: C.orange, typeface: F.mono });
  addBox(s, "Threshold too strict\n→ one family becomes many templates", 82, 444, 402, 90, { fill: C.orangeLight, lineFill: C.orange, fontSize: 18, align: "left", insets: { top: 15, right: 16, bottom: 12, left: 16 } });
  addBox(s, "Threshold too loose\n→ unrelated meanings collapse together", 506, 444, 402, 90, { fill: C.orangeLight, lineFill: C.orange, fontSize: 18, align: "left", insets: { top: 15, right: 16, bottom: 12, left: 16 } });

  addSticky(s, "STABLE IDENTITY", "Compare scope + canonical template text + fingerprint—not parser-local template numbers.", 932, 420, 266, 136);
  addText(s, "Jules: parse inside a stage  ·  Lattice: parse inside DAG node + attempt", 192, 600, 820, 30, { fontSize: 19, bold: true, color: C.purple, align: "center" });
  addSourceNotes(s, [SRC2, SRC3], ["Drain does not understand Jules or Lattice. The source adapter establishes scope before Drain sees the line."]);
}

function slide8(pres) {
  const s = baseSlide(pres, 8);
  addTitle(s, "The baseline is a versioned, auditable artifact bundle", "Each file has one job; only complete versions become visible.");

  addBox(s, "baselines/\n└── seal101/payments/payment-api/JULES/\n    ├── current.json\n    └── v17/\n        ├── baseline.json\n        ├── templates.json\n        ├── drain3_state.json\n        ├── template_stats.json\n        ├── versions.json\n        ├── templates.md\n        └── normalize_sample.txt", 82, 178, 486, 416, {
    fill: C.paper2,
    lineFill: C.faint,
    fontSize: 18,
    align: "left",
    valign: "top",
    typeface: F.mono,
    insets: { top: 18, right: 16, bottom: 14, left: 18 },
    shadow: true,
  });

  const files = [
    ["templates.json", "Main LogDiff input: text, fingerprint, scope, support", C.tealLight, C.teal],
    ["drain3_state.json", "Parser memory only—not the comparison database", C.purpleLight, C.purple],
    ["baseline.json", "Manifest: owner, version, source runs, artifact links", C.white, C.faint],
    ["template_stats.json", "Counts, distributions, scope and sequence statistics", C.white, C.faint],
    ["versions.json", "Detection, rules, parser and fingerprint compatibility", C.white, C.faint],
    ["current.json", "Pointer to latest complete compatible baseline", C.orangeLight, C.orange],
  ];
  let y = 178;
  files.forEach(([name, desc, fill, line]) => {
    addBox(s, name, 614, y, 210, 54, { fill, lineFill: line, fontSize: 16, bold: true, typeface: F.mono });
    addText(s, desc, 844, y + 2, 338, 50, { fontSize: 17, color: C.ink, valign: "middle" });
    y += 66;
  });

  addText(s, "WRITE FILES  →  VALIDATE CHECKSUMS + REDACTION  →  PUBLISH MANIFEST  →  CAS current.json", 112, 604, 1050, 30, { fontSize: 16, bold: true, color: C.tealDark, align: "center", typeface: F.mono });
  addSourceNotes(s, [SRC2, SRC3], ["Call out templates.json as the runtime comparison input and drain3_state.json as parser memory."]);
}

function slide9(pres) {
  const s = baseSlide(pres, 9);
  addTitle(s, "Four values isolate every baseline", "Stage, attempt, branch, and versions remain inside the baseline—not in its ownership key.");

  addText(s, "BASELINE OWNERSHIP KEY", 82, 176, 340, 28, { fontSize: 15, bold: true, color: C.tealDark, typeface: F.mono });
  const keys = [
    ["seal_id", 82, 184, C.tealLight, C.teal],
    ["project_id", 292, 210, C.white, C.faint],
    ["repo_id", 534, 184, C.white, C.faint],
    ["source_type", 716, 238, C.purpleLight, C.purple],
  ];
  let cursor = 82;
  keys.forEach(([label, , width, fill, line], i) => {
    addBox(s, label, cursor, 226, width, 72, { fill, lineFill: line, fontSize: 21, bold: true, typeface: F.mono, shadow: i === 3 });
    cursor += width;
    if (i < keys.length - 1) {
      addText(s, "+", cursor + 2, 238, 42, 48, { fontSize: 30, bold: true, color: C.orange, align: "center", valign: "middle", typeface: F.mono });
      cursor += 48;
    }
  });

  addBox(s, "seal101/payments/payment-api/JULES/v17", 82, 350, 526, 64, { fill: C.tealLight, lineFill: C.teal, fontSize: 18, typeface: F.mono });
  addBox(s, "seal101/payments/payment-api/LATTICE/v17", 654, 350, 526, 64, { fill: C.purpleLight, lineFill: C.purple, fontSize: 18, typeface: F.mono });
  addText(s, "Different source_type → different baseline", 406, 428, 470, 30, { fontSize: 19, bold: true, color: C.orange, align: "center" });

  addText(s, "STORED INSIDE THE BASELINE", 82, 492, 340, 28, { fontSize: 15, bold: true, color: C.muted, typeface: F.mono });
  addPill(s, "stage / DAG node", 82, 536, 190, C.paper2);
  addPill(s, "attempt", 286, 536, 112, C.paper2);
  addPill(s, "branch + commit", 412, 536, 178, C.paper2);
  addPill(s, "baseline version", 604, 536, 176, C.paper2);
  addPill(s, "rule + parser versions", 794, 536, 232, C.paper2);
  addText(s, "current.json resolves the latest compatible complete version below the key.", 206, 610, 860, 28, { fontSize: 18, color: C.muted, align: "center" });
  addSourceNotes(s, [SRC1, SRC2, SRC3], ["Repeat the four-part key exactly. Baseline version is a child version, not a fifth ownership field."]);
}

function slide10(pres) {
  const s = baseSlide(pres, 10);
  addTitle(s, "Phase 1 hands Phase 2 a safe comparison target", "A failed run can now ask what changed—without relearning what normal means.");

  addBox(s, "TRUSTED SUCCESS\nlog + metadata", 86, 214, 226, 82, { fill: C.tealLight, lineFill: C.teal, fontSize: 19, bold: true });
  addArrow(s, 336, 242, 46, 26, C.teal);
  addBox(s, "SAME VERSIONED\nPREPROCESSING", 398, 202, 240, 106, { fill: C.white, lineFill: C.teal, fontSize: 19, bold: true });
  addArrow(s, 660, 242, 46, 26, C.teal);
  addBox(s, "COMPLETE SUCCESS\nBASELINE", 722, 214, 226, 82, { fill: C.tealLight, lineFill: C.teal, fontSize: 19, bold: true, shadow: true });
  addArrow(s, 972, 242, 46, 26, C.purple);
  addBox(s, "PHASE 2\nLogDiff", 1034, 214, 160, 82, { fill: C.purpleLight, lineFill: C.purple, fontSize: 19, bold: true });

  addText(s, "WHAT PHASE 2 RECEIVES", 86, 366, 320, 28, { fontSize: 15, bold: true, color: C.purple, typeface: F.mono });
  addBox(s, "Stable template fingerprints", 86, 412, 258, 56, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });
  addBox(s, "Scope + order semantics", 364, 412, 250, 56, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });
  addBox(s, "Counts + support ranges", 634, 412, 250, 56, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });
  addBox(s, "Compatibility versions", 904, 412, 250, 56, { fill: C.white, lineFill: C.faint, fontSize: 18, bold: true });

  addSticky(s, "FOUR GUARDRAILS", "1. Never mix Jules and Lattice\n2. Redact before derived storage\n3. Failures never update success state\n4. Publish only complete versions", 86, 526, 548, 116);
  addBox(s, "Next: compare the failed run with the latest compatible baseline—then expand only the evidence that matters.", 680, 526, 474, 116, { fill: C.purpleLight, lineFill: C.purple, fontSize: 22, bold: true, align: "left", insets: { top: 18, right: 20, bottom: 16, left: 20 } });
  addSourceNotes(s, [SRC1, SRC2], ["Close by making the Phase 2 contract explicit. The audience should now understand exactly what the offline flow produces."]);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const pres = Presentation.create({ slideSize: { width: 1280, height: 720 } });
  slide1(pres);
  slide2(pres);
  slide3(pres);
  slide4(pres);
  slide5(pres);
  slide6(pres);
  slide7(pres);
  slide8(pres);
  slide9(pres);
  slide10(pres);

  for (const [index, slide] of pres.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(`${OUT_DIR}/${stem}.png`, await pres.export({ slide, format: "png", scale: 1.5 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(`${OUT_DIR}/${stem}.layout.json`, await layout.text());
  }
  await writeBlob(`${OUT_DIR}/montage.webp`, await pres.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(pres);
  await pptx.save(FINAL_PPTX);
  console.log(`Created ${FINAL_PPTX}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
