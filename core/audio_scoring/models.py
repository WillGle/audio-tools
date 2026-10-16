"""Public evidence schema. A score is an evidence index, never a probability."""
from typing import Any, Literal
from pydantic import BaseModel, Field

Status = Literal['PASS', 'REVIEW', 'SUSPECT', 'FAIL', 'INCONCLUSIVE', 'NOT_APPLICABLE']
Confidence = Literal['HIGH', 'MEDIUM', 'LOW']


class Expectations(BaseModel):
    model_config = {'extra': 'forbid'}
    codec: str | None = Field(None, max_length=64)
    container: str | None = Field(None, max_length=64)
    sample_rate: int | None = Field(None, gt=0, le=10000000)
    bit_depth: int | None = Field(None, gt=0, le=64)
    lossless: bool | None = None
    source_label: str | None = Field(None, max_length=1000)
    release: str | None = Field(None, max_length=1000)


class Evidence(BaseModel):
    code: str
    family: str
    detail: str


class RuleResult(BaseModel):
    status: Status = 'INCONCLUSIVE'
    score_contribution: float | None = None
    confidence: Confidence = 'LOW'
    measurements: dict[str, Any] = Field(default_factory=dict)
    evidence: list[Evidence] = Field(default_factory=list)
    penalty_applied: float = 0
    explanation: str
    detector: str
    detector_version: str
    limitations: list[str] = Field(default_factory=list)


def rule(explanation, detector='audio-tools', version='1.0.0', **kwargs):
    return RuleResult(explanation=explanation, detector=detector,
                      detector_version=version, **kwargs).model_dump()
