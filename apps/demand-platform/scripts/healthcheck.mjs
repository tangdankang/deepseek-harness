try {
  const host = process.env.HEALTHCHECK_HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8787);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const response = await fetch(`http://${host}:${port}/health/ready`, { signal: controller.signal });
  clearTimeout(timer);
  const payload = await response.json();
  if (!response.ok || payload.readiness !== "ready" || payload.database !== "ok") throw new Error(`not ready: ${response.status}`);
  console.log(JSON.stringify({ status: "healthy", database: payload.database }));
} catch (error) {
  console.error(JSON.stringify({ status: "unhealthy", reason: error.message }));
  process.exitCode = 1;
}
