#!/usr/bin/env python3
"""Expected truck delivery / pickup dates (specs/shipping.md) for the moment of the test run.

Usage:
  python3 delivery.py                       # uses the current Europe/Berlin time
  python3 delivery.py 2026-10-02T17:30      # explicit Berlin wall-clock time
  python3 delivery.py --holidays 2026 2028  # print the Berlin public-holiday table

Rule (shipping.md): truck deliveries run Monday-Friday, never on Saturdays, Sundays or Berlin public
holidays ("delivery days"). Ordered by 18:00 (inclusive) -> earliest date is the first delivery day after
today; ordered after 18:00 -> the delivery day after that. Latest selectable date: today + 14 calendar days.
Pickup: Monday-Saturday except Berlin public holidays, from the next day up to 14 days ahead.
"""
import sys
import datetime as dt


def easter(y):
    a = y % 19; b = y // 100; c = y % 100; d = b // 4; e = b % 4
    f = (b + 8) // 25; g = (b - f + 1) // 3; h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4; l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31; day = ((h + l - 7 * m + 114) % 31) + 1
    return dt.date(y, month, day)


def berlin_holidays(y):
    e = easter(y)
    return {
        dt.date(y, 1, 1): "New Year's Day",
        dt.date(y, 3, 8): "International Women's Day (Berlin)",
        e - dt.timedelta(days=2): "Good Friday",
        e + dt.timedelta(days=1): "Easter Monday",
        dt.date(y, 5, 1): "Labour Day",
        e + dt.timedelta(days=39): "Ascension Day",
        e + dt.timedelta(days=50): "Whit Monday",
        dt.date(y, 10, 3): "German Unity Day",
        dt.date(y, 12, 25): "Christmas Day",
        dt.date(y, 12, 26): "Second Day of Christmas",
    }


def is_delivery_day(d):
    return d.weekday() < 5 and d not in berlin_holidays(d.year)


def delivery_days_after(d, n):
    out, cur = [], d
    while len(out) < n:
        cur += dt.timedelta(days=1)
        if is_delivery_day(cur):
            out.append(cur)
    return out


def expected(now):
    today = now.date()
    after_cutoff = now.time() > dt.time(18, 0)
    first, second = delivery_days_after(today, 2)
    earliest = second if after_cutoff else first
    limit = today + dt.timedelta(days=14)
    latest = limit
    while not is_delivery_day(latest):
        latest -= dt.timedelta(days=1)
    return dict(today=today, after_cutoff=after_cutoff, earliest=earliest, latest=latest, limit=limit,
                first_weekend=next(today + dt.timedelta(days=i) for i in range(1, 8)
                                   if (today + dt.timedelta(days=i)).weekday() == 5),
                pickup_saturday=next(today + dt.timedelta(days=i) for i in range(1, 15)
                                     if (today + dt.timedelta(days=i)).weekday() == 5
                                     and today + dt.timedelta(days=i) not in berlin_holidays((today + dt.timedelta(days=i)).year)),
                holidays_in_window=[(d, n) for y in {today.year, limit.year}
                                    for d, n in sorted(berlin_holidays(y).items()) if today < d <= limit])


def berlin_now():
    try:
        from zoneinfo import ZoneInfo
        return dt.datetime.now(ZoneInfo("Europe/Berlin")).replace(tzinfo=None)
    except Exception:  # pragma: no cover
        return dt.datetime.now()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--holidays":
        a, b = int(sys.argv[2]), int(sys.argv[3])
        for y in range(a, b + 1):
            for d, n in sorted(berlin_holidays(y).items()):
                print(d.isoformat(), d.strftime("%a"), n)
        sys.exit(0)
    now = dt.datetime.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else berlin_now()
    r = expected(now)
    print(f"Berlin time:            {now:%Y-%m-%d %a %H:%M}")
    print(f"after 18:00 cut-off:    {r['after_cutoff']}")
    print(f"earliest truck date:    {r['earliest']:%Y-%m-%d %a}")
    print(f"latest truck date:      {r['latest']:%Y-%m-%d %a}  (today + 14 = {r['limit']:%Y-%m-%d %a})")
    print(f"next Saturday:          {r['first_weekend']:%Y-%m-%d}  (no truck delivery)")
    print(f"first pickup Saturday:  {r['pickup_saturday']:%Y-%m-%d}  (first Saturday after today that is not a Berlin public holiday)")
    print(f"next Sunday:            {r['first_weekend'] + dt.timedelta(days=1):%Y-%m-%d}  (no truck, no pickup)")
    for d, n in r["holidays_in_window"]:
        print(f"holiday in window:      {d:%Y-%m-%d %a} {n}")
