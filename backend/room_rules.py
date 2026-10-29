"""Canadian registered-account limits, for estimating room from your own accounts.

CRA My Account is the authority (it knows withdrawals, over-contributions and exact dates); these
estimates are for when you'd rather not look it up. Update TFSA_LIMITS each November when the
next year's limit is announced.
"""

# Annual TFSA dollar limits (CRA)
TFSA_LIMITS = {
    2009: 5000, 2010: 5000, 2011: 5000, 2012: 5000, 2013: 5500, 2014: 5500, 2015: 10000, 2016: 5500,
    2017: 5500, 2018: 5500, 2019: 6000, 2020: 6000, 2021: 6000, 2022: 6000, 2023: 6500, 2024: 7000,
    2025: 7000, 2026: 7000,
}
FHSA_ANNUAL = 8000
FHSA_CARRY_MAX = 8000
FHSA_LIFETIME = 40000


def tfsa_limit(year: int) -> tuple[int, bool]:
    """(limit, known). Years after the table reuse the latest known limit."""
    if year in TFSA_LIMITS:
        return TFSA_LIMITS[year], True
    return TFSA_LIMITS[max(TFSA_LIMITS)], False


def tfsa_cumulative(since_year: int, year: int) -> tuple[int, list[str]]:
    """Total TFSA room accumulated from `since_year` (turned 18 and resident, 2009 at the earliest)
    through `year`, assuming no withdrawals."""
    notes = []
    start = max(since_year, 2009)
    total = 0
    for y in range(start, year + 1):
        limit, known = tfsa_limit(y)
        total += limit
        if not known:
            notes.append(f"{y} limit assumed ${limit:,}")
    return total, notes


def fhsa_room(opened_year: int, year: int, contributed_total: float) -> tuple[float, float, list[str]]:
    """(room available this year, total limit so far, notes) for an FHSA opened in `opened_year`.

    Each year adds $8,000; unused room carries forward but at most $8,000; lifetime cap $40,000.
    Without year-by-year contributions we assume they were spread evenly, which is the usual case
    for the carry-forward limit to bite only when little was contributed.
    """
    years = max(0, year - opened_year + 1)
    total_limit = min(FHSA_LIFETIME, FHSA_ANNUAL * years)
    left_lifetime = max(0.0, FHSA_LIFETIME - contributed_total)
    # at most this year's $8,000 plus $8,000 carried forward
    available = min(total_limit - contributed_total, FHSA_ANNUAL + FHSA_CARRY_MAX, left_lifetime)
    notes = [] if years <= 2 else ["assumes contributions spread over the years (carry-forward is capped at $8,000)"]
    return round(available, 2), float(total_limit), notes
