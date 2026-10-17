const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "20:40", the way the band and the lists name a moment. */
export const clockTime = (at: string | number | Date) => clock.format(new Date(at));
export const weekdayName = (at: string | number | Date) => new Date(at).toLocaleDateString(undefined, { weekday: 'long' });
