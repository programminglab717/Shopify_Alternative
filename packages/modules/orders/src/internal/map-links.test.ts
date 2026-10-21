import { describe, expect, it, vi } from 'vitest';
import { pointInText, pointOfMapLink } from './map-links.js';

const KARACHI = { latitude: 24.860735, longitude: 67.001137 };

describe("A pin from a map's link (ADR-718)", () => {
  it('reads the place a Google Maps link or typed coordinates name, the most precise first', () => {
    expect(
      pointInText(
        'https://www.google.com/maps/place/Jamia+Masjid/@24.8601,67.0002,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d24.860735!4d67.001137',
      ),
    ).toEqual(KARACHI);
    expect(
      pointInText('https://www.google.com/maps/search/?api=1&query=24.860735,67.001137'),
    ).toEqual(KARACHI);
    expect(pointInText('https://maps.google.com/?q=24.860735%2C67.001137')).toEqual(KARACHI);
    expect(pointInText('https://www.google.com/maps/@24.860735,67.001137,15z')).toEqual(KARACHI);
    expect(pointInText(' 24.860735, 67.001137 ')).toEqual(KARACHI);
    expect(pointInText('24.860735 67.001137')).toEqual(KARACHI);
    // Nothing of a place: none.
    expect(pointInText('House 12, Street 4')).toBeNull();
    expect(pointInText('https://maps.app.goo.gl/AbCdEf123')).toBeNull();
    expect(pointInText('124.8, 67.0')).toBeNull();
  });

  it("follows Google Maps' short links to where they lead, on Google's short hosts alone", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url) === 'https://maps.app.goo.gl/AbCdEf123'
        ? new Response(null, {
            status: 302,
            headers: {
              location: 'https://www.google.com/maps/place/x/data=!3d24.860735!4d67.001137',
            },
          })
        : new Response(null, { status: 404 }),
    );
    expect(await pointOfMapLink('https://maps.app.goo.gl/AbCdEf123', fetcher)).toEqual(KARACHI);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    // A link that names its place is not followed; one off Google's short hosts, or plain
    // http, is never fetched.
    fetcher.mockClear();
    expect(await pointOfMapLink('24.860735,67.001137', fetcher)).toEqual(KARACHI);
    expect(await pointOfMapLink('https://example.com/AbCdEf123', fetcher)).toBeNull();
    expect(await pointOfMapLink('http://maps.app.goo.gl/AbCdEf123', fetcher)).toBeNull();
    expect(await pointOfMapLink('', fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    // Leading nowhere, or failing: none.
    expect(await pointOfMapLink('https://maps.app.goo.gl/Gone', fetcher)).toBeNull();
    const failing = vi.fn<typeof fetch>(async () => {
      throw new Error('timed out');
    });
    expect(await pointOfMapLink('https://maps.app.goo.gl/AbCdEf123', failing)).toBeNull();
  });
});
