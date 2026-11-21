import sharp from "sharp";
import { HttpError, readBoundedBody } from "./http";
import { MAX_IMAGE_BYTES, imageFileError } from "./image-limits";
const MAX_REQUEST_BYTES = MAX_IMAGE_BYTES + 8192;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function matchesImageSignature(bytes: Buffer, mimeType: string): boolean {
  switch (mimeType) {
    case "image/png":
      return bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/webp":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
    default:
      return false;
  }
}

export async function readImageUpload(request: Request): Promise<File> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "Upload one screenshot using multipart/form-data.");
  const bytes = await readBoundedBody(request, MAX_REQUEST_BYTES);
  let form: FormData;
  try { form = await new Response(Buffer.from(bytes), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); }
  catch { throw new HttpError(400, "Invalid screenshot upload."); }
  const images = form.getAll("image");
  if (images.length !== 1 || !(images[0] instanceof File) || [...form.keys()].some(key => key !== "image")) throw new HttpError(400, "Upload exactly one screenshot.");
  const error = imageFileError(images[0]);
  if (error) throw new HttpError(images[0].size > MAX_IMAGE_BYTES ? 413 : 415, error);
  return images[0];
}
export async function normalizeImage(file: File): Promise<Buffer> {
  const error = imageFileError(file);
  if (error) throw new HttpError(file.size > MAX_IMAGE_BYTES ? 413 : 415, error);
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    // Do not let the client MIME type dispatch an unsupported format to a native parser.
    if (!matchesImageSignature(bytes, file.type)) throw new Error("Mismatched image signature");
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    const expected: Record<string, string> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
    if (metadata.format !== expected[file.type] || (metadata.pages || 1) > 1) throw new Error("Invalid image");
    return await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).timeout({ seconds: 5 }).toBuffer();
  } catch { throw new HttpError(415, "The file is not a valid static PNG, JPEG, or WebP screenshot. Try a new capture."); }
}
