import { JWK } from 'node-jose';
// Note: this file is used by jest/integration and cy/integration.
import { ClientType, Parcel, PrivateJWK, PublicJWK } from '../../..'; // eslint-disable-line import/extensions

declare global {
  var Cypress: undefined | any; // eslint-disable-line no-var
}
const apiUrl =
  process.env.PARCEL_API_URL ??
  globalThis.Cypress?.env('PARCEL_API_URL') ?? // CYPRESS_PARCEL_API_URL
  'http://localhost:4242/v1';
const storageUrl =
  process.env.PARCEL_STORAGE_URL ??
  globalThis.Cypress?.env('PARCEL_STORAGE_URL') ?? // CYPRESS_PARCEL_STORAGE_URL
  'http://localhost:4244';
const authUrl =
  process.env.PARCEL_AUTH_URL ??
  globalThis.Cypress?.env('PARCEL_AUTH_URL') ?? // CYPRESS_PARCEL_AUTH_URL
  'http://localhost:4040';

export async function generateJWKPair() {
  const keyPair = await JWK.createKey('EC', 'P-256', {
    alg: 'ES256',
    use: 'sig',
  });
  const publicKey = keyPair.toJSON(false) as PublicJWK;
  const privateKey = keyPair.toJSON(true) as PrivateJWK;
  return { publicKey, privateKey };
}

/** Creates a Parcel client using a bootstrap identity. */
export async function bootstrapParcel() {
  const parcel = new Parcel('not required in dev mode when identity creation is unauthenticated', {
    apiUrl,
    storageUrl,
  });

  const { privateKey, publicKey } = await generateJWKPair();
  const credential = {
    principal: `bootstrap${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)}`,
    privateKey,
  };
  await parcel.createIdentity({
    tokenVerifiers: [
      {
        sub: credential.principal,
        iss: credential.principal,
        publicKey,
      },
    ],
  });
  return new Parcel(credential, { apiUrl, storageUrl });
}

/**
 * Retrieve public keys from Auth and return the first one.
 * Auth returns the latest key first, and prefers using this key over existing ones.
 * Expects PARCEL_AUTH_URL env variable to be set.
 */
async function getAuthPublicKey(): Promise<PublicJWK> {
  const response = await fetch(`${authUrl}/.well-known/jwks.json`);
  if (!response.ok) {
    const hint = await response.text();
    throw new Error(`${response.statusText}${hint ? `: ${hint}` : ''}`);
  }

  const { keys }: { keys: PublicJWK[] } = await response.json();

  if (!keys?.[0]) {
    throw new Error(`Oasis Auth public key is not available from ${authUrl}`);
  }

  return keys[0];
}

export async function createAppAndClient(parcel: Parcel) {
  const app = await parcel.createApp({
    admins: [],
    allowUserUploads: false,
    collaborators: [],
    homepageUrl: 'https://oasislabs.com',
    identity: {
      tokenVerifiers: [
        {
          publicKey: await getAuthPublicKey(),
          iss: authUrl,
        },
      ],
    },
    inviteOnly: false,
    invites: [],
    logoUrl: 'https://oasislabs.com',
    name: 'a',
    organization: '',
    privacyPolicy: 'https://oasislabs.com',
    published: true,
    shortDescription: '',
    termsAndConditions: 'https://oasislabs.com',
    acceptanceText: '',
    brandingColor: '',
    category: '',
    extendedDescription: '',
    invitationText: '',
    rejectionText: '',
  });
  const client = await parcel.createClient(app.id, {
    type: ClientType.Frontend,
    name: 'a',
    redirectUris: ['https://oasislabs.com'],
    postLogoutRedirectUris: ['https://oasislabs.com'],
  });
  return { app, client };
}
