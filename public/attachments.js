/*
 * ox-chat — turning dropped, pasted, or picked files into things the model can
 * actually receive.
 *
 * Images are downscaled here rather than server-side: it keeps the upload small,
 * and beyond roughly 1568px on the long edge the model gains nothing anyway.
 * Text files are read as text and inlined by the server. This file never
 * interprets an image — it only re-encodes it.
 */
'use strict';

(function (global) {
  const MAX_EDGE = 1568;                     // past this, resolution is wasted
  const PNG_BUDGET = 1.5 * 1024 * 1024;      // when PNG gets heavier, switch to JPEG
  const RAW_KEEP_LIMIT = 1024 * 1024;        // below this, send the original bytes
  const MAX_TEXT_BYTES = 256 * 1024;         // must match the server's limit
  const THUMB_EDGE = 160;

  // Exactly what the server accepts; anything else is re-encoded to PNG.
  const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

  const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml',
    'ini', 'cfg', 'conf', 'env', 'log', 'sql', 'html', 'htm', 'xml', 'svg', 'css',
    'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
    'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'bat',
    'dockerfile', 'gitignore', 'diff', 'patch',
  ]);

  const extensionOf = (name) => (String(name).match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();

  const isImage = (file) => typeof file?.type === 'string' && file.type.startsWith('image/');

  function isTextual(file) {
    const type = file?.type || '';
    if (type.startsWith('text/')) return true;
    if (/^application\/(json|xml|javascript|x-sh|x-yaml|toml|sql)/.test(type)) return true;
    // A file with no MIME type at all is common for dotfiles and source files.
    return TEXT_EXTENSIONS.has(extensionOf(file?.name));
  }

  const canvasToBlob = (canvas, type, quality) =>
    new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not encode image'))), type, quality);
    });

  /** Base64 without blowing the argument limit on a large buffer. */
  async function toBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function draw(bitmap, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas;
  }

  async function prepareImage(file) {
    const bitmap = await createImageBitmap(file);
    const { width, height, scaled } = global.oxFormat.scaledDimensions(bitmap.width, bitmap.height, MAX_EDGE);

    let blob = file;
    let mediaType = file.type;

    // Re-encode when the image is oversized, heavy, or in a format the server
    // won't take. Otherwise the original bytes are already the best option.
    if (scaled || file.size > RAW_KEEP_LIMIT || !SENDABLE.has(mediaType)) {
      const canvas = draw(bitmap, width, height);
      // Screenshots are mostly text, and PNG keeps that crisp; only fall back
      // to JPEG when PNG would be too heavy to be worth it.
      blob = await canvasToBlob(canvas, 'image/png');
      mediaType = 'image/png';
      if (blob.size > PNG_BUDGET) {
        blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
        mediaType = 'image/jpeg';
      }
    }

    const thumbSize = global.oxFormat.scaledDimensions(width, height, THUMB_EDGE);
    const thumb = draw(bitmap, thumbSize.width, thumbSize.height)
      .toDataURL('image/jpeg', 0.7);

    bitmap.close?.();

    return {
      kind: 'image',
      name: file.name || 'pasted-image.png',
      mediaType,
      data: await toBase64(blob),
      bytes: blob.size,
      width,
      height,
      thumb,
    };
  }

  async function prepareText(file) {
    if (file.size > MAX_TEXT_BYTES) {
      throw new Error(`"${file.name}" is ${global.oxFormat.formatBytes(file.size)} — text files are limited to 256 KB.`);
    }
    return {
      kind: 'text',
      name: file.name || 'attachment.txt',
      text: await file.text(),
      bytes: file.size,
    };
  }

  /** Turn one File into an attachment, or throw with a reason a human can act on. */
  async function prepare(file) {
    if (!file) throw new Error('No file.');
    if (isImage(file)) return prepareImage(file);
    if (isTextual(file)) return prepareText(file);
    throw new Error(`"${file.name || 'that file'}" is not an image or a text file, so it cannot be attached.`);
  }

  /** Only the fields the server wants — thumbnails and dimensions stay local. */
  const forRequest = (attachment) =>
    attachment.kind === 'image'
      ? { kind: 'image', name: attachment.name, mediaType: attachment.mediaType, data: attachment.data }
      : { kind: 'text', name: attachment.name, text: attachment.text };

  /**
   * What gets saved to history: never the base64 payload, which would exhaust
   * localStorage within a handful of screenshots.
   */
  function forHistory(attachment) {
    const record = { kind: attachment.kind, name: attachment.name, bytes: attachment.bytes };
    if (attachment.kind === 'image') {
      record.width = attachment.width;
      record.height = attachment.height;
      // A ~160px thumbnail is a few KB; skip it if it somehow is not.
      if (attachment.thumb && attachment.thumb.length < 24 * 1024) record.thumb = attachment.thumb;
    }
    return record;
  }

  /** Pull attachable files out of a paste or drop event. */
  function filesFrom(event) {
    const transfer = event.clipboardData || event.dataTransfer;
    if (!transfer) return [];
    if (transfer.files?.length) return [...transfer.files];
    return [...(transfer.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }

  global.oxAttachments = { prepare, forRequest, forHistory, filesFrom, isImage, isTextual, MAX_TEXT_BYTES };
})(typeof window !== 'undefined' ? window : globalThis);
