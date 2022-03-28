import fs from 'fs';

import nock from 'nock';
import tempy from 'tempy';

import type { default as Parcel, DocumentId } from '@oasislabs/parcel';

import { makeParcel, parcelNock, STORAGE_URL } from './helpers';

describe('node-specific', () => {
  let parcel: Parcel;

  beforeEach(() => {
    parcel = makeParcel();
  });

  afterAll(() => {
    nock.restore(); // https://github.com/nock/nock#memory-issues-with-jest
  });

  const fixtureData = 'fixture data';
  const MULTIPART_DATA_RE =
    /content-disposition: form-data; name="data".*\r\ncontent-type: application\/octet-stream\r\n\r\nfixture data\r\n/gi;

  it('upload ReadStream', async () => {
    const scope = parcelNock(STORAGE_URL)
      .post('', MULTIPART_DATA_RE)
      .matchHeader('content-type', /^multipart\/form-data; boundary=/)
      .reply(201, {});
    await tempy.write.task(fixtureData, async (dataPath) => {
      const readStream = fs.createReadStream(dataPath);
      await parcel.uploadDocument(readStream, null /* params */).finished;
    });
    scope.done();
  });

  it('pipeTo WriteStream', async () => {
    const documentId = 'Dblahblahblah' as DocumentId;
    const scope = parcelNock(STORAGE_URL).get(`/${documentId}/download`).reply(200, fixtureData);
    const download = parcel.downloadDocument(documentId);
    await tempy.file.task(async (dataPath) => {
      const writeStream = fs.createWriteStream(dataPath);
      await download.pipeTo(writeStream);
      expect((await fs.promises.readFile(dataPath)).toString()).toEqual(fixtureData);
    });
    scope.done();
  });
});
