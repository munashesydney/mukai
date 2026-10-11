import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import yauzl from 'yauzl';
import { ATTACHMENT_LIMIT, UPLOAD_LIMIT } from '../../shared/ai';
import { randomUUID } from 'node:crypto';
import type { AttachmentRecord } from '../models/entities';
import { publicAttachment } from '../models/entities';
import { AttachmentRepository } from '../repositories/attachmentRepository';
import { BotRepository } from '../repositories/botRepository';
import { ApiError } from '../config';

const textExtensions = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.html',
  '.xml',
  '.ts',
  '.js',
  '.py',
  '.css',
  '.yaml',
  '.yml',
  '.log',
]);
const TEXT_LIMIT = 24000;
async function checkDocx(buffer: Buffer) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(new ApiError(400, 'This DOCX file could not be read.'));
      let size = 0,
        entries = 0,
        document = false;
      zip.on('error', () => {
        zip.close();
        reject(new ApiError(400, 'This DOCX file could not be read.'));
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        size += entry.uncompressedSize;
        entries++;
        if (size > 32 * 1024 * 1024 || entries > 500 || entry.generalPurposeBitFlag & 1) {
          zip.close();
          reject(
            new ApiError(400, 'This document is encrypted or expands beyond the document limit.'),
          );
          return;
        }
        if (entry.fileName === 'word/document.xml') document = true;
        zip.readEntry();
      });
      zip.on('end', () =>
        document ? resolve() : reject(new ApiError(400, 'Upload a valid DOCX document.')),
      );
      zip.readEntry();
    });
  });
}
export class AttachmentService {
  private deletionGuard?: (botId: string) => void;
  attachDeletionGuard(guard: (botId: string) => void) {
    this.deletionGuard = guard;
  }
  constructor(
    private attachments: AttachmentRepository,
    private bots: BotRepository,
    private uploads: string,
  ) {
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
  }
  list(botId: string, pending: boolean) {
    if (pending) return this.pending('bot-' + botId);
    return this.attachments.forBot(botId, pending).map(publicAttachment);
  }
  forMessage(id: string) {
    return this.attachments.forMessage(id);
  }
  pending(conversationId: string) {
    return this.attachments.pending(conversationId).map(publicAttachment);
  }
  storageNames(botId: string) {
    return this.attachments.storageNames(botId);
  }
  bytes(file: AttachmentRecord) {
    return readFileSync(join(this.uploads, file.storageName));
  }
  async upload(
    botId: string,
    originalName: string,
    buffer: Buffer,
    conversationId = 'bot-' + botId,
  ) {
    if (!buffer.length || buffer.length > UPLOAD_LIMIT)
      throw new ApiError(413, 'Files must be between 1 byte and 10 MB.');
    const name = [...basename(originalName.replace(/\\/g, '/'))]
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join('')
      .slice(0, 180);
    if (!name) throw new ApiError(400, 'A filename is required.');
    const extension = extname(name).toLowerCase();
    let mediaType = '',
      kind: AttachmentRecord['kind'] = 'text',
      text: string | null = null,
      warning: string | null = null;
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
      kind = 'image';
      if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        mediaType = 'image/png';
      else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
        mediaType = 'image/jpeg';
      else if (
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP'
      )
        mediaType = 'image/webp';
      else throw new ApiError(400, 'This file is not a supported PNG, JPEG, or WebP image.');
    } else if (extension === '.pdf') {
      if (buffer.toString('ascii', 0, 5) !== '%PDF-')
        throw new ApiError(400, 'Upload a valid PDF document.');
      mediaType = 'application/pdf';
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText({ first: 20 });
        text = result.text;
        warning =
          'PDF text is extracted from the first 20 pages. Layout, images, and scanned pages are not sent.';
      } catch {
        throw new ApiError(
          400,
          'This PDF could not be read. Password-protected documents are unsupported.',
        );
      } finally {
        await parser.destroy();
      }
    } else if (extension === '.docx') {
      mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      await checkDocx(buffer);
      try {
        text = (await mammoth.extractRawText({ buffer })).value;
      } catch {
        throw new ApiError(400, 'This DOCX document could not be read.');
      }
      warning =
        'Document text is extracted. Formatting, embedded images, and comments are not sent.';
    } else if (textExtensions.has(extension)) {
      mediaType = 'text/plain';
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        throw new ApiError(400, 'Text files must use UTF-8 encoding.');
      }
      if (text.includes('\0')) throw new ApiError(400, 'Binary files are not supported.');
    } else
      throw new ApiError(
        400,
        'Supported files: PNG, JPEG, WebP, PDF, DOCX, and common UTF-8 text/code files.',
      );
    if (kind === 'text' && !text?.trim())
      throw new ApiError(
        400,
        'This document has no readable text. Scanned documents need OCR before uploading.',
      );
    if (text && text.length > TEXT_LIMIT) {
      warning = `${warning ? warning + ' ' : ''}Only the first ${TEXT_LIMIT.toLocaleString()} characters are sent to the model.`;
      text = text.slice(0, TEXT_LIMIT);
    }
    this.deletionGuard?.(botId);
    if (!this.bots.find(botId)) throw new ApiError(404, 'Bot not found.');
    if (this.attachments.pendingCount(botId, conversationId) >= ATTACHMENT_LIMIT)
      throw new ApiError(400, 'Remove unused attachments before uploading more.');
    const id = randomUUID();
    const file: AttachmentRecord = {
      id,
      botId,
      messageId: null,
      conversationId,
      name,
      mediaType,
      size: buffer.length,
      kind,
      storageName: id + extension,
      extractedText: text,
      warning,
    };
    writeFileSync(join(this.uploads, file.storageName), buffer, { flag: 'wx', mode: 0o600 });
    try {
      this.attachments.create(file);
    } catch (error) {
      unlinkSync(join(this.uploads, file.storageName));
      throw error;
    }
    return publicAttachment(file);
  }
  select(ids: string[], botId: string, vision: boolean, conversationId = 'bot-' + botId) {
    if (ids.length > ATTACHMENT_LIMIT || new Set(ids).size !== ids.length)
      throw new ApiError(400, 'Attach up to four different files.');
    return ids.map((id) => {
      const row = this.attachments.find(id);
      if (
        !row ||
        row.botId !== botId ||
        row.conversationId !== conversationId ||
        row.messageId !== null
      )
        throw new ApiError(400, 'An attachment is missing or already sent. Upload it again.');
      if (row.kind === 'image' && !vision)
        throw new ApiError(
          400,
          'This model is configured for text only. Remove the image or choose a vision model in the model picker.',
        );
      return row;
    });
  }
  read(id: string) {
    const row = this.attachments.find(id);
    if (!row) throw new ApiError(404, 'Attachment not found.');
    return { row, bytes: this.bytes(row) };
  }
  remove(id: string) {
    const row = this.attachments.find(id);
    if (!row) throw new ApiError(404, 'Attachment not found.');
    if (row.messageId) throw new ApiError(409, 'Sent attachments are part of the chat history.');
    this.attachments.delete(id);
    this.removeFile(String(row.storageName));
  }
  removeFile(name: string) {
    try {
      unlinkSync(join(this.uploads, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
