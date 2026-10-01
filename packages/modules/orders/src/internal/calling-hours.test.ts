import { describe, expect, it } from 'vitest';
import {
  callingMinutesBefore,
  callingTimeFrom,
  clockOf,
  isCallingTime,
  minutesOfClock,
  type CallingWindow,
} from './calling-hours.js';

/** 10:00 to 21:00 in Karachi, on the first three days of October. */
const WINDOWS: CallingWindow[] = [1, 2, 3].map((day) => ({
  opens: new Date(`2026-10-0${day}T10:00:00+05:00`),
  closes: new Date(`2026-10-0${day}T21:00:00+05:00`),
}));

const at = (time: string) => new Date(`2026-10-${time}+05:00`);

describe('Calling hours', () => {
  it('reads and writes the clocks staff give', () => {
    expect(['10:00', '9:30', ' 21:15 ', '24:00', '00:00'].map(minutesOfClock)).toEqual([
      600, 570, 1275, 1440, 0,
    ]);
    expect(['24:01', '25:00', '10', '10:60', 'ten', ''].map(minutesOfClock)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect([0, 570, 1440].map(clockOf)).toEqual(['00:00', '09:30', '24:00']);
  });

  it('says whether it is calling time, and when it next is', () => {
    expect(isCallingTime(WINDOWS, at('02T10:00:00'))).toBe(true);
    expect(isCallingTime(WINDOWS, at('02T20:59:59'))).toBe(true);
    expect(isCallingTime(WINDOWS, at('02T21:00:00'))).toBe(false);
    expect(isCallingTime(WINDOWS, at('02T09:59:59'))).toBe(false);
    expect(callingTimeFrom(WINDOWS, at('02T15:00:00'))).toEqual(at('02T15:00:00'));
    expect(callingTimeFrom(WINDOWS, at('02T22:30:00'))).toEqual(at('03T10:00:00'));
    expect(callingTimeFrom(WINDOWS, at('02T08:00:00'))).toEqual(at('02T10:00:00'));
    expect(callingTimeFrom(WINDOWS, at('03T21:30:00'))).toBeNull();
  });

  it('counts back through calling hours alone', () => {
    // Within the day, then over the night: 15 minutes this morning and 15 last evening.
    expect(callingMinutesBefore(WINDOWS, at('03T12:00:00'), 30)).toEqual(at('03T11:30:00'));
    expect(callingMinutesBefore(WINDOWS, at('03T10:15:00'), 30)).toEqual(at('02T20:45:00'));
    // From the night, the evening before; and a whole day back.
    expect(callingMinutesBefore(WINDOWS, at('03T02:00:00'), 60)).toEqual(at('02T20:00:00'));
    expect(callingMinutesBefore(WINDOWS, at('03T10:00:00'), 660)).toEqual(at('02T10:00:00'));
    // Past the windows, before the earliest.
    expect(callingMinutesBefore(WINDOWS, at('01T11:00:00'), 120).getTime()).toBeLessThan(
      at('01T10:00:00').getTime(),
    );
  });
});
