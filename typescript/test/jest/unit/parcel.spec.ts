import { randomBytes } from 'crypto';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv, { SchemaObject, ValidateFunction } from 'ajv';
import ajvFormats from 'ajv-formats';
import bs58 from 'bs58';
import nock from 'nock';
import { paramCase } from 'param-case';
import { Writable } from 'readable-stream';
import type { JsonObject } from 'type-fest';

import type Parcel from '@oasislabs/parcel';
import type { AppId, AppUpdateParams, PODApp } from '@oasislabs/parcel/app';
import type {
  ClientCreateParams,
  ClientId,
  PODFrontendClient,
  ClientType,
  ClientUpdateParams,
  PODClient,
} from '@oasislabs/parcel/client';
import type { PermissionId, PODPermission } from '@oasislabs/parcel/permission';
import type { JobId, JobIo, JobSpec, PODJob } from '@oasislabs/parcel/compute';
import { JobPhase } from '@oasislabs/parcel/compute';
import type {
  DatabaseId,
  DatabaseUpdateParams,
  InsertParams,
  PODDatabase,
  Query,
  Row,
} from '@oasislabs/parcel/database';
import type { DocumentId, PODAccessEvent, PODDocument } from '@oasislabs/parcel/document';
import type { GrantId, PODGrant } from '@oasislabs/parcel/grant';
import { Capabilities, stringifyCaps } from '@oasislabs/parcel/grant';
import type { IdentityId, PODIdentity } from '@oasislabs/parcel/identity';
import type { PODMeteringQuota, PODMeteringReport } from '@oasislabs/parcel/meter';
import type { Page, PODModel } from '@oasislabs/parcel/model';
import type { PublicJWK } from '@oasislabs/parcel/token';

import { clone, makeParcel, nockIt, parcelNock, STORAGE_URL } from './helpers';

declare global {
  namespace jest {
    // eslint-disable-next-line no-unused-vars
    interface Matchers<R> {
      toMatchSchema: (schema: string | JsonObject) => CustomMatcherResult;
      toMatchPOD: <T extends PODModel | JsonObject>(pod: T) => CustomMatcherResult;
    }
  }
}

export const API_KEY = {
  kty: 'EC',
  d: '0fI_f6qv9MPkzvDged2YYEgYz9q1zTcHoNJl_vhLyeM',
  use: 'sig',
  crv: 'P-256',
  kid: '6-j7iM2OHHqu1HoulfQFcCSPAl_ghWa0abUv4Nl9GGk',
  x: 'C4GWlEeWvEQLtyvwndZzaHcKEfuZSZrQ2jikoH55EHU=',
  y: 'xNSJVFo7gewNmv-7aKZUkZdjn0fVi25XQi1pxYGZpWU=',
  alg: 'ES256',
} as const;
// The public key is a copy of the private key, but without the "d" key.
// We use slightly awkward syntax to make typescript type inference happy.
export const API_PUBLIC_KEY: PublicJWK = (() => {
  const { d: _, ...pub } = API_KEY;
  return pub;
})();

