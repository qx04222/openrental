/**
 * Supabase Storage Service
 * Upload images directly to Supabase Storage using REST API
 */

import { logger } from "../_core/logger";

const BUCKET_NAME = "inspections";

function getSupabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL;
}

function getSupabaseServiceKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_KEY;
}

export function isSupabaseStorageConfigured(): boolean {
  return !!(getSupabaseUrl() && getSupabaseServiceKey());
}

/**
 * Upload a base64 image to Supabase Storage
 * Returns public URL or original base64 as fallback
 */
export async function uploadToSupabaseStorage(base64DataUrl: string, path: string, bucket: string = BUCKET_NAME): Promise<string> {
  if (!isSupabaseStorageConfigured()) {
    logger.warn("[SupabaseStorage] Not configured, returning base64");
    return base64DataUrl;
  }

  if (base64DataUrl.startsWith("http://") || base64DataUrl.startsWith("https://")) {
    return base64DataUrl;
  }

  if (!base64DataUrl.startsWith("data:")) {
    logger.warn("[SupabaseStorage] Invalid base64 data URL");
    return base64DataUrl;
  }

  try {
    const matches = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) throw new Error("Invalid base64 format");

    const mimeType = matches[1];
    const base64Data = matches[2];
    const binaryData = Buffer.from(base64Data, "base64");

    const mimeToExt: Record<string, string> = {
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
      "application/pdf": "pdf",
      "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
    };
    const ext = mimeToExt[mimeType] || mimeType.split("/")[1] || "bin";
    const fullPath = path.endsWith(`.${ext}`) ? path : `${path}.${ext}`;

    const supabaseUrl = getSupabaseUrl();
    const supabaseServiceKey = getSupabaseServiceKey();
    const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${fullPath}`;

    logger.info("[SupabaseStorage] Uploading", { bucket, path: fullPath, size: `${Math.round(binaryData.length / 1024)}KB` });

    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseServiceKey}`,
        "Content-Type": mimeType,
        "x-upsert": "true",
      },
      body: binaryData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} - ${errorText}`);
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fullPath}`;
    logger.info("[SupabaseStorage] Upload successful", { url: publicUrl });
    return publicUrl;
  } catch (error) {
    logger.error("[SupabaseStorage] Upload failed", { error: error instanceof Error ? error.message : String(error) });
    return base64DataUrl;
  }
}

/**
 * Upload inspection photos to Supabase Storage
 * Organized by equipment: {equipmentId}/{type}_{date}_{time}_{position}.jpg
 */
export async function uploadInspectionPhotosToSupabase(
  data: {
    photoFront?: string | null;
    photoBack?: string | null;
    photoLeft?: string | null;
    photoRight?: string | null;
    photoAdditional?: string | null;
    customerSignature?: string | null;
  },
  inspectionId?: number | string,
  inspectionType?: string,
  equipmentIdentifier?: string
): Promise<{
  photoFront: string | null;
  photoBack: string | null;
  photoLeft: string | null;
  photoRight: string | null;
  photoAdditional: string | null;
  customerSignature: string | null;
}> {
  const type = inspectionType || "general";
  const equipmentFolder = equipmentIdentifier || (inspectionId ? `rental-${inspectionId}` : "unknown");
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(today.getHours()).padStart(2, "0")}${String(today.getMinutes()).padStart(2, "0")}`;

  const [photoFrontUrl, photoBackUrl, photoLeftUrl, photoRightUrl, photoAdditionalUrl, customerSignatureUrl] =
    await Promise.all([
      data.photoFront ? uploadToSupabaseStorage(data.photoFront, `${equipmentFolder}/${type}_${dateStr}_${timeStr}_front`) : Promise.resolve(null),
      data.photoBack ? uploadToSupabaseStorage(data.photoBack, `${equipmentFolder}/${type}_${dateStr}_${timeStr}_back`) : Promise.resolve(null),
      data.photoLeft ? uploadToSupabaseStorage(data.photoLeft, `${equipmentFolder}/${type}_${dateStr}_${timeStr}_left`) : Promise.resolve(null),
      data.photoRight ? uploadToSupabaseStorage(data.photoRight, `${equipmentFolder}/${type}_${dateStr}_${timeStr}_right`) : Promise.resolve(null),
      data.photoAdditional ? uploadToSupabaseStorage(data.photoAdditional, `${equipmentFolder}/${type}_${dateStr}_${timeStr}_additional`) : Promise.resolve(null),
      data.customerSignature ? uploadToSupabaseStorage(data.customerSignature, `${equipmentFolder}/${type}_${dateStr}_${timeStr}_signature`) : Promise.resolve(null),
    ]);

  return {
    photoFront: photoFrontUrl,
    photoBack: photoBackUrl,
    photoLeft: photoLeftUrl,
    photoRight: photoRightUrl,
    photoAdditional: photoAdditionalUrl,
    customerSignature: customerSignatureUrl,
  };
}

/**
 * Upload contract PDF to Supabase Storage
 */
export async function uploadContractToStorage(pdfBuffer: Buffer, fileName: string): Promise<string> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseServiceKey = getSupabaseServiceKey();

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Supabase Storage not configured");
  }

  const bucket = "contracts";
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: new Uint8Array(pdfBuffer),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Contract upload failed: ${response.status} - ${errorText}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
}

/**
 * Upload a PDF buffer to any Supabase Storage bucket.
 */
export async function uploadPDFToBucket(pdfBuffer: Buffer, fileName: string, bucket: string): Promise<string> {
  const supabaseUrl = getSupabaseUrl();
  const supabaseServiceKey = getSupabaseServiceKey();

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Supabase Storage not configured");
  }

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      "Content-Type": "application/pdf",
      "x-upsert": "true",
    },
    body: new Uint8Array(pdfBuffer),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PDF upload failed (${bucket}): ${response.status} - ${errorText}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;
}
