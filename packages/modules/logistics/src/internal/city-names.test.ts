import { describe, expect, it } from 'vitest';
import { CITY_SUGGESTIONS, cityKey, courierNameOf, nearestCityNames } from './city-names.js';

/** A courier's list of cities, written its own way. */
const LISTED = [
  'LAHORE',
  'Rawalpindi',
  'D.G. Khan',
  'Gujranwala',
  'Gujrat',
  'Gujar Khan',
  'Lyallpur',
  'Islamabad',
];

describe("Couriers' names for cities (ADR-233)", () => {
  it('keys a name by its letters and digits, in lower case, Urdu included', () => {
    expect(cityKey(' D.G. Khan ')).toBe('dgkhan');
    expect(cityKey('Dera Ghazi-Khan')).toBe('deraghazikhan');
    expect(cityKey('Sector G-11/2')).toBe('sectorg112');
    expect(cityKey('راولپنڈی')).toBe('راولپنڈی');
    expect(cityKey(' -. ')).toBe('');
  });

  it("finds the courier's name for a city: as written, or by Pakistan's name for it and its others", () => {
    expect(courierNameOf(' lahore ', LISTED)).toBe('LAHORE');
    expect(courierNameOf('Pindi', LISTED)).toBe('Rawalpindi');
    expect(courierNameOf('RWP', LISTED)).toBe('Rawalpindi');
    expect(courierNameOf('Dera Ghazi Khan', LISTED)).toBe('D.G. Khan');
    // Its old name, where the courier keeps that.
    expect(courierNameOf('Faisalabad', LISTED)).toBe('Lyallpur');
    expect(courierNameOf('راولپنڈی', LISTED)).toBe('Rawalpindi');
    expect(courierNameOf('Sukkur', LISTED)).toBeNull();
    expect(courierNameOf('Lahor', LISTED)).toBeNull();
    expect(courierNameOf('', LISTED)).toBeNull();
  });

  it("suggests the courier's nearest names: those it begins, then those a few letters off", () => {
    expect(nearestCityNames('Gujran', LISTED)).toEqual(['Gujranwala', 'Gujrat']);
    expect(nearestCityNames('Lahor', LISTED)).toEqual(['LAHORE']);
    expect(nearestCityNames('Rawalpndi', LISTED)).toEqual(['Rawalpindi']);
    expect(nearestCityNames('Gujrawala', LISTED)).toEqual(['Gujranwala']);
    // Nothing near, and nothing asked.
    expect(nearestCityNames('Sukkur', LISTED)).toEqual([]);
    expect(nearestCityNames(' ', LISTED)).toEqual([]);
    // A few at most, each once.
    const many = Array.from({ length: 9 }, (_, at) => `Kot ${String.fromCharCode(65 + at)}`);
    expect(nearestCityNames('Kot', [...many, 'KOT A'])).toHaveLength(CITY_SUGGESTIONS);
    expect(nearestCityNames('Kot', ['Kot A', 'KOT A', 'Kot-A'])).toEqual(['Kot A']);
  });
});
