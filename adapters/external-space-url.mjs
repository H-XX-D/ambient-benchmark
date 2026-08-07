const HF_SPACE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hf\.space$/;

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeExternalSpaceUrl(value, { allowInsecureLoopback = false } = {}) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Memory Space URL must be a valid URL.");
  }

  const loopbackTest = allowInsecureLoopback && url.protocol === "http:" && isLoopback(url.hostname);
  const publicSpace = url.protocol === "https:" && HF_SPACE_HOST.test(url.hostname);
  if (!loopbackTest && !publicSpace) {
    throw new Error("Memory Space URL must use a public https://…hf.space origin.");
  }
  if (url.username || url.password || (!loopbackTest && url.port) || url.search || url.hash) {
    throw new Error("Memory Space URL cannot contain credentials, a port, query parameters, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new Error("Memory Space URL must be the Space origin with no path.");
  }
  return url.origin;
}
