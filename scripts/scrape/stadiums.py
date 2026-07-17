"""STATIC curated stadium table — all 32 teams. No I/O, no network, gate-safe.

This is the environment model's ground truth for surface / roof / location. It is
curated by hand (not scraped) because stadium facts change on renovation timescales,
not news timescales, and every scraped source disagrees on naming.

SOURCES (checked July 2026):
  - Surface + roof: each stadium's Wikipedia article ("Surface", "Roof") cross-checked
    against the NFL's 2025 stadium list. Mid-window surface changes are noted inline
    (the splits in build_environment.py attribute by the CURRENT surface — honest
    limitation recorded in environment_model.json notes).
  - lat/lon: stadium Wikipedia geohack coordinates, 4 dp (~10 m) — plenty for an
    Open-Meteo grid cell.
  - altitude_ft: recorded only where competitively notable. Denver is the lone
    mile-high outlier (5,280 ft); every other NFL venue sits below ~1,100 ft.
  - cold_region: hand-flagged TRUE for OUTDOOR venues in northern/continental climates
    that historically host sub-freezing (< 32 F) December/January kickoffs. Marine-mild
    Seattle and the mid-south (Nashville, Charlotte) are FALSE on purpose: freezing
    kickoffs there are rare enough that the flag would overstate exposure.

ROOF SEMANTICS (three states, refining ESPN's binary `indoor` flag):
  dome        - fixed roof, weather never a factor (SoFi's fixed canopy counts: open
                sides, but the field never sees precipitation or wind).
  retractable - roof MAY be closed; game-day state is not knowable from a static
                table, so the weather backfill SKIPS these venues (honest, not clever).
  open        - always exposed; eligible for the historical weather join.

`city` matches ESPN's scoreboard venue address.city verbatim — build_environment.py
uses equality on it to confirm a "home" game was actually played at the home stadium
(catches relocations like BUF/CLE 2022 moved to Ford Field, and neutral sites).

Shared venues (NYG/NYJ MetLife, LAC/LAR SoFi) repeat identical coordinates; the
weather fetch dedupes on (lat, lon) so a shared building costs one archive call.
"""

from .renames import CANONICAL_TEAMS

