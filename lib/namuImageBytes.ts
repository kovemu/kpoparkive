export const MAX_NAMU_IMAGE_BYTES = 8 * 1024 * 1024;

export async function readNamuImageBytes(response: Response) {
  if (!response.ok) throw new Error(`image fetch ${response.status}`);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("image/")) throw new Error("response is not an image");
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
  return bytes.buffer;
}
