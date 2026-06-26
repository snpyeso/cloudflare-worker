export function utf8ToBase64Url(value) {
  return bytesToBase64Url(new TextEncoder().encode(String(value || '')));
}

export function base64UrlToUtf8(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlToBytes(value) {
  const base64 = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  return base64ToBytes(padded);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(String(value || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function pemToArrayBuffer(pem) {
  const base64 = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return base64ToBytes(base64).buffer;
}

export function normalizePrivateKey(value) {
  let key = value;

  if (key && typeof key === 'object') {
    key = key.privateKey || key.private_key || '';
  }

  key = String(key || '').trim();

  if (key.startsWith('{') || key.startsWith('"')) {
    try {
      const parsed = JSON.parse(key);
      key = typeof parsed === 'object' && parsed
        ? parsed.privateKey || parsed.private_key || ''
        : parsed;
    } catch {
      // Keep the original value and continue with best-effort PEM cleanup.
    }
  }

  key = String(key || '').trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }

  key = key
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  return normalizePemLineBreaks(key);
}

function normalizePemLineBreaks(key) {
  const match = key.match(/^(-----BEGIN [^-]+-----)\s*([A-Za-z0-9+/=\s]+?)\s*(-----END [^-]+-----)$/s);
  if (!match) return key;

  const [, header, body, footer] = match;
  const compactBody = body.replace(/\s+/g, '');
  const wrappedBody = compactBody.match(/.{1,64}/g)?.join('\n') || compactBody;
  return `${header}\n${wrappedBody}\n${footer}`;
}
