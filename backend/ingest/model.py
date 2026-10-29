"""Parser output shared by every statement parser."""
from dataclasses import asdict, dataclass, field


@dataclass
class ParsedTx:
    date: str            # ISO yyyy-mm-dd
    description: str
    amount: float        # negative = money out of the account holder's pocket (spend / charge)


@dataclass
class ParsedHolding:
    symbol: str
    market_value: float
    units: float | None = None
    book_value: float | None = None


@dataclass
class ParsedStatement:
    institution: str | None = None
    account_type: str | None = None          # chequing | savings | credit | investment | loan
    registration: str | None = None          # TFSA | RRSP | FHSA | NONREG
    last4: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    opening_balance: float | None = None     # credit/loan: amount owed
    closing_balance: float | None = None
    market_value: float | None = None        # investment accounts
    book_value: float | None = None
    credit_limit: float | None = None
    transactions: list[ParsedTx] = field(default_factory=list)
    holdings: list[ParsedHolding] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    parser: str = "generic"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "ParsedStatement":
        d = dict(d)
        d["transactions"] = [ParsedTx(**t) for t in d.get("transactions", [])]
        d["holdings"] = [ParsedHolding(**h) for h in d.get("holdings", [])]
        return cls(**d)

    @property
    def is_liability(self) -> bool:
        return self.account_type in ("credit", "loan")

    def reconciles(self) -> bool | None:
        """Does opening + transactions == closing? None when balances are unknown."""
        if self.opening_balance is None or self.closing_balance is None:
            return None
        total = sum(t.amount for t in self.transactions)
        # for liabilities a charge (negative amount) increases what is owed
        expected = self.opening_balance - total if self.is_liability else self.opening_balance + total
        return abs(expected - self.closing_balance) < 0.015
