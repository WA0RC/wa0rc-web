#!/usr/bin/env python3
"""
Process club events YAML files:
  1. Move past events from events-upcoming.yml to events-past.yml
  2. Inject an events card into index.html between marker comments
"""

import yaml
import sys
from html import escape
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


def load_events(path: Path) -> list:
    """Load events list from a YAML file."""
    if not path.exists():
        return []
    with open(path, "r") as f:
        data = yaml.safe_load(f)
    if data is None or "events" not in data or data["events"] is None:
        return []
    return data["events"]


MAINTENANCE_DATETIME_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d")
CENTRAL_STANDARD_TIME = timezone(timedelta(hours=-6))


def parse_maintenance_datetime(value: str) -> datetime:
    """Parse a maintenance datetime as Central Standard Time without DST."""
    for date_format in MAINTENANCE_DATETIME_FORMATS:
        try:
            parsed = datetime.strptime(str(value), date_format)
            if date_format == "%Y-%m-%d":
                parsed = parsed.replace(hour=0, minute=1)
            return parsed
        except ValueError:
            continue
    raise ValueError(f"Invalid maintenance datetime: {value}")


def maintenance_start(entry: dict) -> datetime:
    return parse_maintenance_datetime(entry["start-datetime"])


def maintenance_end(entry: dict) -> datetime:
    if not entry.get("stop-datetime"):
        return datetime.max
    return parse_maintenance_datetime(entry["stop-datetime"])


def format_maintenance_datetime(value: str) -> str:
    parsed = parse_maintenance_datetime(value)
    if parsed.hour == 0 and parsed.minute == 1:
        return parsed.strftime("%b %-d, %Y")
    return parsed.strftime("%b %-d, %Y %I:%M %p")


def save_events(path: Path, events: list, header_comment: str) -> None:
    """Save events list to a YAML file with a header comment."""
    with open(path, "w") as f:
        f.write(header_comment)
        if not events:
            f.write("\nevents: []\n")
        else:
            f.write("\nevents:\n")
            for ev in events:
                f.write(f'  - name: "{ev["name"]}"\n')
                f.write(f'    date: "{ev["date"]}"\n')
                if ev.get("end_date"):
                    f.write(f'    end_date: "{ev["end_date"]}"\n')
                if ev.get("url"):
                    f.write(f'    url: "{ev["url"]}"\n')
                if ev.get("location"):
                    f.write(f'    location: "{ev["location"]}"\n')
                f.write("\n")


def event_sort_date(ev: dict) -> date:
    """Return the effective date for sorting (end_date if present, else date)."""
    d = ev.get("end_date", ev["date"])
    if isinstance(d, date) and not isinstance(d, datetime):
        return d
    return datetime.strptime(str(d), "%Y-%m-%d").date()


def event_start_date(ev: dict) -> date:
    """Return the start date of the event."""
    d = ev["date"]
    if isinstance(d, date) and not isinstance(d, datetime):
        return d
    return datetime.strptime(str(d), "%Y-%m-%d").date()


def format_date_display(ev: dict) -> str:
    """Format event date(s) for display."""
    start = event_start_date(ev)
    start_str = start.strftime("%b %d, %Y")
    if ev.get("end_date"):
        end = event_sort_date(ev)
        if start.month == end.month and start.year == end.year:
            return f"{start.strftime('%b')} {start.day}-{end.day}, {start.year}"
        else:
            return f"{start_str} - {end.strftime('%b %d, %Y')}"
    return start_str


def move_past_events(upcoming_path: Path, past_path: Path, today: date) -> None:
    """Move events whose end date has passed from upcoming to past."""
    upcoming = load_events(upcoming_path)
    past = load_events(past_path)

    still_upcoming = []
    newly_past = []

    for ev in upcoming:
        effective_end = event_sort_date(ev)
        if effective_end < today:
            newly_past.append(ev)
        else:
            still_upcoming.append(ev)

    past.extend(newly_past)

    # Always sort: upcoming soonest first, past most recent first
    still_upcoming.sort(key=event_start_date)
    past.sort(key=event_sort_date, reverse=True)

    upcoming_header = (
        "# Upcoming club events (soonest first)\n"
        "# Format:\n"
        '#   - name: "Event Name"\n'
        '#     date: "YYYY-MM-DD"              # single-day event\n'
        '#     end_date: "YYYY-MM-DD"          # optional, for multi-day events\n'
        '#     url: "https://..."              # optional, link for more info\n'
        '#     location: "Place Name"          # optional, where the event is held\n'
        "#\n"
        "# Events are automatically moved to events-past.yml after their date\n"
        "# (or end_date for multi-day events) has passed.\n"
    )
    past_header = (
        "# Past club events (newest first)\n"
        "# Events are automatically moved here from events-upcoming.yml\n"
        "# after their date (or end_date) has passed.\n"
    )

    save_events(upcoming_path, still_upcoming, upcoming_header)
    save_events(past_path, past, past_header)

    if newly_past:
        moved_names = [e["name"] for e in newly_past]
        print(f"Moved {len(newly_past)} event(s) to past: {', '.join(moved_names)}")
    else:
        print("No events to move. Sorted both files.")


def format_event_item(ev: dict) -> list:
    """Build HTML lines for a single event list item."""
    date_str = format_date_display(ev)
    if ev.get("url"):
        name_html = f'<a href="{ev["url"]}" target="_blank" rel="noopener">{ev["name"]}</a>'
    else:
        name_html = ev["name"]

    lines = []
    lines.append('          <li class="event-item">')
    lines.append(f'            <span class="event-date">{date_str}</span>')
    detail = f'<span class="event-name">{name_html}</span>'
    if ev.get("location"):
        detail += f'<span class="event-location">{ev["location"]}</span>'
    lines.append(f'            <span class="event-detail">{detail}</span>')
    lines.append('          </li>')
    return lines


