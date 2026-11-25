import { startServer } from "./src/server.mjs";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "::";

startServer({ host, port }).catch((err) => {
  console.error("[deepai-proxy-novo] falha ao iniciar:", err);
  process.exit(1);
});
