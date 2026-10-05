// In-memory mailer and object store (stand-ins for SES and S3).

import { hmacSha256, toHex } from '../crypto.js';
import { AppError } from '../util.js';

/** Mailer port: send({to, subject, text, kind, ...}) → {messageId} */
export function createMemoryMailer({ clock, listener = null } = {}) {
  const sent = [];
  let n = 0;
  return {
    async send(msg) {
      if (!msg.to || !msg.subject) throw new Error('mail needs to + subject');
      const rec = { messageId: `msg-${++n}`, at: clock ? clock.now() : Date.now(), ...msg };
      sent.push(rec);
      if (listener) listener(rec);
      return { messageId: rec.messageId };
    },
    inbox: (to) => sent.filter((m) => m.to === to),
    all: () => sent,
  };
}

/**
 * Object store port (S3):
 *   presignGet(key, ttlSec)                       → url
 *   presignPut(key, {contentType, maxBytes, ttlSec}) → {url, fields}
 * Locally the URL is signed with HMAC like a SigV4 query-string presign, and
 * `resolve(url)` checks signature and expiry the way S3 would.
 */
export function createMemoryObjects({ clock, secret = 'local-objects', bucket = 'softhub-installers' } = {}) {
  const objects = new Map();
  function sign(method, key, expires) {
    return toHex(hmacSha256(secret, `${method}\n${bucket}\n${key}\n${expires}`)).slice(0, 32);
  }
  return {
    bucket,
    put(key, body, meta = {}) { objects.set(key, { body, meta }); },
    async presignGet(key, ttlSec = 300) {
      const expires = Math.floor(clock.now() / 1000) + ttlSec;
      return `https://${bucket}.s3.local/${encodeURI(key)}?X-Expires=${expires}&X-Signature=${sign('GET', key, expires)}`;
    },
    async presignPut(key, { contentType, maxBytes, ttlSec = 300 }) {
      const expires = Math.floor(clock.now() / 1000) + ttlSec;
      return {
        url: `https://${bucket}.s3.local/${encodeURI(key)}?X-Expires=${expires}&X-Signature=${sign('PUT', key, expires)}`,
        headers: { 'content-type': contentType }, maxBytes, expires,
      };
    },
    /** What S3 would do with the URL: verify signature and expiry. */
    resolve(url, method = 'GET') {
      const u = new URL(url);
      const key = decodeURI(u.pathname.slice(1));
      const expires = Number(u.searchParams.get('X-Expires'));
      if (u.searchParams.get('X-Signature') !== sign(method, key, expires)) throw new AppError(403, 's3.signature', 'SignatureDoesNotMatch');
      if (clock.now() / 1000 > expires) throw new AppError(403, 's3.expired', 'Request has expired');
      return { key, object: objects.get(key) || null };
    },
  };
}
