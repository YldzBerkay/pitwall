# OpenF1 API Reference

> [OpenF1](https://openf1.org) is an open-source API providing Formula 1 telemetry, timing, and session data in JSON and CSV formats.
>
> **Historical data** (from 2023 onwards) is free and accessible without authentication.  
> **Real-time data** requires a paid subscription (MQTT streaming ~€9.90/month).
>
> OpenF1 is unofficial and not associated with Formula 1 companies.

**Base URL:** `https://api.openf1.org/v1`

---

## Pit Wall Usage

| Endpoint | Pit Wall use case | Cost |
|----------|-------------------|------|
| `sessions` | Calendar, session times, countdown | Free |
| `meetings` | Grand Prix weekends | Free |
| `drivers` | Driver list, numbers, teams | Free |
| `pit` | Pit stop lap & duration (scoring) | Free (historical) |
| `stints` | Tyre compound + lap range | Free (historical) |
| `position` | Live positions (REST polling) | Free |
| `session_result` | Official results after session | Free |
| `starting_grid` | Race grid | Free |
| `laps` | Lap times, sectors | Free |
| `weather` | Weather context for predictions | Free |
| `race_control` | Safety car, flags | Free |
| MQTT streaming | Real-time WebSocket feed | Paid (V3) |

**Live window:** A session is considered "live" from 30 minutes before start until 30 minutes after end. Outside this window, historical data is free.

---

## Data Filtering

Refine queries by including parameters in the URL. Results can be filtered by any attribute **except arrays**.

**Comparison operators:** `>=`, `<=`, `>`, `<`, `=` (implicit)

```
# Pit-out laps ≥ 2 minutes for driver 55
GET /v1/laps?session_key=9222&driver_number=55&is_pit_out_lap=true&lap_duration>=120
```

### Time-Based Filtering

```
# Sessions in September 2023
GET /v1/sessions?date_start>=2023-09-01&date_end<=2023-09-30
```

Supported date formats include ISO 8601, `09/10/2021`, `Sep 10, 2021`, and others compatible with Python's `dateutil.parser.parse`.

### CSV Format

Append `csv=true` to receive CSV instead of JSON:

```
GET /v1/sessions?year=2025&csv=true
```

### Special Keys

- `meeting_key=latest` — latest or current meeting
- `session_key=latest` — latest or current session

---

## Endpoints

### Car Data

Telemetry per car (~3.7 Hz sample rate).

```
GET /v1/car_data?driver_number=55&session_key=9159&speed>=315
```

| Field | Type | Description |
|-------|------|-------------|
| `brake` | int | `100` = pressed, `0` = not |
| `date` | string | UTC ISO 8601 |
| `driver_number` | int | Season driver number |
| `drs` | int | DRS status (see table below) |
| `meeting_key` | int | Meeting identifier |
| `n_gear` | int | Gear 1–8; `0` = neutral |
| `rpm` | int | Engine RPM |
| `session_key` | int | Session identifier |
| `speed` | int | km/h |
| `throttle` | int | % of max power |

**DRS value mapping (FastF1):**

| Value | Meaning |
|-------|---------|
| 0, 1 | DRS off |
| 8 | Detected, eligible in activation zone |
| 10, 12, 14 | DRS on |

---

### Championship Drivers (beta)

Driver standings. **Race sessions only.**

```
GET /v1/championship_drivers?session_key=9839&driver_number=4&driver_number=81
```

| Field | Description |
|-------|-------------|
| `driver_number` | Driver number |
| `meeting_key` | Meeting identifier |
| `points_current` | Points during/after race |
| `points_start` | Points before race |
| `position_current` | Position during/after race |
| `position_start` | Position before race |
| `session_key` | Session identifier |

---

### Championship Teams (beta)

Constructor standings. **Race sessions only.**

```
GET /v1/championship_teams?session_key=9839&team_name=McLaren
```

| Field | Description |
|-------|-------------|
| `meeting_key` | Meeting identifier |
| `points_current` | Points during/after race |
| `points_start` | Points before race |
| `position_current` | Position during/after race |
| `position_start` | Position before race |
| `session_key` | Session identifier |
| `team_name` | Team name |

---

### Drivers

Drivers participating in a session.

```
GET /v1/drivers?driver_number=1&session_key=9158
```

| Field | Description |
|-------|-------------|
| `broadcast_name` | TV display name |
| `driver_number` | Season driver number |
| `first_name` | First name |
| `full_name` | Full name |
| `headshot_url` | Photo URL |
| `last_name` | Last name |
| `meeting_key` | Meeting identifier |
| `name_acronym` | Three-letter acronym |
| `session_key` | Session identifier |
| `team_colour` | Hex colour (RRGGBB) |
| `team_name` | Team name |
| `country_code` | ⚠️ Deprecated — removed end of 2026 |

---

### Intervals

Gap to car ahead and leader. **Races only**, ~4s updates.

```
GET /v1/intervals?session_key=9165&interval>0&interval<0.005
```

| Field | Description |
|-------|-------------|
| `date` | UTC ISO 8601 |
| `driver_number` | Driver number |
| `gap_to_leader` | Seconds to leader, `+1 LAP` if lapped, `null` for leader |
| `interval` | Seconds to car ahead, `+1 LAP` if lapped, `null` for leader |
| `meeting_key` | Meeting identifier |
| `session_key` | Session identifier |

---

### Laps

Individual lap data.

```
GET /v1/laps?session_key=9161&driver_number=63&lap_number=8
```

| Field | Description |
|-------|-------------|
| `date_start` | Approximate lap start (UTC) |
| `driver_number` | Driver number |
| `duration_sector_1` | Sector 1 time (s) |
| `duration_sector_2` | Sector 2 time (s) |
| `duration_sector_3` | Sector 3 time (s) |
| `i1_speed` | Speed at intermediate 1 (km/h) |
| `i2_speed` | Speed at intermediate 2 (km/h) |
| `is_pit_out_lap` | Out lap from pits |
| `lap_duration` | Total lap time (s) |
| `lap_number` | Lap number (starts at 1) |
| `meeting_key` | Meeting identifier |
| `segments_sector_1` | Mini-sector values (sector 1) |
| `segments_sector_2` | Mini-sector values (sector 2) |
| `segments_sector_3` | Mini-sector values (sector 3) |
| `session_key` | Session identifier |
| `st_speed` | Speed trap speed (km/h) |

**Segment colour mapping:**

| Value | Colour |
|-------|--------|
| 0 | Not available |
| 2048 | Yellow |
| 2049 | Green |
| 2051 | Purple |
| 2064 | Pit lane |

> Segments are not available during races. Values may not match TV colours.

---

### Location

Approximate car position on track (~3.7 Hz). No lateral placement info.

```
GET /v1/location?session_key=9161&driver_number=81&date>2023-09-16T13:03:35.200&date<2023-09-16T13:03:35.800
```

| Field | Description |
|-------|-------------|
| `date` | UTC ISO 8601 |
| `driver_number` | Driver number |
| `meeting_key` | Meeting identifier |
| `session_key` | Session identifier |
| `x`, `y`, `z` | 3D coordinates (arbitrary origin) |

---

### Meetings

Grand Prix or testing weekends. Updated daily at midnight UTC.

```
GET /v1/meetings?year=2026&country_name=Singapore
```

| Field | Description |
|-------|-------------|
| `circuit_key` | Circuit identifier |
| `circuit_info_url` | MultiViewer circuit JSON URL |
| `circuit_image` | Circuit image URL |
| `circuit_short_name` | Short circuit name |
| `circuit_type` | `Permanent`, `Temporary - Street`, `Temporary - Road` |
| `country_code` | Country code |
| `country_flag` | Flag image URL |
| `country_key` | Country identifier |
| `country_name` | Country name |
| `date_end` | End time (UTC) |
| `date_start` | Start time (UTC) |
| `gmt_offset` | Local offset from GMT |
| `is_cancelled` | Cancelled flag |
| `location` | City / location |
| `meeting_key` | Meeting identifier |
| `meeting_name` | Meeting name |
| `meeting_official_name` | Official name |
| `year` | Season year |

---

### Overtakes

Position exchanges (on-track, pits, penalties). **Races only**, may be incomplete.

```
GET /v1/overtakes?session_key=9636&overtaking_driver_number=63&overtaken_driver_number=4&position=1
```

| Field | Description |
|-------|-------------|
| `date` | UTC ISO 8601 |
| `meeting_key` | Meeting identifier |
| `overtaken_driver_number` | Overtaken driver |
| `overtaking_driver_number` | Overtaking driver |
| `position` | Position after overtake |
| `session_key` | Session identifier |

---

### Pit

Pit lane entries.

```
GET /v1/pit?session_key=9877&stop_duration<2.3
```

| Field | Description |
|-------|-------------|
| `date` | UTC ISO 8601 |
| `driver_number` | Driver number |
| `lane_duration` | Time in pit lane (s) |
| `lap_number` | Lap number |
| `meeting_key` | Meeting identifier |
| `pit_duration` | ⚠️ Deprecated — same as `lane_duration` |
| `session_key` | Session identifier |
| `stop_duration` | Stationary stop time (s); from 2024 US GP onwards |

---

### Position

Driver positions throughout a session.

```
GET /v1/position?meeting_key=1217&driver_number=40&position<=3
```

| Field | Description |
|-------|-------------|
| `date` | UTC ISO 8601 |
| `driver_number` | Driver number |
| `meeting_key` | Meeting identifier |
| `position` | Position (starts at 1) |
| `session_key` | Session identifier |

---

### Race Control

Session status, incidents, flags, safety car.

```
GET /v1/race_control?flag=BLACK AND WHITE&driver_number=1&date>=2023-01-01&date<2023-09-01
```

| Field | Description |
|-------|-------------|
| `category` | `SessionStatus`, `CarEvent`, `Drs`, `Flag`, `SafetyCar`, … |
| `date` | UTC ISO 8601 |
| `driver_number` | Driver number (if applicable) |
| `flag` | `GREEN`, `YELLOW`, `DOUBLE YELLOW`, `CHEQUERED`, … |
| `lap_number` | Lap number (races) |
| `meeting_key` | Meeting identifier |
| `message` | Event description |
| `qualifying_phase` | Q1/Q2/Q3 phase |
| `scope` | `Track`, `Driver`, `Sector`, … |
| `sector` | Mini-sector number |
| `session_key` | Session identifier |

---

### Sessions

Practice, qualifying, sprint, race, etc. Updated daily at midnight UTC.

```
GET /v1/sessions?country_name=Belgium&session_name=Sprint%20Qualifying&year=2023
```

| Field | Description |
|-------|-------------|
| `circuit_key` | Circuit identifier |
| `circuit_short_name` | Short circuit name |
| `country_code` | Country code |
| `country_key` | Country identifier |
| `country_name` | Country name |
| `date_end` | End time (UTC) |
| `date_start` | Start time (UTC) |
| `gmt_offset` | Local offset from GMT |
| `is_cancelled` | Cancelled flag |
| `location` | City / location |
| `meeting_key` | Meeting identifier |
| `session_key` | Session identifier |
| `session_name` | e.g. `Practice 1`, `Qualifying`, `Race` |
| `session_type` | `Practice`, `Qualifying`, `Race`, … |
| `year` | Season year |

---

### Session Result

Standings after a session (available a few minutes after official F1 results).

```
GET /v1/session_result?session_key=7782&position<=3
```

| Field | Description |
|-------|-------------|
| `dnf` | Did Not Finish |
| `dns` | Did Not Start |
| `dsq` | Disqualified |
| `driver_number` | Driver number |
| `duration` | Best lap (practice/quali) or total race time (s). Quali: array of Q1/Q2/Q3 |
| `gap_to_leader` | Gap to leader or `+N LAP(S)`. Quali: array of Q1/Q2/Q3 |
| `number_of_laps` | Laps completed |
| `meeting_key` | Meeting identifier |
| `position` | Final position |
| `session_key` | Session identifier |

---

### Starting Grid

Race starting grid (available after official qualifying results).

```
GET /v1/starting_grid?session_key=7783&position<=3
```

| Field | Description |
|-------|-------------|
| `position` | Grid position |
| `driver_number` | Driver number |
| `lap_duration` | Qualifying lap time (s) |
| `meeting_key` | Meeting identifier |
| `session_key` | Session identifier |

---

### Stints

Continuous driving periods with tyre compound.

```
GET /v1/stints?session_key=9165&tyre_age_at_start>=3
```

| Field | Description |
|-------|-------------|
| `compound` | `SOFT`, `MEDIUM`, `HARD`, … |
| `driver_number` | Driver number |
| `lap_end` | Last lap of stint |
| `lap_start` | First lap of stint |
| `meeting_key` | Meeting identifier |
| `session_key` | Session identifier |
| `stint_number` | Stint sequence (starts at 1) |
| `tyre_age_at_start` | Tyre age in laps at stint start |

---

### Team Radio

Selected driver–team radio clips. **Coverage decreased significantly from 2026.**

```
GET /v1/team_radio?session_key=9158&driver_number=11
```

| Field | Description |
|-------|-------------|
| `date` | UTC ISO 8601 |
| `driver_number` | Driver number |
| `meeting_key` | Meeting identifier |
| `recording_url` | MP3 URL |
| `session_key` | Session identifier |

---

### Weather

Track weather, updated every minute.

```
GET /v1/weather?meeting_key=1208&wind_direction>=130&track_temperature>=52
```

| Field | Description |
|-------|-------------|
| `air_temperature` | °C |
| `date` | UTC ISO 8601 |
| `humidity` | % |
| `meeting_key` | Meeting identifier |
| `pressure` | mbar |
| `rainfall` | Rainfall indicator |
| `session_key` | Session identifier |
| `track_temperature` | °C |
| `wind_direction` | 0°–359° |
| `wind_speed` | m/s |

---

## Jolpica F1 API (Supplementary)

Pit Wall also uses [Jolpica](https://api.jolpi.ca) (Ergast successor) for historical data from 1950 onwards — driver/constructor bios, past season results, comparative stats. Free, no authentication.

---

## Resources

- [OpenF1 GitHub](https://github.com/br-g/openf1)
- [GitHub Discussions](https://github.com/br-g/openf1/discussions)
- [Streaming live data tutorial](https://openf1.org)
