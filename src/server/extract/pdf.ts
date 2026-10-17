import { extractText } from 'unpdf';

export async function readPdf(bytes: Buffer): Promise<{ pageCount: number; text: string }> {
  const result = await extractText(bytes, { mergePages: true });
  return { pageCount: result.totalPages, text: result.text };
}
