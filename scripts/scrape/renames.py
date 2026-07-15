"""ESPN <-> nflverse name reconciliation.

THE SYNC INVARIANT (inherited from wc2026's hard-won lesson):
ESPN and nflverse disagree on team abbreviations and on player-name spelling/suffixes.
If the normalization map drifts between the data layers, scores silently attach to the
wrong team/player and everything downstream is quietly wrong. So this map is the SINGLE
Python source of truth and a byte-equivalent copy MUST be mirrored in the JS layer.

    ***  MIRROR THIS FILE IN JS  ***
    A `RENAMES` object identical to the one below must live in `app/live-scores.js`
    (and, once it exists, the Vercel edge function). When you change a mapping here,
    change it there in the same commit. A test should diff the two — keep them in sync.

Pure stdlib. No I/O, no network. Safe to import anywhere (the gate included).

Canonical team key = nflverse abbreviation (32 teams). Canonical player key is the
nflverse `gsis_id`; this module only reconciles the *display name* so a name-keyed
ESPN feed can be matched to a gsis_id-keyed nflverse roster before the id is known.
"""

# The 32 canonical nflverse team abbreviations. Anything `normalize_team` returns must
# be one of these (or None if unmappable — callers must handle None loudly).
CANONICAL_TEAMS = frozenset(
    [
        "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
        "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
        "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG",
        "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WAS",
    ]
)

# ---------------------------------------------------------------------------
# TEAM RENAMES.  key = a name/abbrev as it may appear in an ESPN (or legacy) feed,
# value = the canonical nflverse abbreviation. Keys are matched case-insensitively
# after whitespace-trim (see normalize_team), so store them lower-cased and trimmed.
#
# Three kinds of entries:
#   1. ESPN abbreviation differences (the important, frequently-hit ones).
#   2. Full "City Nickname" strings ESPN uses in some payloads.
#   3. Legacy relocations that still show up in historical ESPN JSON.
# ---------------------------------------------------------------------------
RENAMES = {
    # --- ESPN abbreviation differences (the ones that actually differ) ---------
    "wsh": "WAS",   # ESPN uses WSH for Washington; nflverse uses WAS.
    # (Most other ESPN abbrevs already equal nflverse: KC, SF, GB, NE, NO, TB, LV,
    #  LAC, LAR, JAX, NYG, NYJ, ... they still resolve via the identity path below.)

    # --- Legacy relocations sometimes present in historical ESPN payloads ------
    "oak": "LV",    # Oakland Raiders  -> Las Vegas
    "sd":  "LAC",   # San Diego Chargers -> Los Angeles Chargers
    "stl": "LAR",   # St. Louis Rams   -> Los Angeles Rams
    "la":  "LAR",   # ambiguous "LA" in some feeds resolves to the Rams by convention

    # --- Full "City Nickname" strings (ESPN scoreboard `displayName`) ----------
    "arizona cardinals": "ARI",
    "atlanta falcons": "ATL",
    "baltimore ravens": "BAL",
    "buffalo bills": "BUF",
    "carolina panthers": "CAR",
    "chicago bears": "CHI",
    "cincinnati bengals": "CIN",
    "cleveland browns": "CLE",
    "dallas cowboys": "DAL",
    "denver broncos": "DEN",
    "detroit lions": "DET",
    "green bay packers": "GB",
    "houston texans": "HOU",
    "indianapolis colts": "IND",
    "jacksonville jaguars": "JAX",
    "kansas city chiefs": "KC",
    "las vegas raiders": "LV",
    "los angeles chargers": "LAC",
    "los angeles rams": "LAR",
    "miami dolphins": "MIA",
    "minnesota vikings": "MIN",
    "new england patriots": "NE",
    "new orleans saints": "NO",
    "new york giants": "NYG",
    "new york jets": "NYJ",
    "philadelphia eagles": "PHI",
    "pittsburgh steelers": "PIT",
    "san francisco 49ers": "SF",
    "seattle seahawks": "SEA",
    "tampa bay buccaneers": "TB",
    "tennessee titans": "TEN",
    "washington commanders": "WAS",
}

