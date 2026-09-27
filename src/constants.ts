/**
 * Supported formats and their groups. `FileType.PDF` instead of 'application/pdf'; plain strings type-check too.
 * A const object, not an enum: Node runs this TypeScript directly, and enums are not erasable syntax.
 */
export const FileType = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp',
  TIFF: 'image/tiff',

  TXT: 'text/plain',
} as const;
export type FileType = (typeof FileType)[keyof typeof FileType];

/** Parsed by LiteParse; Office files need LibreOffice installed. */
export const DOCUMENT_TYPES: ReadonlySet<string> = new Set([FileType.PDF, FileType.DOCX, FileType.XLSX, FileType.PPTX]);

/** OCR'd directly, the same way as pictures inside documents. */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([FileType.PNG, FileType.JPEG, FileType.WEBP, FileType.TIFF]);

/** Types the model reads as file parts (OpenAI); anything else is converted to PNG before it is sent. */
export const MODEL_TYPES: ReadonlySet<string> = new Set([
  FileType.PDF,
  FileType.PNG,
  FileType.JPEG,
  FileType.WEBP,
  'image/gif',
]);

/** Extension LibreOffice picks its converter by. */
export const EXTENSIONS: Readonly<Record<string, string>> = {
  [FileType.DOCX]: 'docx',
  [FileType.XLSX]: 'xlsx',
  [FileType.PPTX]: 'pptx',
};

export const isDocumentType = (type: string) => DOCUMENT_TYPES.has(type);
export const isImageType = (type: string) => IMAGE_TYPES.has(type);
/** Read as-is, no parser: text/* and common text-based application types. */
export const isTextType = (type: string) =>
  type.startsWith('text/') || /^application\/(json|xml|yaml|x-yaml|toml|javascript|typescript|sql)$/.test(type);
