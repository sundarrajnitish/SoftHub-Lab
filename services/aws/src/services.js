// Stripe, SES, S3 and Cognito adapters for the core ports.

import Stripe from 'stripe';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CognitoIdentityProviderClient, AdminDisableUserCommand, AdminEnableUserCommand, AdminUserGlobalSignOutCommand,
  AdminAddUserToGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AppError } from '../../../packages/core/src/util.js';

/** Payments port on Stripe. Retries with the same idempotency key are safe. */
export function createStripePayments(secretKey, { client = null } = {}) {
  const stripe = client || new Stripe(secretKey, { apiVersion: '2024-06-20', maxNetworkRetries: 2, timeout: 8000 });
  return {
    async createPaymentIntent({ amount, currency, metadata, idempotencyKey, description }) {
      const pi = await stripe.paymentIntents.create(
        { amount, currency, metadata, description, automatic_payment_methods: { enabled: true } },
        { idempotencyKey },
      );
      return { id: pi.id, clientSecret: pi.client_secret, status: pi.status, amount: pi.amount, currency: pi.currency };
    },
    async refund({ paymentIntentId, amount, reason }) {
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntentId, amount, reason: reason === 'duplicate' ? 'duplicate' : 'requested_by_customer' },
        { idempotencyKey: `refund-${paymentIntentId}-${amount}` },
      );
      return { id: r.id, amount: r.amount };
    },
    async cancel(paymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.cancel(paymentIntentId);
        return { id: pi.id, status: pi.status };
      } catch (e) {
        throw new AppError(400, 'stripe.cannot_cancel', e.message);
      }
    },
  };
}

/** Mailer port on SES v2 (plain-text receipts; the From address must be verified). */
export function createSesMailer({ from, configurationSet, client = new SESv2Client({}) }) {
  return {
    async send({ to, subject, text }) {
      const r = await client.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
        ConfigurationSetName: configurationSet,
      }));
      return { messageId: r.MessageId };
    },
  };
}

/** Object store port on S3 presigned URLs. */
export function createS3Objects({ bucket, client = new S3Client({}) }) {
  return {
    bucket,
    presignGet: (key, ttlSec = 300) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSec }),
    async presignPut(key, { contentType, maxBytes, ttlSec = 600 }) {
      const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: ttlSec });
      return { url, headers: { 'content-type': contentType }, maxBytes, expires: Math.floor(Date.now() / 1000) + ttlSec };
    },
  };
}

/** Directory port: suspend/reinstate at the identity provider too. */
export function createCognitoDirectory({ userPoolId, client = new CognitoIdentityProviderClient({}) }) {
  return {
    async setEnabled(sub, enabled) {
      // In this pool the username is the sub (e-mail is an alias).
      if (enabled) {
        await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: sub }));
      } else {
        await client.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: sub }));
        await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: sub }));
      }
    },
    addToGroup: (username, group) => client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: group })),
  };
}

/** Secrets are read once per container and cached. */
let secretsCache = null;
export async function loadSecrets(secretId, client = new SecretsManagerClient({})) {
  if (secretsCache) return secretsCache;
  const r = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const s = JSON.parse(r.SecretString);
  for (const k of ['stripeSecretKey', 'stripeWebhookSecret', 'licenseSecret']) {
    if (!s[k]) throw new Error(`secret ${secretId} is missing ${k}`);
  }
  secretsCache = s;
  return s;
}
