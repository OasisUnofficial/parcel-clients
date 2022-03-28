/// <reference types="../fixtures/types" />
/* eslint-disable promise/prefer-await-to-then */ // These `thens` aren't Promises.

// @ts-check
const API_MOUNT_POINT = `/parcel/v1`;
const STORAGE_MOUNT_POINT = `/v1/parcel`;
const API_URL = `https://api.oasislabs.example.com${API_MOUNT_POINT}`;
const STORAGE_URL = `https://storage.oasislabs.example.com${STORAGE_MOUNT_POINT}`;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-requested-with',
};

context('Download', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  afterEach(() => {
    cy.clearCookies();
  });

  it('roundtrip', () => {
    const mockDocumentId =
      /** @type { import('../../../src').DocumentId } */
      ('DLPfSu1yGKGpxbD9RAnKEtk');
    const mockData = Buffer.alloc(1024 * 1024 * 2).fill(34);

    const downloadUrl = `${STORAGE_URL}/${mockDocumentId}/download`;
    cy.intercept('GET', downloadUrl, (req) => {
      req.reply(mockData.toString('base64'), CORS_HEADERS);
    });
    cy.intercept('OPTIONS', downloadUrl, {
      headers: CORS_HEADERS,
    });
    cy.window()
      .then(async (window) => {
        const parcel = new window.Parcel('fake api token', {
          apiUrl: API_URL,
          storageUrl: STORAGE_URL,
        });
        const download = parcel.downloadDocument(mockDocumentId);
        return (async () => {
          const bufs = [];
          for await (const chunk of download) {
            bufs.push(Buffer.from(chunk));
          }

          return Buffer.concat(bufs).toString();
        })();
      })
      .should('equal', mockData.toString('base64'));
  });

  it('not found', () => {
    const bogusDocumentId = 'totally-bogus-document-id';
    const downloadUrl = `${STORAGE_URL}/${bogusDocumentId}/download`;
    cy.intercept('GET', downloadUrl, (req) => {
      req.reply(404, { error: 'not found' }, CORS_HEADERS);
    });
    cy.intercept('OPTIONS', downloadUrl, {
      headers: CORS_HEADERS,
    });
    cy.window().then(async (window) => {
      const parcel = new window.Parcel('fake api token', { apiUrl: API_URL });
      const downloadChunks = parcel.downloadDocument(bogusDocumentId)[Symbol.asyncIterator]();
      downloadChunks
        .next()
        .then(() => {
          throw new Error('expected error');
        })
        .catch(() => {});
    });
  });
});

context('Redirect', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('redirects', () => {
    const mockIdentityId =
      /** @type { import('../../../src').IdentityId } */
      ('IPoxXkdvFsrqzDdU7h3QqSs');

    const redirectingUrl = `${API_MOUNT_POINT}/identities/me`;
    const redirectedUrl = `${API_MOUNT_POINT}/identities/${mockIdentityId}`;
    cy.intercept(
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer fake api token',
        },
        pathname: redirectedUrl,
      },
      {
        statusCode: 200,
        body: { id: mockIdentityId },
        headers: CORS_HEADERS,
      },
    );
    cy.intercept('OPTIONS', redirectedUrl, {
      headers: CORS_HEADERS,
    });
    cy.intercept(
      {
        method: 'GET',
        headers: {
          authorization: 'Bearer fake api token',
        },
        pathname: redirectingUrl,
      },
      {
        statusCode: 307,
        headers: {
          location: redirectedUrl,
          ...CORS_HEADERS,
        },
      },
    );
    cy.intercept('OPTIONS', redirectingUrl, {
      headers: CORS_HEADERS,
    });
    cy.window()
      .then(async (window) => {
        const parcel = new window.Parcel('fake api token', { apiUrl: API_URL });
        return parcel.getCurrentIdentity().then((identity) => identity.id);
      })
      .should('equal', mockIdentityId);
  });
});
