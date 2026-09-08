export const MAX_NAMU_IMAGE_BYTES = 8 * 1024 * 1024;

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function isKnownNonPayloadUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isMirror = host === "namu.moe" || host.endsWith(".namu.moe");
    return isMirror && /^\/(?:images|xref)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function u16be(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32be(bytes: Uint8Array, offset: number) {
  return (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function jpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 1 >= bytes.length) break;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (sof.has(marker) && length >= 7) {
      const height = u16be(bytes, offset + 3);
      const width = u16be(bytes, offset + 5);
      return width && height ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

export function inspectNamuImageDimensions(bytesLike: ArrayBuffer | Uint8Array, contentType = "") {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  if ((contentType === "image/png" || (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG")) && bytes.length >= 24) {
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width && height ? { width, height } : null;
  }
  if ((contentType === "image/gif" || (bytes.length >= 10 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a"))) && bytes.length >= 10) {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    return width && height ? { width, height } : null;
  }
  if (contentType === "image/jpeg" || (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return jpegDimensions(bytes);
  return null;
}

/** CDN/mirror responses are occasionally application/octet-stream or text/plain. */
export function detectNamuImageContentType(bytesLike: ArrayBuffer | Uint8Array, declared = "", url = "") {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png";
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp" && /^(?:avif|avis)$/i.test(ascii(bytes, 8, 4))) return "image/avif";

  const sample = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, Math.min(bytes.length, 4096)))
    .replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[\s\S]{0,1000}?>\s*)?(?:<!--(?:[\s\S]*?)-->\s*)*<svg\b/i.test(sample)) return "image/svg+xml";

  const header = declared.split(";", 1)[0].trim().toLowerCase();
  if (/^image\/(?:jpeg|png|gif|webp|avif|svg\+xml)$/.test(header)) return header;
  const ext = url.match(/\.(jpe?g|png|gif|webp|avif|svg)(?:$|[?#])/i)?.[1]?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  if (ext === "svg") return "image/svg+xml";
  return null;
}

export async function readNamuImageBytes(response: Response, requestedUrl = response.url) {
  const effectiveUrl = response.url || requestedUrl;
  if (isKnownNonPayloadUrl(requestedUrl) || isKnownNonPayloadUrl(effectiveUrl)) throw new Error("mirror navigation/placeholder URL is not an image payload");
  if (!response.ok) throw new Error(`image fetch ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_NAMU_IMAGE_BYTES) throw new Error("image exceeds 8 MB");
  if (!response.body) throw new Error("empty image");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_NAMU_IMAGE_BYTES) throw new Error("image exceeds 8 MB");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel(); throw error; }
  if (!size) throw new Error("empty image");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }

  const type = detectNamuImageContentType(bytes, response.headers.get("content-type") || "", effectiveUrl);
  if (!type) throw new Error(`response is not a supported image (${response.headers.get("content-type") || "unknown MIME"})`);

  const dimensions = inspectNamuImageDimensions(bytes, type);
  if (dimensions && (dimensions.width <= 2 || dimensions.height <= 2)) {
    throw new Error(`rejected placeholder-sized image ${dimensions.width}x${dimensions.height}`);
  }
  return bytes.buffer;
}
