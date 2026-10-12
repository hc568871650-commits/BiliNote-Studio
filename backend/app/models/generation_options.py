"""Validated, explicit local policies for a single note generation run."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class GenerationPrice(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    mode: Literal['tokens', 'per_call'] = 'tokens'
    currency: Literal['USD', 'CNY'] = 'USD'
    input_per_million: float | None = Field(default=None, ge=0)
    output_per_million: float | None = Field(default=None, ge=0)
    cached_input_per_million: float | None = Field(default=None, ge=0)
    per_call: float | None = Field(default=None, ge=0)

    @model_validator(mode='after')
    def require_rates(self):
        if self.mode == 'tokens' and (self.input_per_million is None or self.output_per_million is None):
            raise ValueError('Token pricing requires explicit input and output rates')
        if self.mode == 'per_call' and self.per_call is None:
            raise ValueError('Per-call pricing requires an explicit per_call rate')
        return self


class GenerationOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    reasoning_effort: Literal['auto', 'none', 'low', 'medium', 'high', 'max'] = 'auto'
    temperature: float | None = Field(default=0.7, ge=0, le=2)
    max_output_tokens: int | None = Field(default=None, ge=256, le=65536)
    chunk_seconds: int = Field(default=600, ge=60, le=1800)
    chunk_text_chars: int = Field(default=8000, ge=1000, le=24000)
    max_requests: int = Field(default=64, ge=1, le=200)
    # Total attempts per logical request, including its initial attempt.
    retry_attempts: int = Field(default=1, ge=1, le=3)
    price: GenerationPrice | None = None
