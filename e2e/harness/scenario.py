"""Scenario bookkeeping: every check is recorded (PASS/FAIL with detail) so the report shows exactly
what was proven across which system boundary; a finding is a defect observed on the way that is not
what the scenario asserts (reported, never silently ignored)."""

from __future__ import annotations

import time
import traceback
from dataclasses import dataclass, field


class NotRun(Exception):
    """The scenario could not be exercised (a service it needs did not boot) — reported with the reason."""


class CheckFailed(AssertionError):
    pass


@dataclass
class Ctx:
    sid: str
    title: str
    steps: list[tuple[str, str, str]] = field(default_factory=list)   # (status, what, detail)
    findings: list[str] = field(default_factory=list)
    result: str = "NOT RUN"
    reason: str = ""
    seconds: float = 0.0

    def step(self, what: str, detail: str = "") -> None:
        self.steps.append(("INFO", what, detail))

    def check(self, cond, what: str, detail: str = "") -> None:
        if cond:
            self.steps.append(("PASS", what, detail))
            return
        self.steps.append(("FAIL", what, detail))
        raise CheckFailed(f"{what}" + (f" — {detail}" if detail else ""))

    def soft(self, cond, what: str, detail: str = "") -> bool:
        """A check that is recorded but does not stop the scenario (FAIL still fails the scenario)."""
        self.steps.append(("PASS" if cond else "FAIL", what, detail))
        return bool(cond)

    def finding(self, text: str) -> None:
        self.findings.append(text)


def execute(ctx: Ctx, fn) -> Ctx:
    t0 = time.time()
    try:
        fn(ctx)
        ctx.result = "FAIL" if any(s[0] == "FAIL" for s in ctx.steps) else "PASS"
    except NotRun as e:
        ctx.result, ctx.reason = "NOT RUN", str(e)
    except CheckFailed as e:
        ctx.result, ctx.reason = "FAIL", str(e)
    except Exception as e:  # an unexpected error is a failure, with the trace in the report
        ctx.result = "FAIL"
        ctx.reason = f"{type(e).__name__}: {e}"
        ctx.steps.append(("FAIL", "unexpected error", traceback.format_exc()[-1500:]))
    ctx.seconds = time.time() - t0
    return ctx
