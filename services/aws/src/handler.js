// AWS Lambda entry points. One bundle, several handlers (see infra/template.yaml):
//   http             API Gateway HTTP API (payload v2) → core router
//   stream           DynamoDB stream (OUTBOX# inserts) → receipt e-mails
//   postConfirmation Cognito trigger → group membership + profile row
//
// Everything expensive (SDK clients, secrets, the app) is built once per
// container during init and reused by warm invocations.

import { unmarshall } from '@aws-sdk/util-dynamodb';
import { createApp } from '../../../packages/core/src/api/app.js';
import { principalFromClaims, SELF_SERVICE_ROLES } from '../../../packages/core/src/auth.js';
import { createIdFactory, systemClock } from '../../../packages/core/src/util.js';
import { createDynamoTable } from './dynamo.js';
import { createStripePayments, createSesMailer, createS3Objects, createCognitoDirectory, loadSecrets } from './services.js';

const env = process.env;
let appPromise = null;

function build() {
  return (async () => {
    const secrets = await loadSecrets(env.SECRET_ID);
    const deps = {
      table: createDynamoTable({ tableName: env.TABLE_NAME }),
      payments: createStripePayments(secrets.stripeSecretKey),
      mailer: createSesMailer({ from: env.MAIL_FROM, configurationSet: env.SES_CONFIGURATION_SET || undefined }),
      objects: createS3Objects({ bucket: env.BUCKET_NAME }),
      directory: createCognitoDirectory({ userPoolId: env.USER_POOL_ID }),
      clock: systemClock,
      newId: createIdFactory(systemClock),
      config: {
        licenseSecret: secrets.licenseSecret,
        webhookSecret: secrets.stripeWebhookSecret,
        appUrl: env.APP_URL,
        allowedOrigins: (env.ALLOWED_ORIGINS || '*').split(','),
      },
    };
    return createApp(deps, { fn: env.FUNCTION_GROUP || null });
  })();
}

const app = () => (appPromise ||= build().catch((e) => { appPromise = null; throw e; }));

/** API Gateway HTTP API (payload format 2.0). */
export async function http(event) {
  const a = await app();
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const body = event.body === undefined || event.body === null ? undefined
    : event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const res = await a.handle({
    method: event.requestContext.http.method,
    path: event.rawPath.replace(/^\/(prod|dev)(?=\/)/, ''),
    query: event.queryStringParameters || {},
    headers: event.headers || {},
    body,
    principal: claims ? principalFromClaims(claims) : null,
    requestId: event.requestContext.requestId,
  });
  return { statusCode: res.status, headers: res.headers, body: res.body };
}

/**
 * DynamoDB stream batch. Failures are reported per record so only the failed
 * ones are retried (ReportBatchItemFailures).
 */
export async function stream(event) {
  const a = await app();
  const failures = [];
  for (const r of event.Records || []) {
    try {
      await a.processStreamRecord({
        eventName: r.eventName,
        keys: unmarshall(r.dynamodb.Keys),
        newImage: r.dynamodb.NewImage ? unmarshall(r.dynamodb.NewImage) : null,
        oldImage: r.dynamodb.OldImage ? unmarshall(r.dynamodb.OldImage) : null,
      });
    } catch (e) {
      console.error('stream record failed', r.dynamodb?.SequenceNumber, e);
      failures.push({ itemIdentifier: r.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
}

/**
 * Cognito post-confirmation trigger. The requested role comes from the
 * sign-up's client metadata and is only honoured if it is self-service
 * (Consumer or Provider) — Admin is granted by hand, never by sign-up.
 */
export async function postConfirmation(event) {
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;
  const a = await app();
  const requested = event.request.clientMetadata?.role;
  const group = SELF_SERVICE_ROLES.includes(requested) ? requested : 'Consumer';
  await createCognitoDirectory({ userPoolId: event.userPoolId }).addToGroup(event.userName, group);
  await a.onUserConfirmed({ sub: event.request.userAttributes.sub, email: event.request.userAttributes.email, group });
  return event;
}
