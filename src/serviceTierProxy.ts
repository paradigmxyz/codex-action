import http from "node:http";
import { writeFile } from "node:fs/promises";

const SERVICE_TIER_MAP: Record<string, string> = {
  fast: "priority",
  flex: "flex",
};

export async function startServiceTierProxy(
  upstreamPort: number,
  serviceTier: string,
  serverInfoFile: string
): Promise<void> {
  const apiServiceTier = SERVICE_TIER_MAP[serviceTier];
  if (!apiServiceTier) {
    throw new Error(
      `Invalid service tier: ${serviceTier}. Must be one of: ${Object.keys(SERVICE_TIER_MAP).join(", ")}`
    );
  }

  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body = Buffer.concat(chunks);

      let injected = false;
      if (req.method === "POST") {
        try {
          const json = JSON.parse(body.toString("utf8"));
          json.service_tier = apiServiceTier;
          body = Buffer.from(JSON.stringify(json));
          injected = true;
        } catch {
          // Not valid JSON — forward as-is.
        }
      }

      console.log(
        `[service-tier-proxy] ${req.method} ${req.url} → upstream:${upstreamPort}` +
          (injected ? ` (injected service_tier=${apiServiceTier})` : "")
      );

      const headers = { ...req.headers };
      headers["content-length"] = body.length.toString();
      headers["host"] = `127.0.0.1:${upstreamPort}`;

      const upstreamReq = http.request(
        {
          hostname: "127.0.0.1",
          port: upstreamPort,
          path: req.url,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );

      upstreamReq.on("error", (err) => {
        console.error(`Service tier proxy upstream error: ${err.message}`);
        res.writeHead(502);
        res.end("Bad Gateway");
      });

      upstreamReq.write(body);
      upstreamReq.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        console.log(
          `Service tier proxy listening on 127.0.0.1:${port} (${serviceTier} → ${apiServiceTier}), upstream port ${upstreamPort}`
        );
        await writeFile(
          serverInfoFile,
          JSON.stringify({ port }),
          "utf8"
        );
        resolve();
      } else {
        reject(new Error("Failed to get service tier proxy address"));
      }
    });
  });

  // Keep the process alive — the server will handle requests until killed.
}
