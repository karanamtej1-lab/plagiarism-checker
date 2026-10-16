// Local entry point. On Vercel, app.js at the project root is the entry.
import app from "./app.js";

const port = Number(process.env.PORT) || 3300;
app.listen(port, () => console.log(`Plagiarism checker on http://localhost:${port}`));
