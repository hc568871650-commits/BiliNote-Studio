from dataclasses import dataclass
from typing import List, Union, Optional

from app.models.transcriber_model import TranscriptSegment


@dataclass
class GPTSource:
    segment: Union[List[TranscriptSegment], List]
    title: str
    tags:str
    screenshot: Optional[bool] = False
    link: Optional[bool] = False
    style: Optional[str] = None
    extras: Optional[str] = None
    _format: Optional[list] = None
    video_img_urls:  Optional[list] = None
    checkpoint_key: Optional[str] = None
    frame_evidence: Optional[list[dict]] = None
    # None 表示不要求按视频时间范围对齐（按分块预算顺序分配静态配图）；
    # list 表示明确启用时间对齐路径（每张输入图恰好对应一个时间范围）；
    # 空列表 [] 仅与零张模型输入图（video_img_urls == []）相容。
    video_image_ranges: Optional[list[dict]] = None
    structured: bool = False
    output_language: Optional[str] = "zh-CN"
    post_context: Optional[str] = None

