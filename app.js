// Vercel deploys this file as the app (it looks for a default-exported
// Express app in app.js). server/index.js runs it locally.
import express from "express";
import multer from "multer";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./server/check.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(root, "public")));

// Turns an uploaded .txt / .docx / .pdf into plain text for the editor.
app.post("/api/extract", upload.single("file"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded." });
  const ext = path.extname(file.originalname).toLowerCase();
  try {
    let text;
    if (ext === ".txt" || ext === ".md") text = file.buffer.toString("utf8");
    else if (ext === ".docx") text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    else if (ext === ".pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(file.buffer));
      text = (await extractText(pdf)).text.join("\n\n");
    }
    else if (ext === ".doc") return res.status(415).json({ error: "Old .doc files aren't supported. Save it as .docx or PDF and try again." });
    else return res.status(415).json({ error: `Unsupported file type ${ext || "(none)"}. Use .txt, .docx or .pdf.` });
    text = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return res.status(422).json({ error: "No text found in that file (scanned PDFs have no text layer)." });
    res.json({ name: file.originalname, text });
  } catch (err) {
    res.status(422).json({ error: `Couldn't read that file: ${err.message}` });
  }
});

// Streams newline-delimited JSON: progress events, then one result event.
app.post("/api/check", async (req, res) => {
  const { text, options } = req.body || {};
  if (typeof text !== "string") return res.status(400).json({ error: "Missing text." });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");
  let closed = false;
  res.on("close", () => (closed = true));

  try {
    const result = await runCheck(text, options, (p) => !closed && send({ type: "progress", ...p }));
    if (!closed) send({ type: "result", result });
  } catch (err) {
    if (!closed) send({ type: "error", error: err.message });
  }
  res.end();
});

// Multer rejects files over the size limit with an error, not a 413 body.
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File is too big. The limit is 4 MB." });
  next(err);
});

export default app;