describe('Parcel', () => {
  let openapiSchema: any;
  let ajv: Ajv;

  let parcel: Parcel;

  beforeAll(async () => {
    openapiSchema = await SwaggerParser.validate('../../api/v1/parcel.yaml');

    ajv = ajvFormats(
      new Ajv({
        formats: {
          'RGB hex': /^#[\da-f]{6}$/i,
          path: /[^\0]+/,
        },
      }),
    );
    ajv.addFormat('byte', {
      type: 'string',
      validate: (b64s: string) => /^(?=(.{4})*$)[-A-Za-z\d/]*={0,2}$/.test(b64s),
    });
    ajv.addKeyword({
      keyword: 'example',
    });
    ajv.addKeyword({
      keyword: 'x-go-type',
      schemaType: 'string',
    });
    for (const [name, schema] of Object.entries(openapiSchema.components.schemas)) {
      ajv.addSchema(schema as SchemaObject, name);
    }

    expect.extend({
      toMatchSchema(
        received: any,
        schema: string | JsonObject,
      ): { message: () => string; pass: boolean } {
        let validator: ValidateFunction;
        if (typeof schema === 'string') {
          const schemaValidator = ajv.getSchema(schema);
          if (!schemaValidator) {
            return {
              pass: false,
              message: () => `unknown schema: \`${schema}\``,
            };
          }

          validator = schemaValidator;
        } else if (schema) {
          validator = ajv.compile(schema);
        } else {
          return {
            pass: false,
            message: () => 'no schema passed to `toMatchSchema`',
          };
        }

        const valid = validator(received);
        return {
          pass: valid,
          message: () =>
            `error ${JSON.stringify(validator.errors)} in schema ${JSON.stringify(
              validator.schema,
            )}`,
        };
      },
      toMatchPOD<T extends PODModel | JsonObject>(
        received: any,
        pod: T,
      ): { message: () => string; pass: boolean } {
        expect(JSON.parse(JSON.stringify(received))).toMatchObject(pod);
        return { message: () => '', pass: true };
      },
    });
  });

  type HttpVerb = 'GET' | 'POST' | 'PUT' | 'DELETE';

  function getRequestSchema(
    method: HttpVerb,
    endpoint: string,
    allowAdditional?: boolean,
  ): JsonObject {
    const requestSchema = openapiSchema.paths[endpoint][method.toLowerCase()];
    let schema = clone(requestSchema.requestBody.content['application/json'].schema);
    if (schema.allOf) schema = mergeAllOf(schema.allOf);
    for (const [propertyName, property] of Object.entries(schema.properties)) {
      if ((property as any).readOnly) {
        schema.required = schema.required.filter((p: string) => p !== propertyName);
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete schema.properties[propertyName];
      }
    }

    schema.additionalProperties = allowAdditional ?? false;
    ajv.validateSchema(schema) as boolean;
    expect(ajv.errors).toBeNull();
    return schema;
  }

  function getQueryParametersSchema(method: HttpVerb, endpoint: string): JsonObject {
    const params = openapiSchema.paths[endpoint][method.toLowerCase()].parameters.filter(
      (p: { in: string }) => p.in === 'query',
    );
    if (params.length > 1) return mergeAllOf(params.map((p: { schema: JsonObject }) => p.schema));
    return params[0].schema;
  }

  type Schema = { type: 'object'; required: string[]; properties: JsonObject; allOf?: Schema[] };
  function mergeAllOf(allOfs: Schema[]): Schema {
    const mergedRequires: Set<string> = new Set();
    const mergedProperties: JsonObject = {};
    for (let schema of allOfs) {
      if (schema.allOf) schema = mergeAllOf(schema.allOf);
      for (const required of schema.required ?? []) mergedRequires.add(required);
      Object.assign(mergedProperties, schema.properties);
    }

    return {
      type: 'object',
      required: [...mergedRequires.values()],
      properties: mergedProperties,
    };
  }

  function getResponseSchema(
    method: HttpVerb,
    endpoint: string,
    statusCode: number,
    contentType?: string,
    allowAdditional?: boolean,
  ): any {
    const responses = openapiSchema.paths[endpoint][method.toLowerCase()].responses[statusCode];
    if (!responses.content) return undefined;

    let { schema } = responses.content[contentType ?? 'application/json'];

    if (schema.type === 'string' && schema.format === 'binary') {
      schema.type = 'object'; // Workaround for JSON schema not having binary
      delete schema.format;
    }

    if (schema.allOf) schema = mergeAllOf(schema.allOf);
    schema.additionalProperties = allowAdditional ?? false;
    ajv.validateSchema(schema) as boolean;
    expect(ajv.errors).toBeNull();
    return schema;
  }

  beforeEach(() => {
    parcel = makeParcel();
  });

  afterAll(() => {
    nock.restore(); // https://github.com/nock/nock#memory-issues-with-jest
  });

  function makeRandomId() {
    return bs58.encode(randomBytes(8));
  }

  function createPodModel(): PODModel {
    const podModel = {
      id: makeRandomId(),
      createdAt: new Date().toISOString(),
    };
    expect(podModel).toMatchSchema('Model');
    return podModel;
  }

  const createIdentityId: () => IdentityId = () => makeRandomId() as IdentityId;
  const createDocumentId: () => DocumentId = () => makeRandomId() as DocumentId;
  const createJobId: () => JobId = () => makeRandomId() as JobId;
  const createAppId: () => AppId = () => makeRandomId() as AppId;
  const createPermissionId: () => PermissionId = () => makeRandomId() as PermissionId;

  function createPodIdentity(): PODIdentity {
    const podIdentity = {
      ...createPodModel(),
      tokenVerifiers: [
        {
          sub: 'subject',
          iss: 'auth.oasislabs.com',
          publicKey: API_PUBLIC_KEY,
        },
      ],
    };
    expect(podIdentity).toMatchSchema('Identity');
    return podIdentity;
  }

  function createPodDatabase(): PODDatabase {
    const podDatabase = {
      ...createPodModel(),
      creator: createIdentityId(),
      owner: createIdentityId(),
      name: 'A cheesy database',
    };
    expect(podDatabase).toMatchSchema('Database');
    return podDatabase;
  }

  function createPodDocument(): PODDocument {
    const podDocument = {
      ...createPodModel(),
      creator: createIdentityId(),
      owner: createIdentityId(),
      size: 1234,
      details: {
        tags: ['["mock"]', 'document'],
        key: { value: 42 },
      },
      originatingJob: createJobId(),
    };
    expect(podDocument).toMatchSchema('Document');
    return podDocument;
  }

  function createPodAccessEvent(options?: {
    document?: DocumentId;
    accessor?: IdentityId;
  }): PODAccessEvent {
    const podAccessEvent = {
      createdAt: new Date().toISOString(),
      document: options?.document ?? createPodDocument().id,
      accessor: options?.accessor ?? createPodIdentity().id,
    };
    expect(podAccessEvent).toMatchSchema('AccessEvent');
    return podAccessEvent;
  }

  function createPodApp(): PODApp {
    const podApp = {
      ...createPodModel(),
      owner: createIdentityId(),
      admins: [createIdentityId()],
      collaborators: [createIdentityId(), createIdentityId()],
      published: false,
      inviteOnly: true,
      invites: [createIdentityId()],
      participants: [],
      allowUserUploads: true,

      name: 'test app',
      organization: 'Oasis Labs',
      shortDescription: 'shrt dscrptn',
      homepageUrl: 'https://example.com',
      privacyPolicy: 'https://example.com/privacy',
      termsAndConditions: 'https://example.com/terms',

      invitationText: 'plz give data',
      acceptanceText: 'thanks for the data!',
      rejectionText: '🙁',

      extendedDescription: 'looooong description',
      brandingColor: '#abcdef',
      category: 'testing',
      logoUrl: 'https://logos.gif',
    };
    expect(podApp).toMatchSchema('App');
    return podApp;
  }

  function createPodClient(options?: { appId: AppId; isService?: boolean }): PODClient {
    const baseClient = {
      ...createPodModel(),
      creator: createIdentityId(),
      appId: options?.appId ?? createPodApp().id,
      name: 'test client',
    };
    if (options?.isService) {
      return {
        ...baseClient,
        type: 'service' as ClientType.Service,
        publicKeys: [
          {
            use: 'sig',
            kty: 'EC',
            kid: 'J07JL44uZsnGWFt87Vqs5HLO7B1RM7zd5XtWJwS7bpw=',
            crv: 'P-256',
            alg: 'ES256',
            x: 'L2uZsV50Qz4N227FeNARVi0IkKdgMKi8TqoBnhYp60s',
            y: 'E7ZbVjSKjBuBSLWARvFZ_lmT_Q-ifUQBB6QriBhhN-w',
          } as const,
        ],
      };
    }

    return {
      ...baseClient,
      type: 'frontend' as ClientType.Frontend,
      redirectUris: ['https://example.com/redirect'],
      postLogoutRedirectUris: ['https://example.com/post-logout-redirect'],
    };
  }

  function createPodGrant(): PODGrant {
    const podGrant = {
      ...createPodModel(),
      granter: createIdentityId(),
      grantee: createIdentityId(),
      permission: createPermissionId(),
      condition: { 'document.tags': { $contains: 'mock' } },
      capabilities: 'read',
    };
    expect(podGrant).toMatchSchema('Grant');
    return podGrant;
  }

  function createJobSpec(): JobSpec {
    const jobSpec = {
      name: 'my job',
      cmd: ['-v', 'foo,bar'],
      image: 'myrepo:mysha',
      env: { MY_ENV_VAR: 'my value', OTHER_VAR: 'other value' },
      inputDocuments: [
        {
          mountPath: 'myimage.png',
          id: createDocumentId(),
        },
      ],
      outputDocuments: [
        {
          mountPath: 'labels.json',
          owner: createIdentityId(),
        },
      ],
    };
    expect(jobSpec).toMatchSchema('JobSpec');
    return jobSpec;
  }

  function createJobIo(): JobIo {
    const jobIO = {
      accessedDocuments: [createDocumentId()],
      outputDocuments: [
        {
          mountPath: 'example.txt',
          id: createDocumentId(),
        },
      ],
    };
    expect(jobIO).toMatchSchema('JobIo');
    return jobIO;
  }

  function createPodJob(): PODJob {
    const podJob: PODJob = {
      ...createPodModel(),
      id: createJobId(),
      spec: createJobSpec(),
      io: createJobIo(),
      status: {
        phase: JobPhase.PENDING,
        message: 'foo',
        host: 'http://myworker/',
      },
    };
    expect(podJob).toMatchSchema('Job');
    return podJob;
  }

  function createPodPermission(): PODPermission {
    const podPermission: PODPermission = {
      ...createPodModel(),
      grants: [
        {
          granter: 'participant',
          grantee: 'app',
          condition: { 'document.tags': { $contains: 'mock' } },
        },
      ],
      appId: createAppId(),
      name: 'Permission Name',
      description: 'Permission Description',
      allowText: 'Allow',
      denyText: 'Deny',
    };
    expect(podPermission).toMatchSchema('Permission');
    return podPermission;
  }

  function createPodMeteringReport(): PODMeteringReport {
    const podMeteringReport: PODMeteringReport = {
      createCount: 100,
      readCount: 100,
      writeCount: 100,
      deleteCount: 100,
      uploadCount: 10,
      downloadCount: 10,
      uploadSizeBytes: 100_000,
      downloadSizeBytes: 100_000,
      computeMsec: 100_000,
    };
    expect(podMeteringReport).toMatchSchema('MeteringReport');
    return podMeteringReport;
  }

  function createPodMeteringQuota(): PODMeteringQuota {
    const podMeteringQuota: PODMeteringQuota = {
      apiCallsLimit: 1000,
      accessedBytesLimit: 10_000,
      computeMsecLimit: 1000,
    };
    expect(podMeteringQuota).toMatchSchema('MeteringQuota');
    return podMeteringQuota;
  }

  function createResultsPage<T>(n: number, factory: () => T): Page<T> {
    const page = {
      results: Array.from({ length: n })
        .fill(undefined)
        .map(() => factory()),
      nextPageToken: makeRandomId(),
    };
    expect(page).toMatchSchema('ResultsPage');
    return page;
  }

  describe('identity', () => {
    let fixtureIdentity: PODIdentity;

    function nockItWithCurrentIdentity(
      testName: string,
      test: (scope: nock.Scope) => Promise<void>,
    ): void {
      nockIt(testName, async (scope) =>
        test(scope.get('/identities/me').reply(200, fixtureIdentity)),
      );
    }

    beforeEach(() => {
      fixtureIdentity = createPodIdentity();
    });

    it('cannot send private key', () => {
      expect({
        sub: 'subject',
        iss: 'auth.oasislabs.com',
        publicKey: API_KEY, // Not public!
      }).not.toMatchSchema('IdentityTokenVerifier');
    });

    describe('create', () => {
      nockIt('create', async (scope) => {
        expect(fixtureIdentity).toMatchSchema(getResponseSchema('POST', '/identities', 201));
        const createParams = {
          tokenVerifiers: fixtureIdentity.tokenVerifiers,
        };
        expect(createParams).toMatchSchema(getRequestSchema('POST', '/identities'));
        scope.post('/identities', createParams).reply(201, fixtureIdentity);
        const identity = await parcel.createIdentity(createParams);
        expect(identity).toMatchPOD(fixtureIdentity);
      });

      nockIt('bad request', async (scope) => {
        scope.post('/identities').reply(400);
        await expect(parcel.createIdentity({} as any)).rejects.toThrow();
      });
    });

    nockItWithCurrentIdentity('get current', async () => {
      const identity = await parcel.getCurrentIdentity();
      expect(identity).toMatchPOD(fixtureIdentity);
    });

    nockItWithCurrentIdentity('update', async (scope) => {
      const updatedIdentity = Object.assign(clone(fixtureIdentity), {
        tokenVerifiers: createPodIdentity().tokenVerifiers,
      });

      scope
        .put(`/identities/${fixtureIdentity.id}`, {
          tokenVerifiers: updatedIdentity.tokenVerifiers,
        })
        .reply(200, updatedIdentity);

      const identity = await parcel.getCurrentIdentity();
      await identity.update({ tokenVerifiers: updatedIdentity.tokenVerifiers });
      expect(identity).toMatchPOD(updatedIdentity);
    });

    nockItWithCurrentIdentity('delete', async (scope) => {
      scope.delete(`/identities/${fixtureIdentity.id}`).reply(204);
      const identity = await parcel.getCurrentIdentity();
      await expect(identity.delete()).resolves.toBeUndefined();
    });

    describe('permissions', () => {
      nockItWithCurrentIdentity('grant', async (scope) => {
        const fixtureCreatedGrant = { grants: [createPodGrant()] };
        expect(fixtureCreatedGrant).toMatchSchema(
          getResponseSchema(
            'POST',
            '/identities/{identityOrAppId}/permissions/{permissionId}',
            201,
          ),
        );

        const fixturePermission = createPodPermission();
        scope
          .post(`/identities/${fixtureIdentity.id}/permissions/${fixturePermission.id}`)
          .reply(201, fixtureCreatedGrant);

        const identity = await parcel.getCurrentIdentity();
        const createdGrant = await identity.grantPermission(fixturePermission.id as PermissionId);
        expect(createdGrant.grants[0].capabilities).toEqual(Capabilities.Read);
      });

      describe('get', () => {
        nockItWithCurrentIdentity('granted', async (scope) => {
          const fixturePermission = createPodPermission();
          expect(fixturePermission).toMatchSchema(
            getResponseSchema(
              'GET',
              '/identities/{identityOrAppId}/permissions/{permissionId}',
              200,
            ),
          );

          scope
            .get(`/identities/${fixtureIdentity.id}/permissions/${fixturePermission.id}`)
            .reply(200, fixturePermission);

          const identity = await parcel.getCurrentIdentity();
          const permission = await identity.getGrantedPermission(
            fixturePermission.id as PermissionId,
          );
          expect(permission).toMatchPOD(fixturePermission);
        });

        nockItWithCurrentIdentity('not granted', async (scope) => {
          const fixturePermissionId = createPermissionId();
          scope
            .get(`/identities/${fixtureIdentity.id}/permissions/${fixturePermissionId}`)
            .reply(404, { error: 'not found' });

          const identity = await parcel.getCurrentIdentity();
          await expect(identity.getGrantedPermission(fixturePermissionId)).rejects.toThrow(
            'not found',
          );
        });
      });

      describe('list', () => {
        nockItWithCurrentIdentity('no filter', async (scope) => {
          const numberResults = 3;
          const fixtureResultsPage: Page<PODPermission> = createResultsPage(
            numberResults,
            createPodPermission,
          );
          expect(fixtureResultsPage).toMatchSchema(
            getResponseSchema('GET', '/identities/{identityOrAppId}/permissions', 200),
          );

          scope.get(`/identities/${fixtureIdentity.id}/permissions`).reply(200, fixtureResultsPage);

          const identity = await parcel.getCurrentIdentity();
          const { results, nextPageToken } = await identity.listGrantedPermissions();
          expect(results).toHaveLength(numberResults);
          for (const [i, r] of results.entries()) {
            expect(r).toMatchPOD(fixtureResultsPage.results[i]);
          }

          expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
        });

        nockItWithCurrentIdentity('with filter and pagination', async (scope) => {
          const numberResults = 1;
          const fixtureResultsPage: Page<PODPermission> = createResultsPage(
            numberResults,
            createPodPermission,
          );

          const filterWithPagination = {
            app: fixtureResultsPage.results[0].appId as AppId,
            pageSize: 2,
            pageToken: makeRandomId(),
          };
          expect(filterWithPagination).toMatchSchema(
            getQueryParametersSchema('GET', '/identities/{identityOrAppId}/permissions'),
          );

          scope
            .get(`/identities/${fixtureIdentity.id}/permissions`)
            .query(
              Object.fromEntries(
                Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
              ),
            )
            .reply(200, fixtureResultsPage);

          const identity = await parcel.getCurrentIdentity();
          const { results, nextPageToken } = await identity.listGrantedPermissions(
            filterWithPagination,
          );
          expect(results).toHaveLength(numberResults);
          for (const [i, r] of results.entries()) {
            expect(r).toMatchPOD(fixtureResultsPage.results[i]);
          }

          expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
        });

        nockItWithCurrentIdentity('no results', async (scope) => {
          const fixtureResultsPage: Page<PODPermission> = createResultsPage(0, createPodPermission);
          scope.get(`/identities/${fixtureIdentity.id}/permissions`).reply(200, fixtureResultsPage);
          const identity = await parcel.getCurrentIdentity();
          const { results, nextPageToken } = await identity.listGrantedPermissions();
          expect(results).toHaveLength(0);
          expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
        });
      });
    });

    nockItWithCurrentIdentity('revoke', async (scope) => {
      const fixturePermission = createPodPermission();
      scope
        .delete(`/identities/${fixtureIdentity.id}/permissions/${fixturePermission.id}`)
        .reply(204);

      const identity = await parcel.getCurrentIdentity();
      await identity.revokePermission(fixturePermission.id as PermissionId);
    });
  });

  describe('database', () => {
    let fixtureDatabase: PODDatabase;

    beforeEach(() => {
      fixtureDatabase = createPodDatabase();
    });

    describe('create', () => {
      nockIt('create', async (scope) => {
        expect(fixtureDatabase).toMatchSchema(getResponseSchema('POST', '/databases', 201));
        const createParams = {
          name: 'A cheesy database',
        };
        expect(createParams).toMatchSchema(getRequestSchema('POST', '/databases'));
        scope.post('/databases', createParams).reply(201, fixtureDatabase);
        const identity = await parcel.createDatabase(createParams);
        expect(identity).toMatchPOD(fixtureDatabase);
      });

      nockIt('bad request', async (scope) => {
        scope.post('/databases').reply(400);
        await expect(parcel.createDatabase({} as any)).rejects.toThrow();
      });
    });

    nockIt('get', async (scope) => {
      expect(fixtureDatabase).toMatchSchema(
        getResponseSchema('GET', '/databases/{databaseId}', 200),
      );
      scope.get(`/databases/${fixtureDatabase.id}`).reply(200, fixtureDatabase);
      const app = await parcel.getDatabase(fixtureDatabase.id as DatabaseId);
      expect(app).toMatchPOD(fixtureDatabase);
    });

    describe('update', () => {
      let update: DatabaseUpdateParams;
      let updatedDatabase: PODDatabase;

      beforeEach(() => {
        update = {
          name: 'new name',
        };
        updatedDatabase = Object.assign(clone(fixtureDatabase), update);
      });

      nockIt('by id', async (scope) => {
        scope.put(`/databases/${fixtureDatabase.id}`, update).reply(200, updatedDatabase);
        const updated = await parcel.updateDatabase(fixtureDatabase.id as DatabaseId, update);
        expect(updated).toMatchPOD(updatedDatabase);
      });

      nockIt('retrieved', async (scope) => {
        scope.put(`/databases/${fixtureDatabase.id}`, update).reply(200, updatedDatabase);
        scope.get(`/databases/${fixtureDatabase.id}`).reply(200, fixtureDatabase);

        const app = await parcel.getDatabase(fixtureDatabase.id as DatabaseId);
        await app.update(update);
        expect(app).toMatchPOD(updatedDatabase);
      });
    });

    describe('list', () => {
      nockIt('with filter and pagination', async (scope) => {
        const numberResults = 1;
        const fixtureResultsPage: Page<PODDatabase> = createResultsPage(
          numberResults,
          createPodDatabase,
        );

        const filterWithPagination = {
          owner: createIdentityId(),
          pageSize: 2,
          pageToken: makeRandomId(),
        };
        expect(filterWithPagination).toMatchSchema(getQueryParametersSchema('GET', '/databases'));
        scope
          .get('/databases')
          .query(
            Object.fromEntries(
              Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
            ),
          )
          .reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listDatabases(filterWithPagination);
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('no results', async (scope) => {
        const fixtureResultsPage: Page<PODDatabase> = createResultsPage(0, createPodDatabase);

        const filterWithPagination = {
          name: 'unknown database',
          owner: createIdentityId(),
        };
        expect(filterWithPagination).toMatchSchema(getQueryParametersSchema('GET', '/databases'));
        scope
          .get('/databases')
          .query(
            Object.fromEntries(
              Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
            ),
          )
          .reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listDatabases(filterWithPagination);
        expect(results).toHaveLength(0);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });
    });

    describe('query', () => {
      let query: Query;
      let rows: Row[];

      beforeEach(() => {
        query = {
          sql: 'CREATE TABLE threat_intels (wallet TEXT, inner TEXT, level INTEGER, data JSON)',
          params: {},
        };
        rows = [{}];
      });

      nockIt('create', async (scope) => {
        scope.post(`/databases/${fixtureDatabase.id}`, query as JsonObject).reply(200, rows);
        const data = await parcel.queryDatabase(fixtureDatabase.id as DatabaseId, query);
        expect(data).toHaveLength(1);
        expect(data).toEqual(rows);
      });
    });

    describe('insert', () => {
      let insert: InsertParams;
      let create: Query;
      let rows: Row[];

      beforeEach(() => {
        create = {
          sql: 'CREATE TABLE threat_intels (wallet TEXT, inner TEXT, level INTEGER, data JSON)',
          params: {},
        };
        insert = {
          tableName: 'threat_intels',
          rows: [
            {
              wallet: '0x1234',
              inner: 'safe',
              level: 3,
              data: {
                extra: null,
              },
            },
            {
              wallet: '0x4567',
              inner: 'unsafe',
              level: 8,
              data: {
                extra: {
                  origin: 'apple',
                },
              },
            },
          ],
        };
        rows = [{}];
      });

      nockIt('create', async (scope) => {
        scope.post(`/databases/${fixtureDatabase.id}`, create as JsonObject).reply(200, rows);
        await parcel.queryDatabase(fixtureDatabase.id as DatabaseId, create);
        scope.post(`/databases/${fixtureDatabase.id}/insert`, insert as JsonObject).reply(200, [
          {
            wallet: '0x1234',
            inner: 'safe',
            level: 3,
            data: {
              extra: null,
            },
          },
          {
            wallet: '0x4567',
            inner: 'unsafe',
            level: 8,
            data: {
              extra: {
                origin: 'apple',
              },
            },
          },
        ]);
        const insertedRows = await parcel.insertRows(fixtureDatabase.id as DatabaseId, insert);
        expect(insertedRows).toHaveLength(2);
        expect(insertedRows).toEqual(insert.rows);
      });
    });

    describe('delete', () => {
      nockIt('by id', async (scope) => {
        scope.delete(`/databases/${fixtureDatabase.id}`).reply(204);
        await parcel.deleteDatabase(fixtureDatabase.id as DatabaseId);
      });

      nockIt('retrieved', async (scope) => {
        scope.get(`/databases/${fixtureDatabase.id}`).reply(200, fixtureDatabase);
        scope.delete(`/databases/${fixtureDatabase.id}`).reply(204);
        const document = await parcel.getDatabase(fixtureDatabase.id as DatabaseId);
        await document.delete();
      });

      nockIt('expect 204', async (scope) => {
        scope.delete(`/databases/${fixtureDatabase.id}`).reply(200);
        await expect(parcel.deleteDatabase(fixtureDatabase.id as DatabaseId)).rejects.toThrow();
      });
    });
  });

  describe('document', () => {
    let fixtureDocument: PODDocument;
    const fixtureData = Buffer.from('fixture data');

    beforeEach(() => {
      fixtureDocument = createPodDocument();
    });

    class DownloadCollector extends Writable {
      private readonly bufs: Buffer[] = [];

      constructor(private readonly options?: { error: Error }) {
        super();
      }

      public _write(chunk: Buffer, _encoding: string, cb: (err?: any) => void) {
        if (this.options?.error) {
          cb(this.options?.error);
          return;
        }

        this.bufs.push(chunk);
        cb();
      }

      public get collectedDownload(): Buffer {
        return Buffer.concat(this.bufs);
      }
    }

    // Matches the metadata part of a (multipart) document upload request
    const MULTIPART_METADATA_RE =
      /name="metadata"\r\ncontent-type: application\/json\r\n\r\n{"details":{"tags":\["\[\\"mock\\"]","document","to-app-\w+"],"key":{"value":42}}}\r\n/gi;
    const MULTIPART_EMPTY_METADATA_RE = /name="metadata"\r\ncontent-type: text\/plain(?:\r\n){3}/gi;
    // Matches the data part of a (multipart) document upload request
    const MULTIPART_DATA_RE =
      /name="data"\r\ncontent-type: application\/octet-stream\r\n\r\nfixture data\r\n/gi;

    describe('upload', () => {
      it('no params', async () => {
        expect(fixtureDocument).toMatchSchema(getResponseSchema('POST', '/documents/upload', 201));
        const scope = parcelNock(STORAGE_URL)
          .post(
            '',
            (body: string) =>
              MULTIPART_EMPTY_METADATA_RE.test(body) && MULTIPART_DATA_RE.test(body),
          )
          .matchHeader('content-type', /^multipart\/form-data; boundary=/)
          .reply(201, fixtureDocument);
        const document = await parcel.uploadDocument(fixtureData, null /* params */).finished;
        expect(document).toMatchPOD(fixtureDocument);
        scope.done();
      });

      it('with params', async () => {
        const scope = parcelNock(STORAGE_URL)
          .post(
            '',
            (body: string) => MULTIPART_METADATA_RE.test(body) && MULTIPART_DATA_RE.test(body),
          )
          .matchHeader('content-type', /^multipart\/form-data; boundary=/)
          .reply(201, fixtureDocument);
        const document = await parcel.uploadDocument(fixtureData, {
          details: fixtureDocument.details,
          toApp: createAppId(),
        }).finished;
        expect(document).toMatchPOD(fixtureDocument);
        scope.done();
      });
    });

    nockIt('get', async (scope) => {
      expect(fixtureDocument).toMatchSchema(
        getResponseSchema('GET', '/documents/{documentId}', 200),
      );
      scope.get(`/documents/${fixtureDocument.id}`).reply(200, fixtureDocument);
      const document = await parcel.getDocument(fixtureDocument.id as DocumentId);
      expect(document).toMatchPOD(fixtureDocument);
    });

    describe('download', () => {
      it('by id', async () => {
        const scope = parcelNock(STORAGE_URL)
          .get(`/${fixtureDocument.id}/download`)
          .reply(200, fixtureData);
        const download = parcel.downloadDocument(fixtureDocument.id as DocumentId);
        const downloadCollector = new DownloadCollector();
        await download.pipeTo(downloadCollector);
        expect(downloadCollector.collectedDownload).toEqual(fixtureData);
        scope.done();
      });

      nockIt('retrieved', async (parcelScope) => {
        parcelScope.get(`/documents/${fixtureDocument.id}`).reply(200, fixtureDocument);
        const storageScope = parcelNock(STORAGE_URL)
          .get(`/${fixtureDocument.id}/download`)
          .reply(200, fixtureData);
        const document = await parcel.getDocument(fixtureDocument.id as DocumentId);
        const download = document.download();
        const downloadCollector = new DownloadCollector();
        await download.pipeTo(downloadCollector);
        expect(downloadCollector.collectedDownload).toEqual(fixtureData);
        storageScope.done();
      });

      it('not found', async () => {
        const scope = parcelNock(STORAGE_URL)
          .get(`/${fixtureDocument.id}/download`)
          .reply(404, { error: 'not found' });
        const download = parcel.downloadDocument(fixtureDocument.id as DocumentId);
        const downloadCollector = new DownloadCollector();
        await expect(download.pipeTo(downloadCollector)).rejects.toThrow(
          /error.*download.*: not found/,
        );
        scope.done();
      });

      it('write error', async () => {
        const scope = parcelNock(STORAGE_URL)
          .get(`/${fixtureDocument.id}/download`)
          .reply(200, fixtureData);
        const download = parcel.downloadDocument(fixtureDocument.id as DocumentId);
        const downloadCollector = new DownloadCollector({ error: new Error('whoops') });
        await expect(download.pipeTo(downloadCollector)).rejects.toThrow('whoops');
        scope.done();
      });

      it('aborted', async () => {
        const scope = parcelNock(STORAGE_URL)
          .get(`/${fixtureDocument.id}/download`)
          .delayBody(30)
          .reply(200, fixtureData);
        const download = parcel.downloadDocument(fixtureDocument.id as DocumentId);
        const downloadCollector = new DownloadCollector();
        const downloadComplete = download.pipeTo(downloadCollector);
        setTimeout(() => {
          download.abort();
        }, 10);
        await expect(downloadComplete).rejects.toThrow('The operation was aborted');
        expect(download.aborted).toBe(true);
        expect(downloadCollector.collectedDownload).toHaveLength(0);
        scope.done();
      });
    });

    describe('history', () => {
      nockIt('no filter', async (scope) => {
        scope.get(`/documents/${fixtureDocument.id}`).reply(200, fixtureDocument);

        const numberResults = 3;
        const fixtureResultsPage: Page<PODAccessEvent> = createResultsPage(
          numberResults,
          createPodAccessEvent,
        );
        expect(fixtureResultsPage).toMatchSchema(
          getResponseSchema('GET', '/documents/{documentId}/history', 200),
        );

        const document = await parcel.getDocument(fixtureDocument.id as DocumentId);

        scope.get(`/documents/${fixtureDocument.id}/history`).reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await document.history();
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('with filter and pagination', async (scope) => {
        scope.get(`/documents/${fixtureDocument.id}`).reply(200, fixtureDocument);

        const numberResults = 1;
        const fixtureResultsPage: Page<PODAccessEvent> = createResultsPage(
          numberResults,
          createPodAccessEvent,
        );

        const filterWithPagination = {
          accessor: fixtureDocument.owner as IdentityId,
          document: fixtureDocument.id,
          pageSize: 2,
          pageToken: makeRandomId(),
        };
        expect(filterWithPagination).toMatchSchema(
          getQueryParametersSchema('GET', '/documents/{documentId}/history'),
        );
        scope
          .get(`/documents/${fixtureDocument.id}/history`)
          .query(
            Object.fromEntries(
              Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
            ),
          )
          .reply(200, fixtureResultsPage);

        const document = await parcel.getDocument(fixtureDocument.id as DocumentId);

        const { results, nextPageToken } = await document.history(filterWithPagination);
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) {
          expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        }

        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('by id', async (scope) => {
        const numberResults = 3;
        const fixtureResultsPage: Page<PODAccessEvent> = createResultsPage(
          numberResults,
          createPodAccessEvent,
        );
        expect(fixtureResultsPage).toMatchSchema(
          getResponseSchema('GET', '/documents/{documentId}/history', 200),
        );

        scope.get(`/documents/${fixtureDocument.id}/history`).reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.getDocumentHistory(
          fixtureDocument.id as DocumentId,
        );
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) {
          expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        }

        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });
    });

    describe('list', () => {
      nockIt('no filter', async (scope) => {
        const numberResults = 3;
        const fixtureResultsPage: Page<PODDocument> = createResultsPage(
          numberResults,
          createPodDocument,
        );
        expect(fixtureResultsPage).toMatchSchema(
          getResponseSchema('POST', '/documents/search', 200),
        );

        scope.post('/documents/search').reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.searchDocuments();
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) {
          expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        }

        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('with filter and pagination', async (scope) => {
        const numberResults = 1;
        const fixtureResultsPage: Page<PODDocument> = createResultsPage(
          numberResults,
          createPodDocument,
        );

        const filterWithPagination = {
          accessibleInContext: {
            accessor: createIdentityId(),
          },
          selectedByCondition: {
            $and: [
              { 'document.tags': { $intersects: ['tag1', 'tag2'] } },
              {
                'document.creator': { $eq: fixtureResultsPage.results[0].creator as IdentityId },
              },
            ],
          },
          pageSize: 2,
          pageToken: makeRandomId(),
        };
        expect(filterWithPagination).toMatchSchema(
          getQueryParametersSchema('POST', '/documents/search'),
        );
        scope.post('/documents/search', filterWithPagination).reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.searchDocuments(filterWithPagination);
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) {
          expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        }

        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('no results', async (scope) => {
        const fixtureResultsPage: Page<PODDocument> = createResultsPage(0, createPodDocument);
        scope.post('/documents/search').reply(200, fixtureResultsPage);
        const { results, nextPageToken } = await parcel.searchDocuments();
        expect(results).toHaveLength(0);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });
    });

    describe('update', () => {
      nockIt('by id', async (scope) => {
        const update = {
          owner: createIdentityId(),
          details: { title: 'newtitle', tags: ['foo', 'bar'] },
        };
        expect(update).toMatchSchema(getRequestSchema('PUT', '/documents/{documentId}'));
        const updatedDocument = Object.assign(clone(fixtureDocument), update);
        scope.put(`/documents/${fixtureDocument.id}`, update).reply(200, updatedDocument);
        const updated = await parcel.updateDocument(fixtureDocument.id as DocumentId, update);
        expect(updated).toMatchPOD(updatedDocument);
      });

      nockIt('retrieved', async (scope) => {
        const update = {
          owner: createIdentityId(),
          details: { title: 'newtitle', tags: ['foo', 'bar'] },
        };
        const updatedDocument = Object.assign(clone(fixtureDocument), update);

        scope.put(`/documents/${fixtureDocument.id}`, update).reply(200, updatedDocument);
        scope.get(`/documents/${fixtureDocument.id}`).reply(200, fixtureDocument);

        const document = await parcel.getDocument(fixtureDocument.id as DocumentId);
        await document.update(update);
        expect(document).toMatchPOD(updatedDocument);
      });
    });

    describe('delete', () => {
      nockIt('by id', async (scope) => {
        scope.delete(`/documents/${fixtureDocument.id}`).reply(204);
        await parcel.deleteDocument(fixtureDocument.id as DocumentId);
      });

      nockIt('retrieved', async (scope) => {
        scope.get(`/documents/${fixtureDocument.id}`).reply(200, fixtureDocument);
        scope.delete(`/documents/${fixtureDocument.id}`).reply(204);
        const document = await parcel.getDocument(fixtureDocument.id as DocumentId);
        await document.delete();
      });

      nockIt('expect 204', async (scope) => {
        scope.delete(`/documents/${fixtureDocument.id}`).reply(200);
        await expect(parcel.deleteDocument(fixtureDocument.id as DocumentId)).rejects.toThrow();
      });
    });
  });

  describe('grant', () => {
    let fixtureGrant: PODGrant;

    beforeEach(() => {
      fixtureGrant = createPodGrant();
    });

    nockIt('create', async (scope) => {
      expect(fixtureGrant).toMatchSchema(getResponseSchema('POST', '/grants', 201));
      const createParams = {
        grantee: createIdentityId(),
        condition: fixtureGrant.condition,
      };
      expect(createParams).toMatchSchema(getRequestSchema('POST', '/grants'));
      scope.post('/grants', createParams).reply(201, fixtureGrant);
      const grant = await parcel.createGrant(createParams);
      const podGrant = { ...grant, capabilities: stringifyCaps(grant.capabilities) };
      expect(podGrant).toMatchPOD(fixtureGrant);
    });

    nockIt('get', async (scope) => {
      expect(fixtureGrant).toMatchSchema(getResponseSchema('GET', '/grants/{grantId}', 200));
      scope.get(`/grants/${fixtureGrant.id}`).reply(200, JSON.stringify(fixtureGrant));
      const grant = await parcel.getGrant(fixtureGrant.id as GrantId);
      const podGrant = { ...grant, capabilities: stringifyCaps(grant.capabilities) };
      expect(podGrant).toMatchPOD(fixtureGrant);
    });

    describe('list', () => {
      nockIt('no filter', async (scope) => {
        const numberResults = 3;
        const fixtureResultsPage: Page<PODGrant> = createResultsPage(numberResults, createPodGrant);
        expect(fixtureResultsPage).toMatchSchema(getResponseSchema('GET', '/grants', 200));

        scope.get('/grants').reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listGrants();
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) {
          const podResult = { ...r, capabilities: stringifyCaps(r.capabilities) };
          expect(podResult).toMatchPOD(fixtureResultsPage.results[i]);
        }

        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('with filter and pagination', async (scope) => {
        const numberResults = 1;
        const fixtureResultsPage: Page<PODGrant> = createResultsPage(numberResults, createPodGrant);
        const filterWithPagination = {
          grantee: createPodApp().id as AppId,
          pageSize: 2,
          pageToken: makeRandomId(),
        };
        expect(filterWithPagination).toMatchSchema(getQueryParametersSchema('GET', '/grants'));

        scope
          .get('/grants')
          .query(
            Object.fromEntries(
              Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
            ),
          )
          .reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listGrants(filterWithPagination);
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) {
          const podResult = { ...r, capabilities: stringifyCaps(r.capabilities) };
          expect(podResult).toMatchPOD(fixtureResultsPage.results[i]);
        }

        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });
    });

    describe('delete', () => {
      nockIt('by id', async (scope) => {
        scope.delete(`/grants/${fixtureGrant.id}`).reply(204);
        await parcel.deleteGrant(fixtureGrant.id as GrantId);
      });

      nockIt('retrieved', async (scope) => {
        scope.get(`/grants/${fixtureGrant.id}`).reply(200, fixtureGrant);
        scope.delete(`/grants/${fixtureGrant.id}`).reply(204);
        const grant = await parcel.getGrant(fixtureGrant.id as GrantId);
        await grant.delete();
      });

      nockIt('expect 204', async (scope) => {
        scope.delete(`/grants/${fixtureGrant.id}`).reply(200);
        await expect(parcel.deleteGrant(fixtureGrant.id as GrantId)).rejects.toThrow();
      });
    });
  });

  describe('app', () => {
    let fixtureApp: PODApp;
    let fixtureIdentity: PODIdentity;

    beforeEach(() => {
      fixtureApp = createPodApp();
      fixtureIdentity = createPodIdentity();
    });

    nockIt('create', async (scope) => {
      const createParams: any /* AppCreateParams & PODApp */ = {
        ...clone(fixtureApp),
        identity: {
          tokenVerifiers: [
            {
              sub: 'app',
              iss: 'auth.oasislabs.com',
              publicKey: API_PUBLIC_KEY,
            },
          ],
        },
      };
      delete createParams.id;
      delete createParams.createdAt;
      delete createParams.owner;
      delete createParams.collaborators;
      delete createParams.admins;
      delete createParams.participants;
      delete createParams.published;

      expect(createParams).toMatchSchema(getRequestSchema('POST', '/apps'));
      scope.post('/apps', createParams).reply(201, fixtureApp);
      expect(fixtureApp).toMatchSchema(getResponseSchema('POST', '/apps', 201));
      const app = await parcel.createApp(createParams);
      expect(app).toMatchPOD(fixtureApp);
    });

    nockIt('get', async (scope) => {
      expect(fixtureApp).toMatchSchema(getResponseSchema('GET', '/apps/{appId}', 200));
      scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
      const app = await parcel.getApp(fixtureApp.id as AppId);
      expect(app).toMatchPOD(fixtureApp);
    });

    describe('app identity', () => {
      nockIt('get', async (scope) => {
        scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
        scope.get(`/identities/${fixtureApp.id}`).reply(200, fixtureIdentity);

        const app = await parcel.getApp(fixtureApp.id as AppId);
        const appIdentity = await app.getIdentity();
        expect(appIdentity).toMatchPOD(fixtureIdentity);
      });

      nockIt('update', async (scope) => {
        const updatedIdentity = Object.assign(clone(fixtureIdentity), {
          tokenVerifiers: createPodIdentity().tokenVerifiers,
        });

        scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
        scope
          .put(`/identities/${fixtureApp.id}`, {
            tokenVerifiers: updatedIdentity.tokenVerifiers,
          })
          .reply(200, updatedIdentity);

        const app = await parcel.getApp(fixtureApp.id as AppId);
        const updatedAppIdentity = await app.updateIdentity({
          tokenVerifiers: updatedIdentity.tokenVerifiers,
        });
        expect(updatedAppIdentity).toMatchPOD(updatedIdentity);
      });
    });

    describe('list', () => {
      nockIt('no filter', async (scope) => {
        const numberResults = 3;
        const fixtureResultsPage: Page<PODApp> = createResultsPage(numberResults, createPodApp);
        expect(fixtureResultsPage).toMatchSchema(getResponseSchema('GET', '/apps', 200));

        scope.get('/apps').reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listApps();
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('with filter and pagination', async (scope) => {
        const numberResults = 1;
        const fixtureResultsPage: Page<PODApp> = createResultsPage(numberResults, createPodApp);

        const filterWithPagination = {
          creator: createIdentityId(),
          participation: 'invited' as const,
          pageSize: 2,
          pageToken: makeRandomId(),
        };
        expect(filterWithPagination).toMatchSchema(getQueryParametersSchema('GET', '/apps'));
        scope
          .get('/apps')
          .query(
            Object.fromEntries(
              Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
            ),
          )
          .reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listApps(filterWithPagination);
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('no results', async (scope) => {
        const fixtureResultsPage: Page<PODApp> = createResultsPage(0, createPodApp);
        scope.get('/apps').reply(200, fixtureResultsPage);
        const { results, nextPageToken } = await parcel.listApps();
        expect(results).toHaveLength(0);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });
    });

    describe('update', () => {
      let update: AppUpdateParams;
      let updatedApp: PODApp;

      beforeEach(() => {
        update = {
          owner: fixtureApp.owner as IdentityId,
          admins: fixtureApp.admins as IdentityId[],
          collaborators: fixtureApp.collaborators as IdentityId[],

          published: true,
          inviteOnly: true,
          invites: fixtureApp.invites as IdentityId[],
          allowUserUploads: true,

          name: 'new name',
          organization: 'new organization',
          shortDescription: 'new short description',
          homepageUrl: 'https://example.com',
          privacyPolicy: 'new privacy policy',
          termsAndConditions: 'new terms and condition',

          invitationText: 'new invitation text',
          acceptanceText: 'new acceptance text',
          rejectionText: 'new rejection text',

          extendedDescription: 'new extended description',
          brandingColor: '#feeded',
          category: 'updated category',
          logoUrl: 'https://example.com/logo.png',
        };
        updatedApp = Object.assign(clone(fixtureApp), update);
      });

      nockIt('by id', async (scope) => {
        scope.put(`/apps/${fixtureApp.id}`, update).reply(200, updatedApp);
        const updated = await parcel.updateApp(fixtureApp.id as AppId, update);
        expect(updated).toMatchPOD(updatedApp);
      });

      nockIt('retrieved', async (scope) => {
        scope.put(`/apps/${fixtureApp.id}`, update).reply(200, updatedApp);
        scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);

        const app = await parcel.getApp(fixtureApp.id as AppId);
        await app.update(update);
        expect(app).toMatchPOD(updatedApp);
      });
    });

    describe('delete', () => {
      nockIt('by id', async (scope) => {
        scope.delete(`/apps/${fixtureApp.id}`).reply(204);
        await parcel.deleteApp(fixtureApp.id as AppId);
      });

      nockIt('retrieved', async (scope) => {
        scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
        scope.delete(`/apps/${fixtureApp.id}`).reply(204);
        const app = await parcel.getApp(fixtureApp.id as AppId);
        await app.delete();
      });

      nockIt('expect 204', async (scope) => {
        scope.delete(`/apps/${fixtureApp.id}`).reply(200);
        await expect(parcel.deleteApp(fixtureApp.id as AppId)).rejects.toThrow();
      });
    });

    describe('permissions', () => {
      let fixtureApp: PODApp;
      let fixturePermission: PODPermission;
      let fixturePermissionsEndpoint: string;

      beforeEach(() => {
        fixtureApp = createPodApp();
        fixturePermission = createPodPermission();
        fixturePermissionsEndpoint = `/apps/${fixtureApp.id}/permissions`;
      });

      nockIt('create', async (scope) => {
        expect(fixturePermission).toMatchSchema(
          getResponseSchema('POST', '/apps/{appId}/permissions', 201),
        );

        const createParams: any = {
          ...fixturePermission,
        };
        delete createParams.id;
        delete createParams.appId;
        delete createParams.createdAt;

        expect(createParams).toMatchSchema(getRequestSchema('POST', '/apps/{appId}/permissions'));

        scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
        scope.post(fixturePermissionsEndpoint).reply(201, fixturePermission);

        const app = await parcel.getApp(fixtureApp.id as AppId);
        const permission = await app.createPermission(createParams);

        expect(permission).toMatchPOD(fixturePermission);
      });

      it('get', () => {
        expect(fixturePermission).toMatchSchema(
          getResponseSchema('GET', '/apps/{appId}/permissions/{permissionId}', 200),
        );
      });

      describe('delete', () => {
        nockIt('by id', async (scope) => {
          const permissionEp = `${fixturePermissionsEndpoint}/${fixturePermission.id}`;
          scope.delete(permissionEp).reply(204);
          await parcel.deletePermission(
            fixtureApp.id as AppId,
            fixturePermission.id as PermissionId,
          );
        });

        nockIt('retrieved', async (scope) => {
          const permissionEp = `${fixturePermissionsEndpoint}/${fixturePermission.id}`;
          scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
          scope.get(fixturePermissionsEndpoint).reply(200, { results: [fixturePermission] });
          scope.delete(permissionEp).reply(204);
          const app = await parcel.getApp(fixtureApp.id as AppId);
          const permissionsPage = await app.listPermissions();
          await app.deletePermission(permissionsPage.results[0].id);
        });

        nockIt('expect 204', async (scope) => {
          const permissionEp = `${fixturePermissionsEndpoint}/${fixturePermission.id}`;
          scope.get(`/apps/${fixtureApp.id}`).reply(200, fixtureApp);
          scope.delete(permissionEp).reply(200);
          const app = await parcel.getApp(fixtureApp.id as AppId);
          await expect(
            app.deletePermission(fixturePermission.id as PermissionId),
          ).rejects.toThrow();
        });
      });
    });

    describe('client', () => {
      let fixtureClient: PODClient;

      beforeEach(() => {
        fixtureClient = createPodClient({ appId: fixtureApp.id as AppId });
      });

      nockIt('create', async (scope) => {
        const createParams: ClientCreateParams = (() => {
          const { id, createdAt, creator, appId, ...createParams } = clone(fixtureClient);
          return createParams;
        })();

        expect(createParams).toMatchSchema(
          getRequestSchema(
            'POST',
            '/apps/{appId}/clients',
            true, // `allowAdditional` (anyOf)
          ),
        );
        scope.post(`/apps/${fixtureApp.id}/clients`, createParams).reply(201, fixtureClient);
        expect(fixtureClient).toMatchSchema(
          getResponseSchema(
            'POST',
            '/apps/{appId}/clients',
            201,
            undefined,
            true, // `allowAdditional` (anyOf)
          ),
        );
        const client = await parcel.createClient(fixtureApp.id as AppId, createParams);
        expect(client).toMatchPOD(fixtureClient);
      });

      nockIt('get', async (scope) => {
        expect(fixtureClient).toMatchSchema(
          getResponseSchema(
            'GET',
            '/apps/{appId}/clients/{clientId}',
            200,
            undefined,
            true, // `allowAdditional` (anyOf)
          ),
        );
        scope.get(`/apps/${fixtureApp.id}/clients/${fixtureClient.id}`).reply(200, fixtureClient);
        const client = await parcel.getClient(fixtureApp.id as AppId, fixtureClient.id as ClientId);
        expect(client).toMatchPOD(fixtureClient);
      });

      describe('list', () => {
        nockIt('no filter', async (scope) => {
          const numberResults = 3;
          const fixtureResultsPage: Page<PODClient> = createResultsPage(numberResults, () =>
            createPodClient({ appId: fixtureApp.id as AppId }),
          );
          expect(fixtureResultsPage).toMatchSchema(
            getResponseSchema('GET', '/apps/{appId}/clients', 200),
          );

          scope.get(`/apps/${fixtureApp.id}/clients`).reply(200, fixtureResultsPage);

          const { results, nextPageToken } = await parcel.listClients(fixtureApp.id as AppId);
          expect(results).toHaveLength(numberResults);
          for (const [i, r] of results.entries())
            expect(r).toMatchPOD(fixtureResultsPage.results[i]);
          expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
        });

        nockIt('with filter and pagination', async (scope) => {
          const numberResults = 1;
          const fixtureResultsPage: Page<PODClient> = createResultsPage(numberResults, () =>
            createPodClient({ appId: fixtureApp.id as AppId }),
          );

          const filterWithPagination = {
            creator: createIdentityId(),
            pageSize: 2,
            pageToken: makeRandomId(),
          };
          expect(filterWithPagination).toMatchSchema(
            getQueryParametersSchema('GET', '/apps/{appId}/clients'),
          );
          scope
            .get(`/apps/${fixtureApp.id}/clients`)
            .query(
              Object.fromEntries(
                Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
              ),
            )
            .reply(200, fixtureResultsPage);

          const { results, nextPageToken } = await parcel.listClients(
            fixtureApp.id as AppId,
            filterWithPagination,
          );
          expect(results).toHaveLength(numberResults);
          for (const [i, r] of results.entries())
            expect(r).toMatchPOD(fixtureResultsPage.results[i]);
          expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
        });

        nockIt('no results', async (scope) => {
          const fixtureResultsPage: Page<PODClient> = createResultsPage(0, createPodClient);
          scope.get(`/apps/${fixtureApp.id}/clients`).reply(200, fixtureResultsPage);
          const { results, nextPageToken } = await parcel.listClients(fixtureApp.id as AppId);
          expect(results).toHaveLength(0);
          expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
        });
      });

      describe('update', () => {
        let update: ClientUpdateParams;
        let updatedClient: PODClient;

        beforeEach(() => {
          update = {
            type: (fixtureClient as PODFrontendClient).type,
            redirectUris: [
              ...(fixtureClient as PODFrontendClient).redirectUris,
              'https://example.com/new-redirect',
            ],
            postLogoutRedirectUris: [],
            name: fixtureClient.name,
          };
          updatedClient = Object.assign(clone(fixtureClient), update);
        });

        nockIt('by id', async (scope) => {
          scope
            .put(`/apps/${fixtureApp.id}/clients/${fixtureClient.id}`, update)
            .reply(200, updatedClient);
          const updated = await parcel.updateClient(
            fixtureApp.id as AppId,
            fixtureClient.id as ClientId,
            update,
          );
          expect(updated).toMatchPOD(updatedClient);
        });
      });

      describe('delete', () => {
        nockIt('by id', async (scope) => {
          scope.delete(`/apps/${fixtureApp.id}/clients/${fixtureClient.id}`).reply(204);
          await parcel.deleteClient(fixtureApp.id as AppId, fixtureClient.id as ClientId);
        });

        nockIt('retrieved', async (scope) => {
          scope.get(`/apps/${fixtureApp.id}/clients/${fixtureClient.id}`).reply(200, fixtureClient);
          scope.delete(`/apps/${fixtureApp.id}/clients/${fixtureClient.id}`).reply(204);
          const client = await parcel.getClient(
            fixtureApp.id as AppId,
            fixtureClient.id as ClientId,
          );
          await client.delete();
        });

        nockIt('expect 204', async (scope) => {
          scope.delete(`/apps/${fixtureApp.id}/clients/${fixtureClient.id}`).reply(200);
          await expect(
            parcel.deleteClient(fixtureApp.id as AppId, fixtureClient.id as ClientId),
          ).rejects.toThrow();
        });
      });
    });
  });

  describe('compute', () => {
    nockIt('create', async (scope) => {
      const fixtureJob = createPodJob();
      expect(fixtureJob).toMatchSchema(getResponseSchema('POST', '/compute/jobs', 201));
      const createParams = createJobSpec();
      expect(createParams).toMatchSchema(getRequestSchema('POST', '/compute/jobs'));
      scope.post('/compute/jobs', createParams).reply(201, fixtureJob);
      const job = await parcel.submitJob(createParams);
      expect(job).toMatchPOD(fixtureJob);
    });

    describe('list', () => {
      nockIt('no filter', async (scope) => {
        const numberResults = 3;
        const fixtureResultsPage: Page<PODJob> = createResultsPage(numberResults, createPodJob);
        expect(fixtureResultsPage).toMatchSchema(getResponseSchema('GET', '/compute/jobs', 200));

        scope.get('/compute/jobs').reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listJobs();
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('with filter and pagination', async (scope) => {
        const numberResults = 1;
        const fixtureResultsPage: Page<PODJob> = createResultsPage(numberResults, createPodJob);

        const filterWithPagination = {
          submitter: createIdentityId(),
          pageSize: 2,
          pageToken: makeRandomId(),
        };
        expect(filterWithPagination).toMatchSchema(
          getQueryParametersSchema('GET', '/compute/jobs'),
        );
        scope
          .get('/compute/jobs')
          .query(
            Object.fromEntries(
              Object.entries(filterWithPagination).map(([k, v]) => [paramCase(k), v]),
            ),
          )
          .reply(200, fixtureResultsPage);

        const { results, nextPageToken } = await parcel.listJobs(filterWithPagination);
        expect(results).toHaveLength(numberResults);
        for (const [i, r] of results.entries()) expect(r).toMatchPOD(fixtureResultsPage.results[i]);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });

      nockIt('no results', async (scope) => {
        const fixtureResultsPage: Page<PODJob> = createResultsPage(0, createPodJob);
        scope.get('/compute/jobs').reply(200, fixtureResultsPage);
        const { results, nextPageToken } = await parcel.listJobs();
        expect(results).toHaveLength(0);
        expect(nextPageToken).toEqual(fixtureResultsPage.nextPageToken);
      });
    });

    nockIt('get', async (scope) => {
      const fixtureJob = createPodJob();
      expect(fixtureJob).toMatchSchema(getResponseSchema('GET', '/compute/jobs/{jobId}', 200));
      scope.get(`/compute/jobs/${fixtureJob.id}`).reply(200, JSON.stringify(fixtureJob));
      const job = await parcel.getJob(fixtureJob.id);
      expect(job).toMatchPOD(fixtureJob);
    });

    describe('delete', () => {
      nockIt('by id', async (scope) => {
        const jobId = createJobId();
        scope.delete(`/compute/jobs/${jobId}`).reply(204);
        await parcel.terminateJob(jobId);
      });

      nockIt('expect 204', async (scope) => {
        const jobId = createJobId();
        scope.delete(`/compute/jobs/${jobId}`).reply(200);
        await expect(parcel.terminateJob(jobId)).rejects.toThrow();
      });
    });
  });

  describe('usage', () => {
    nockIt('get', async (scope) => {
      const fixtureMeteringReport: PODMeteringReport = createPodMeteringReport();
      expect(fixtureMeteringReport).toMatchSchema(getResponseSchema('GET', '/usage', 200));

      scope.get('/usage').reply(200, fixtureMeteringReport);

      const meteringReport = await parcel.getUsage();
      expect(meteringReport).toEqual(fixtureMeteringReport);
    });
  });

  describe('quota', () => {
    let fixtureMeteringQuota: PODMeteringQuota;

    beforeEach(() => {
      fixtureMeteringQuota = createPodMeteringQuota();
    });

    nockIt('get', async (scope) => {
      expect(fixtureMeteringQuota).toMatchSchema(getResponseSchema('GET', '/quota', 200));
      scope.get('/quota').reply(200, fixtureMeteringQuota);
      const meteringQuota = await parcel.getQuota();
      expect(meteringQuota).toEqual(fixtureMeteringQuota);
    });

    nockIt('update', async (scope) => {
      expect(fixtureMeteringQuota).toMatchSchema(getResponseSchema('PUT', '/quota', 200));
      const update = {
        apiCallsLimit: 10_000,
        accessedBytesLimit: 1000,
        computeMsecLimit: 10_000,
      };
      const updatedMeteringQuota = Object.assign(clone(fixtureMeteringQuota), update);
      scope.put(`/quota`, update).reply(200, updatedMeteringQuota);
      const meteringQuota = await parcel.setQuota(updatedMeteringQuota);
      expect(meteringQuota).toEqual(update);
    });
  });
});
