/**
 * Where the app gets the current time. The services whose rules depend on time (sessions expire
 * after 30 days, failed sign-ins are forgotten after 15 minutes, simulations are timed) receive a
 * Clock instead of asking `Date` themselves: dependency injection, for time. A test then sets the
 * time instead of waiting 30 days.
 *
 * An abstract class rather than an interface, because Nest needs a runtime value as the
 * injection token.
 */
export abstract class Clock {
  abstract now(): Date;
}

/** The real time. */
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
