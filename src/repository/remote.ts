const URL_PROTOCOLS = new Set(["https:", "ssh:"]);

type RemoteParts = {
  hostname: string;
  port: string;
  path: string;
};

export function normalizeRemote(raw: string): string | null {
  const trimmed = raw.trim();

  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null;
  }

  const parts = trimmed.includes("://")
    ? parseUrlRemote(trimmed)
    : parseScpRemote(trimmed);

  if (parts === null) {
    return null;
  }

  const hostname = parts.hostname.toLowerCase();
  const path = normalizePath(parts.path);

  if (hostname.length === 0 || path === null) {
    return null;
  }

  const host = parts.port.length > 0 ? `${hostname}:${parts.port}` : hostname;
  return `${host}/${path}`;
}

function parseUrlRemote(raw: string): RemoteParts | null {
  try {
    const remote = new URL(raw);

    if (!URL_PROTOCOLS.has(remote.protocol) || remote.hostname.length === 0) {
      return null;
    }

    const defaultPort = remote.protocol === "https:" ? "443" : "22";
    const path = decodeUnreserved(remote.pathname);

    if (path === null) {
      return null;
    }

    return {
      hostname: remote.hostname,
      port: remote.port === defaultPort ? "" : remote.port,
      path,
    };
  } catch {
    return null;
  }
}

function parseScpRemote(raw: string): RemoteParts | null {
  if (/^[A-Za-z]:[\\/]/.test(raw)) {
    return null;
  }

  const match = /^(?:[^@/:]+@)?([^@/:]+):(.+)$/.exec(raw);

  if (match === null) {
    return null;
  }

  const hostname = match[1];
  const rawPath = match[2];

  if (hostname === undefined || rawPath === undefined) {
    return null;
  }

  const suffixStart = rawPath.search(/[?#]/);

  return {
    hostname,
    port: "",
    path: suffixStart === -1 ? rawPath : rawPath.slice(0, suffixStart),
  };
}

function normalizePath(raw: string): string | null {
  let path = raw.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  path = path.replace(/\/+$/g, "");

  return path.length > 0 ? path : null;
}

function decodeUnreserved(raw: string): string | null {
  if (/%(?![0-9A-Fa-f]{2})/.test(raw)) {
    return null;
  }

  return raw.replace(/%[0-9A-Fa-f]{2}/g, (encoded) => {
    const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));

    return /[A-Za-z0-9._~-]/.test(character)
      ? character
      : encoded.toUpperCase();
  });
}
