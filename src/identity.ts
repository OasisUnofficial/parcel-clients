import type { Merge, Opaque, SetOptional } from 'type-fest';

import type { AppId } from './app.js';
import type { PODGrant } from './grant.js';
import { Grant } from './grant.js';
import type { HttpClient } from './http.js';
import type { Model, Page, PageParams, PODModel, ResourceId, Writable } from './model.js';
import { Permission } from './permission.js';
import type { PermissionId, PODPermission } from './permission.js';
import type { IdentityTokenClaims, PublicJWK } from './token.js';

export type IdentityId = Opaque<ResourceId, 'IdentityId' | 'AppId'>;

export type PODIdentity = Readonly<
  PODModel & {
    tokenVerifiers: IdentityTokenVerifier[];
  }
>;

const IDENTITIES_EP = 'identities';
const IDENTITIES_ME = `${IDENTITIES_EP}/me`;
const endpointForId = (id: IdentityId) => `${IDENTITIES_EP}/${id}`;
const endpointForPermissions = (id: IdentityId) => `${endpointForId(id)}/permissions`;
const endpointForPermission = (identityId: IdentityId, permissionId: PermissionId) =>
  `${endpointForPermissions(identityId)}/${permissionId}`;

export class Identity implements Model {
  public readonly id: IdentityId;
  public readonly createdAt: Date;
  public readonly tokenVerifiers: IdentityTokenVerifier[];

  #client: HttpClient;

  public constructor(client: HttpClient, pod: PODIdentity) {
    this.#client = client;
    this.id = pod.id as IdentityId;
    this.createdAt = new Date(pod.createdAt);
    this.tokenVerifiers = pod.tokenVerifiers;
  }

  public async update(params: IdentityUpdateParams): Promise<Identity> {
    Object.assign(this, await IdentityImpl.update(this.#client, this.id, params));
    return this;
  }

  public async delete(): Promise<void> {
    return IdentityImpl.delete_(this.#client, this.id);
  }

  public async grantPermission(id: PermissionId): Promise<GrantedPermission> {
    return IdentityImpl.grantPermission(this.#client, this.id, id);
  }

  /** Fetches permissions to which this identity has agreed.  */
  public async listGrantedPermissions(
    filter?: ListGrantedPermissionsFilter & PageParams,
  ): Promise<Page<Permission>> {
    return IdentityImpl.listGrantedPermissions(this.#client, this.id, filter);
  }

  /** * Gets a granted permission by id. Useful for checking if a permission has been granted. */
  public async getGrantedPermission(id: PermissionId): Promise<Permission> {
    return IdentityImpl.getGrantedPermission(this.#client, this.id, id);
  }

  public async revokePermission(id: PermissionId): Promise<void> {
    return IdentityImpl.revokePermission(this.#client, this.id, id);
  }
}

export namespace IdentityImpl {
  export async function create(
    client: HttpClient,
    params: IdentityCreateParams,
  ): Promise<Identity> {
    const podIdentity = await client.create<PODIdentity>(IDENTITIES_EP, params);
    return new Identity(client, podIdentity);
  }

  export async function current(client: HttpClient): Promise<Identity> {
    const podIdentity = await client.get<PODIdentity>(IDENTITIES_ME);
    return new Identity(client, podIdentity);
  }

  export async function get(client: HttpClient, id: IdentityId): Promise<Identity> {
    const podIdentity = await client.get<PODIdentity>(endpointForId(id));
    return new Identity(client, podIdentity);
  }

  export async function update(
    client: HttpClient,
    id: IdentityId,
    params: IdentityUpdateParams,
  ): Promise<Identity> {
    const podIdentity = await client.update<PODIdentity>(endpointForId(id), params);
    return new Identity(client, podIdentity);
  }

  export async function delete_(client: HttpClient, id: IdentityId): Promise<void> {
    return client.delete(endpointForId(id));
  }

  /** Grants permission to an app. */
  export async function grantPermission(
    client: HttpClient,
    identityId: IdentityId,
    permissionId: PermissionId,
  ): Promise<GrantedPermission> {
    const { grants } = await client.create<PODGrantedPermission>(
      endpointForPermission(identityId, permissionId),
      {},
    );
    return {
      grants: grants.map((g) => new Grant(client, g)),
    };
  }

  export async function listGrantedPermissions(
    client: HttpClient,
    identityId: IdentityId,
    filter?: ListGrantedPermissionsFilter & PageParams,
  ): Promise<Page<Permission>> {
    const podPage = await client.get<Page<PODPermission>>(
      endpointForPermissions(identityId),
      filter,
    );
    const results = podPage.results.map((podPermission) => new Permission(client, podPermission));
    return {
      results,
      nextPageToken: podPage.nextPageToken,
    };
  }

  export async function getGrantedPermission(
    client: HttpClient,
    identityId: IdentityId,
    permissionId: PermissionId,
  ): Promise<Permission> {
    const podPermission = await client.get<PODPermission>(
      endpointForPermission(identityId, permissionId),
    );
    return new Permission(client, podPermission);
  }

  export async function revokePermission(
    client: HttpClient,
    identityId: IdentityId,
    permissionId: PermissionId,
  ): Promise<void> {
    await client.delete(endpointForPermission(identityId, permissionId));
  }
}

export type IdentityCreateParams = Merge<
  IdentityUpdateParams,
  {
    tokenVerifiers: IdentityTokenVerifierCreate[];
  }
>;
export type IdentityUpdateParams = Writable<Identity>;

export type IdentityTokenVerifier = IdentityTokenClaims & {
  publicKey: PublicJWK;
};

export type IdentityTokenVerifierCreate = SetOptional<IdentityTokenVerifier, 'sub' | 'iss'>;

export type ListGrantedPermissionsFilter = Partial<{
  /** Only return permissions granted to this app. */
  app: AppId;
}>;

type PODGrantedPermission = {
  grants: PODGrant[];
};

/** The outcome of granting a permission to an app. */
export type GrantedPermission = {
  /** The actual grants created as a result of accepting the permission. */
  grants: Grant[];
};
