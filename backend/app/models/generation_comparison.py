from typing import Optional
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.models.generation_options import GenerationOptions


class ComparisonVariant(BaseModel):
    model_config = ConfigDict(extra='forbid')
    provider_id: str = Field(min_length=1, max_length=100)
    model_name: str = Field(min_length=1, max_length=200)
    options: GenerationOptions = Field(default_factory=GenerationOptions)


class ComparisonRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    task_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    version_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    request_id: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    variants: list[ComparisonVariant] = Field(min_length=2, max_length=2)
    use_images: bool = False
    start_time: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    end_time: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)

    @model_validator(mode='after')
    def comparable(self):
        left, right = self.variants
        for field in ('chunk_seconds', 'chunk_text_chars'):
            if getattr(left.options, field) != getattr(right.options, field):
                raise ValueError('对比方案必须使用相同的分片设置')
        if self.end_time is not None and self.end_time <= (self.start_time or 0):
            raise ValueError('结束时间必须大于开始时间')
        return self