# Per-team stadium facts, keyed by canonical nflverse abbreviation.
# Fields: venue, city, surface ("grass"|"turf"), roof ("dome"|"open"|"retractable"),
# lat, lon, cold_region (bool), altitude_ft (only where notable — DEN).
STADIUMS = {
    "ARI": {  # State Farm Stadium — natural grass on a roll-out tray, retractable roof.
        "venue": "State Farm Stadium", "city": "Glendale",
        "surface": "grass", "roof": "retractable",
        "lat": 33.5276, "lon": -112.2626, "cold_region": False,
    },
    "ATL": {  # Mercedes-Benz Stadium — FieldTurf CORE, retractable "pinwheel" roof.
        "venue": "Mercedes-Benz Stadium", "city": "Atlanta",
        "surface": "turf", "roof": "retractable",
        "lat": 33.7554, "lon": -84.4008, "cold_region": False,
    },
    "BAL": {  # M&T Bank Stadium — natural grass, open air, Mid-Atlantic winters.
        "venue": "M&T Bank Stadium", "city": "Baltimore",
        "surface": "grass", "roof": "open",
        "lat": 39.2780, "lon": -76.6227, "cold_region": True,
    },
    "BUF": {  # Highmark Stadium — A-Turf Titan, open air, lake-effect Orchard Park.
        "venue": "Highmark Stadium", "city": "Orchard Park",
        "surface": "turf", "roof": "open",
        "lat": 42.7738, "lon": -78.7870, "cold_region": True,
    },
    "CAR": {  # Bank of America Stadium — converted grass -> FieldTurf in May 2021,
        # so the whole 2021-2025 window is turf. Open air, mild Charlotte winters.
        "venue": "Bank of America Stadium", "city": "Charlotte",
        "surface": "turf", "roof": "open",
        "lat": 35.2258, "lon": -80.8528, "cold_region": False,
    },
    "CHI": {  # Soldier Field — Bermuda/bluegrass, open air, lakefront Chicago cold.
        "venue": "Soldier Field", "city": "Chicago",
        "surface": "grass", "roof": "open",
        "lat": 41.8623, "lon": -87.6167, "cold_region": True,
    },
    "CIN": {  # Paycor Stadium — UBU Speed Series synthetic, open air, Ohio Valley cold.
        "venue": "Paycor Stadium", "city": "Cincinnati",
        "surface": "turf", "roof": "open",
        "lat": 39.0955, "lon": -84.5161, "cold_region": True,
    },
    "CLE": {  # Huntington Bank Field — Kentucky bluegrass, open air, lake-effect cold.
        "venue": "Huntington Bank Field", "city": "Cleveland",
        "surface": "grass", "roof": "open",
        "lat": 41.5061, "lon": -81.6995, "cold_region": True,
    },
    "DAL": {  # AT&T Stadium — Hellas Matrix Turf, retractable roof.
        "venue": "AT&T Stadium", "city": "Arlington",
        "surface": "turf", "roof": "retractable",
        "lat": 32.7473, "lon": -97.0945, "cold_region": False,
    },
    "DEN": {  # Empower Field at Mile High — Kentucky bluegrass, open air, the lone
        # altitude outlier in the league (exactly one mile above sea level).
        "venue": "Empower Field at Mile High", "city": "Denver",
        "surface": "grass", "roof": "open",
        "lat": 39.7439, "lon": -105.0201, "cold_region": True, "altitude_ft": 5280,
    },
    "DET": {  # Ford Field — FieldTurf, fixed dome.
        "venue": "Ford Field", "city": "Detroit",
        "surface": "turf", "roof": "dome",
        "lat": 42.3400, "lon": -83.0456, "cold_region": False,
    },
    "GB": {  # Lambeau Field — hybrid Desso GrassMaster (counts grass), open air,
        # the canonical frozen-tundra venue.
        "venue": "Lambeau Field", "city": "Green Bay",
        "surface": "grass", "roof": "open",
        "lat": 44.5013, "lon": -88.0622, "cold_region": True,
    },
    "HOU": {  # NRG Stadium — synthetic turf (since 2015), retractable roof.
        "venue": "NRG Stadium", "city": "Houston",
        "surface": "turf", "roof": "retractable",
        "lat": 29.6847, "lon": -95.4107, "cold_region": False,
    },
    "IND": {  # Lucas Oil Stadium — shaw sports turf, retractable roof.
        "venue": "Lucas Oil Stadium", "city": "Indianapolis",
        "surface": "turf", "roof": "retractable",
        "lat": 39.7601, "lon": -86.1639, "cold_region": False,
    },
    "JAX": {  # EverBank Stadium — Bermuda grass, open air, Florida.
        "venue": "EverBank Stadium", "city": "Jacksonville",
        "surface": "grass", "roof": "open",
        "lat": 30.3240, "lon": -81.6373, "cold_region": False,
    },
    "KC": {  # GEHA Field at Arrowhead — Bermuda grass, open air, Plains winters
        # (the -4 F 2024 playoff game was here; regular-season Dec/Jan routinely <32F).
        "venue": "GEHA Field at Arrowhead Stadium", "city": "Kansas City",
        "surface": "grass", "roof": "open",
        "lat": 39.0489, "lon": -94.4839, "cold_region": True,
    },
    "LV": {  # Allegiant Stadium — natural grass on a roll-in tray under a FIXED dome.
        "venue": "Allegiant Stadium", "city": "Las Vegas",
        "surface": "grass", "roof": "dome",
        "lat": 36.0909, "lon": -115.1833, "cold_region": False,
    },
    "LAC": {  # SoFi Stadium (shared with LAR) — Hellas Matrix Turf; fixed translucent
        # canopy with open sides = weather never reaches the field: classified dome.
        "venue": "SoFi Stadium", "city": "Inglewood",
        "surface": "turf", "roof": "dome",
        "lat": 33.9535, "lon": -118.3392, "cold_region": False,
    },
    "LAR": {  # SoFi Stadium (shared with LAC) — same building, same coordinates.
        "venue": "SoFi Stadium", "city": "Inglewood",
        "surface": "turf", "roof": "dome",
        "lat": 33.9535, "lon": -118.3392, "cold_region": False,
    },
    "MIA": {  # Hard Rock Stadium — Bermuda grass; canopy shades the STANDS only,
        # the field is open air.
        "venue": "Hard Rock Stadium", "city": "Miami Gardens",
        "surface": "grass", "roof": "open",
        "lat": 25.9580, "lon": -80.2389, "cold_region": False,
    },
    "MIN": {  # U.S. Bank Stadium — UBU Speed Series synthetic, fixed dome.
        "venue": "U.S. Bank Stadium", "city": "Minneapolis",
        "surface": "turf", "roof": "dome",
        "lat": 44.9735, "lon": -93.2575, "cold_region": False,
    },
    "NE": {  # Gillette Stadium — FieldTurf, open air, New England winters.
        "venue": "Gillette Stadium", "city": "Foxborough",
        "surface": "turf", "roof": "open",
        "lat": 42.0909, "lon": -71.2643, "cold_region": True,
    },
    "NO": {  # Caesars Superdome — FieldTurf, fixed dome.
        "venue": "Caesars Superdome", "city": "New Orleans",
        "surface": "turf", "roof": "dome",
        "lat": 29.9511, "lon": -90.0812, "cold_region": False,
    },
    "NYG": {  # MetLife Stadium (shared with NYJ) — FieldTurf, open air, NJ winters.
        "venue": "MetLife Stadium", "city": "East Rutherford",
        "surface": "turf", "roof": "open",
        "lat": 40.8135, "lon": -74.0745, "cold_region": True,
    },
    "NYJ": {  # MetLife Stadium (shared with NYG) — same building, same coordinates.
        "venue": "MetLife Stadium", "city": "East Rutherford",
        "surface": "turf", "roof": "open",
        "lat": 40.8135, "lon": -74.0745, "cold_region": True,
    },
    "PHI": {  # Lincoln Financial Field — hybrid Bermuda (counts grass), open air.
        "venue": "Lincoln Financial Field", "city": "Philadelphia",
        "surface": "grass", "roof": "open",
        "lat": 39.9008, "lon": -75.1675, "cold_region": True,
    },
    "PIT": {  # Acrisure Stadium — Kentucky bluegrass, open air, Pittsburgh winters.
        "venue": "Acrisure Stadium", "city": "Pittsburgh",
        "surface": "grass", "roof": "open",
        "lat": 40.4468, "lon": -80.0158, "cold_region": True,
    },
    "SF": {  # Levi's Stadium — Bermuda/rye grass, open air, Bay Area mild.
        "venue": "Levi's Stadium", "city": "Santa Clara",
        "surface": "grass", "roof": "open",
        "lat": 37.4030, "lon": -121.9700, "cold_region": False,
    },
    "SEA": {  # Lumen Field — FieldTurf, open air. Northern latitude but marine-mild:
        # sub-freezing kickoffs are rare in Seattle, so cold_region stays False.
        "venue": "Lumen Field", "city": "Seattle",
        "surface": "turf", "roof": "open",
        "lat": 47.5952, "lon": -122.3316, "cold_region": False,
    },
    "TB": {  # Raymond James Stadium — Bermuda grass, open air, Florida.
        "venue": "Raymond James Stadium", "city": "Tampa",
        "surface": "grass", "roof": "open",
        "lat": 27.9759, "lon": -82.5033, "cold_region": False,
    },
    "TEN": {  # Nissan Stadium — converted Bermuda grass -> Matrix Turf in 2023;
        # 2021-22 home games were on grass (limitation noted downstream). Mid-south
        # Nashville: freezing kickoffs uncommon, cold_region False.
        "venue": "Nissan Stadium", "city": "Nashville",
        "surface": "turf", "roof": "open",
        "lat": 36.1665, "lon": -86.7713, "cold_region": False,
    },
    "WAS": {  # Northwest Stadium (nee FedExField) — Bermuda grass, open air,
        # Mid-Atlantic winters.
        "venue": "Northwest Stadium", "city": "Landover",
        "surface": "grass", "roof": "open",
        "lat": 38.9077, "lon": -76.8645, "cold_region": True,
    },
}

# Sanity locks: exactly the 32 canonical teams, valid enums. Module import fails loudly
# on a curation typo — cheaper than debugging a silently wrong split downstream.
assert set(STADIUMS) == CANONICAL_TEAMS, "STADIUMS must cover exactly the 32 canonical teams"
for _ab, _s in STADIUMS.items():
    assert _s["surface"] in ("grass", "turf"), f"{_ab}: bad surface {_s['surface']!r}"
    assert _s["roof"] in ("dome", "open", "retractable"), f"{_ab}: bad roof {_s['roof']!r}"
    assert _s.get("cold_region") is False or _s["roof"] == "open", \
        f"{_ab}: cold_region only applies to open-air venues"


def outdoor_teams():
    """Sorted abbrevs whose home venue is fully open air (weather-join eligible).
    Retractables are excluded on purpose: the roof state per game is unknowable here."""
    return sorted(ab for ab, s in STADIUMS.items() if s["roof"] == "open")


def dome_teams():
    """Sorted abbrevs whose home venue is a fixed dome (strict — retractables are NOT
    dome teams for the dome-teams-in-cold split; they practice/play exposed at times)."""
    return sorted(ab for ab, s in STADIUMS.items() if s["roof"] == "dome")
