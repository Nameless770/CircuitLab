import { Clock } from "@circuitlab/api";

/** A clock the tests move by hand: the app's 30 days pass in a millisecond. */
export class FakeClock extends Clock {
  private time: number;

  constructor(start: Date = new Date()) {
    super();
    this.time = start.getTime();
  }

  now(): Date {
    return new Date(this.time);
  }

  advance(milliseconds: number): void {
    this.time += milliseconds;
  }
}

export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;
