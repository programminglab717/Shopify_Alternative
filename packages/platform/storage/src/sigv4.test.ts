import { describe, expect, it } from 'vitest';
import { EMPTY_PAYLOAD_SHA256, presignUrl, signRequest, uriEncode } from './sigv4.js';

// AWS's own examples for S3, from "Authenticating Requests (AWS Signature Version 4)".
const AWS = {
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
  region: 'us-east-1',
  date: new Date('2013-05-24T00:00:00Z'),
};

describe('Signature Version 4', () => {
  it('signs a URL in its query, as AWS signs its example', () => {
    const url = presignUrl('GET', new URL('https://examplebucket.s3.amazonaws.com/test.txt'), {
      ...AWS,
      expiresIn: 86_400,
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('signs a request in its headers, as AWS signs its examples', () => {
    const range = signRequest(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      { range: 'bytes=0-9' },
      EMPTY_PAYLOAD_SHA256,
      AWS,
    );
    expect(range).toEqual({
      'x-amz-date': '20130524T000000Z',
      'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    });
    // Its query sorted, as listing a bucket's objects shows.
    const list = signRequest(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      {},
      EMPTY_PAYLOAD_SHA256,
      AWS,
    );
    expect(list.authorization).toContain(
      'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('encodes as RFC 3986 does, keeping slashes in paths', () => {
    expect(uriEncode("a b+c!'()*~._-/é")).toBe('a%20b%2Bc%21%27%28%29%2A~._-%2F%C3%A9');
    expect(uriEncode('shops/a b/c.jpg', true)).toBe('shops/a%20b/c.jpg');
  });
});