def build_events_html(upcoming_path: Path, past_path: Path) -> str:
    """Build the HTML for the events card matching the card-grid design."""
    upcoming = load_events(upcoming_path)
    past = load_events(past_path)

    upcoming.sort(key=event_start_date)
    past.sort(key=event_sort_date, reverse=True)

    lines = []
    lines.append('      <div class="card card-full">')
    lines.append('        <div class="card-label">')
    lines.append('          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>')
    lines.append('          Events')
    lines.append('        </div>')
    lines.append('        <h2>Club Events</h2>')

    # Upcoming events
    lines.append('        <h3 class="events-subheading">Upcoming</h3>')
    if upcoming:
        lines.append('        <ul class="event-list">')
        for ev in upcoming:
            lines.extend(format_event_item(ev))
        lines.append('        </ul>')
    else:
        lines.append('        <p class="event-note">No upcoming events scheduled.</p>')

    # Past events (show last 10)
    if past:
        shown = past[:10]
        lines.append('        <h3 class="events-subheading">Past</h3>')
        lines.append('        <ul class="event-list">')
        for ev in shown:
            lines.extend(format_event_item(ev))
        lines.append('        </ul>')
        if len(past) > 10:
            lines.append(
                f'        <p class="event-note">...and {len(past) - 10} more past events</p>'
            )

    lines.append('      </div>')
    return "\n".join(lines)


def build_maintenance_html(maintenance_path: Path, now: datetime) -> str:
    """Build a maintenance card for active and upcoming entries."""
    entries = [
        entry for entry in load_events(maintenance_path)
        if maintenance_end(entry) >= now
    ]
    entries.sort(key=maintenance_start)

    if not entries:
        return ""

    lines = [
        '      <div class="card card-full maintenance-card">',
        '        <div class="card-label">',
        '          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0L3 12v4h4z"/><path d="m16 8 4 4"/><path d="m14 10 4 4"/><path d="M3 20h18"/></svg>',
        '          Station Announcements',
        '        </div>',
        '        <h2>Club Station Maintenance</h2>',
        '        <ul class="maintenance-list">',
    ]

    for entry in entries:
        identifier = escape(str(entry.get("station", entry.get("repeater"))))
        start = format_maintenance_datetime(entry["start-datetime"])
        stop = entry.get("stop-datetime")
        date_display = start
        if stop:
            date_display += f" - {format_maintenance_datetime(stop)}"
        description = entry.get("description")
        detail = escape(description) if description else "Maintenance notice"
        if maintenance_start(entry) <= now <= maintenance_end(entry):
            status = "Active"
        else:
            status = "Scheduled"

        lines.extend([
            '          <li class="maintenance-item">',
            f'            <span class="maintenance-date">{escape(date_display)}</span>',
            '            <span class="maintenance-detail">',
            f'              <span class="maintenance-station">{identifier}</span>',
            f'              <span class="maintenance-status">{status}</span>',
            f'              <span class="maintenance-description">{detail}</span>',
            '            </span>',
            '          </li>',
        ])

    lines.extend([
        '        </ul>',
        '      </div>',
    ])
    return "\n".join(lines)


def inject_events_into_html(html_path: Path, events_html: str) -> None:
    """Replace content between event marker comments in index.html."""
    start_marker = "<!-- EVENTS-START -->"
    end_marker = "<!-- EVENTS-END -->"

    content = html_path.read_text()

    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)

    if start_idx == -1 or end_idx == -1:
        print(f"ERROR: Could not find event markers in {html_path}")
        print(f"  Expected '{start_marker}' and '{end_marker}' in the HTML.")
        sys.exit(1)

    new_content = (
        content[: start_idx + len(start_marker)]
        + "\n"
        + events_html
        + "\n      "
        + content[end_idx:]
    )

    html_path.write_text(new_content)
    print(f"Updated {html_path} with events card.")


def inject_maintenance_into_html(html_path: Path, maintenance_html: str) -> None:
    """Replace content between maintenance marker comments in index.html."""
    start_marker = "<!-- MAINTENANCE-START -->"
    end_marker = "<!-- MAINTENANCE-END -->"
    content = html_path.read_text()
    start_idx = content.find(start_marker)
    end_idx = content.find(end_marker)

    if start_idx == -1 or end_idx == -1:
        print(f"ERROR: Could not find maintenance markers in {html_path}")
        sys.exit(1)

    new_content = (
        content[: start_idx + len(start_marker)]
        + ("\n" + maintenance_html + "\n      " if maintenance_html else "\n      ")
        + content[end_idx:]
    )
    html_path.write_text(new_content)
    print(f"Updated {html_path} with maintenance card.")


def main():
    repo_root = Path(".")

    upcoming_path = repo_root / "events-upcoming.yml"
    past_path = repo_root / "events-past.yml"
    maintenance_path = repo_root / "events-maintenance.yml"
    html_path = repo_root / "index.html"

    today = date.today()
    print(f"Processing events as of {today}")

    # Step 1: Move past events
    move_past_events(upcoming_path, past_path, today)

    # Step 2: Build and inject HTML
    events_html = build_events_html(upcoming_path, past_path)
    inject_events_into_html(html_path, events_html)

    # Step 3: Build or remove the maintenance card
    maintenance_now = datetime.now(CENTRAL_STANDARD_TIME).replace(tzinfo=None)
    maintenance_html = build_maintenance_html(maintenance_path, maintenance_now)
    inject_maintenance_into_html(html_path, maintenance_html)


if __name__ == "__main__":
    main()