# ---------------------------------------------------------------------------
# PLAYER RENAMES.  key = ESPN display spelling (lower-cased/trimmed),
# value = canonical nflverse display spelling. Small on purpose — only add an entry
# when a real mismatch is observed. Suffix stripping (Jr./Sr./II/III/IV) and
# punctuation normalization is handled algorithmically by canonical_player_name();
# this map is for spellings that differ in ways an algorithm can't guess.
# ---------------------------------------------------------------------------
PLAYER_RENAMES = {
    "hollywood brown": "Marquise Brown",   # ESPN nickname vs nflverse legal name
    "gabe davis": "Gabriel Davis",
    "cam newton": "Cameron Newton",
    "josh palmer": "Joshua Palmer",
    "chig okonkwo": "Chigoziem Okonkwo",
    "d.k. metcalf": "DK Metcalf",           # nflverse dropped the dots
    "d.j. moore": "DJ Moore",
    "mike thomas": "Michael Thomas",
}

# Suffix tokens stripped (case-insensitively) when algorithmically canonicalizing a
# player name. nflverse is inconsistent about these; dropping them makes name-match
# a fallback that rarely mis-joins. Order longest-first so "iii" is tried before "ii".
_NAME_SUFFIXES = ("iv", "iii", "ii", "jr", "sr", "jr.", "sr.")


def normalize_team(name):
    """Map any team spelling/abbrev from a feed to its canonical nflverse abbrev.

    Accepts: a canonical abbrev ("KC"), an ESPN abbrev ("WSH"), a full
    "City Nickname" string, or a legacy abbrev ("OAK"). Returns the canonical
    abbreviation, or ``None`` if it cannot be mapped — callers MUST treat None as a
    loud error (an unmapped team means a scrape drifted), never as a silent skip.

    >>> normalize_team("WSH")
    'WAS'
    >>> normalize_team(" Kansas City Chiefs ")
    'KC'
    >>> normalize_team("kc")
    'KC'
    >>> normalize_team("Nott A Team") is None
    True
    """
    if name is None:
        return None
    key = str(name).strip()
    if not key:
        return None

    # 1. Already canonical? (fast path; ESPN shares most abbrevs with nflverse.)
    upper = key.upper()
    if upper in CANONICAL_TEAMS:
        return upper

    # 2. Explicit rename (abbrev diffs, legacy relocations, full names).
    lower = key.lower()
    mapped = RENAMES.get(lower)
    if mapped is not None:
        return mapped

    # 3. Unmappable — return None so the caller fails loudly.
    return None


def canonical_player_name(name):
    """Best-effort canonicalization of a player *display* name for name-based joins.

    Precedence:
      1. Explicit PLAYER_RENAMES entry (handles nicknames/legal-name swaps).
      2. Algorithmic: trim, collapse internal whitespace, strip a trailing
         Jr./Sr./II/III/IV suffix. Casing is otherwise left as-is because nflverse
         preserves it.

    This is a *fallback* matcher only. The authoritative key is always gsis_id; use
    this to bridge a name-keyed feed to a gsis_id when the id is not carried.

    >>> canonical_player_name("Hollywood Brown")
    'Marquise Brown'
    >>> canonical_player_name("Michael Pittman Jr.")
    'Michael Pittman'
    >>> canonical_player_name("  Patrick   Mahomes ")
    'Patrick Mahomes'
    """
    if name is None:
        return None
    cleaned = " ".join(str(name).split())  # trim + collapse internal whitespace
    if not cleaned:
        return None

    # 1. Explicit map wins.
    mapped = PLAYER_RENAMES.get(cleaned.lower())
    if mapped is not None:
        return mapped

    # 2. Strip one trailing generational suffix if present.
    tokens = cleaned.split(" ")
    if len(tokens) > 1 and tokens[-1].lower().rstrip(".") in ("iv", "iii", "ii", "jr", "sr"):
        tokens = tokens[:-1]
    return " ".join(tokens)
