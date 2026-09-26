import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { config } from '../config.js';

let client: SupabaseClient | null = null;
function supabase(): SupabaseClient {
  if (!config.supabase.url || !config.supabase.key) throw new Error('Supabase Storage is not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
  return (client ??= createClient(config.supabase.url, config.supabase.key, {
    auth: { persistSession: false },
    realtime: { timeout: 30000 },
    global: { headers: {} },
  } as Parameters<typeof createClient>[2] & { realtime: { timeout: number } }));
}

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Validates the image, resizes to the card ratio and converts to WebP. Throws on anything that is not an image. */
export async function processThumbnail(input: Buffer): Promise<Buffer> {
  const meta = await sharp(input).metadata();
  if (!meta.format || !['jpeg', 'png', 'webp', 'gif', 'avif'].includes(meta.format)) throw new Error('Unsupported image type. Use PNG, JPG or WebP.');
  if ((meta.width ?? 0) < 400) throw new Error('Image is too small. Please upload at least 600px wide.');
  return sharp(input).rotate().resize(1200, 534, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer();
}

export async function uploadThumbnail(slug: string, webp: Buffer): Promise<string> {
  const path = `${slug}.webp`;
  const { error } = await supabase().storage.from(config.supabase.bucket).upload(path, webp, { contentType: 'image/webp', upsert: true, cacheControl: '31536000' });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return `${config.supabase.url}/storage/v1/object/public/${config.supabase.bucket}/${path}?v=${Date.now()}`;
}

export const storageConfigured = (): boolean => Boolean(config.supabase.url && config.supabase.key);
